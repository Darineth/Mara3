import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import sirv from 'sirv';
import { WebSocketServer } from 'ws';
import { Connection } from './connection.js';
import type { ServerConfig } from './config.js';
import { Hub } from './hub.js';
import type { Logger } from './logger.js';
import { EMOJI_ROUTE, serveEmoji } from './emoji.js';
import {
  AVATAR_ENDPOINT,
  AVATAR_ROUTE,
  EMOJI_UPLOAD_ENDPOINT,
  FILE_ENDPOINT,
  FILE_ROUTE,
  handleAvatarUpload,
  handleEmojiUpload,
  handleFileUpload,
  handleUpload,
  serveAvatar,
  serveFile,
  serveUpload,
  UPLOAD_ENDPOINT,
  UPLOAD_ROUTE,
} from './uploads.js';

/**
 * Hard cap on a single inbound WebSocket frame. The largest legitimate message
 * (a max-length chat plus JSON overhead, or a capped pluginData blob) is well
 * under this; it exists to stop a client from forcing us to buffer ws's 100 MiB
 * default per frame.
 */
const MAX_FRAME_BYTES = 256 * 1024;

/** Local-only endpoint that asks the server to stop cleanly (see {@link ServerConfig.adminToken}). */
export const SHUTDOWN_ENDPOINT = '/admin/shutdown';

/**
 * How long {@link MaraServer.close} lets clients answer the WebSocket close handshake (and
 * in-flight HTTP requests finish) before dropping whatever is left.
 */
const CLOSE_GRACE_MS = 1000;

/** WebSocket close code 1012, "service restart": a planned stop, so clients should reconnect. */
const CLOSE_SERVICE_RESTART = 1012;

/** Whether a socket's remote address is this machine. */
export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
}

/** Constant-time comparison of a presented secret against the configured one. */
function secretMatches(presented: string, expected: string): boolean {
  const digest = (v: string) => createHash('sha256').update(v).digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

/**
 * `POST /admin/shutdown`: stop the server cleanly on request. Windows can't deliver SIGTERM
 * and every outside stop (taskkill, Stop-Process, ending a scheduled task) is a hard kill, so
 * this is the one way to request a stop that runs the flush-and-close path however the server
 * was launched. It's locked down three ways: disabled unless `MARA_ADMIN_TOKEN` is set, only
 * accepted from this machine, and refused if it came through a proxy — a reverse proxy on the
 * same box makes every outside request look local, so a forwarding header disqualifies it.
 */
function handleShutdownRequest(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ServerConfig,
  log: Logger,
  onShutdownRequest: (() => void) | undefined,
): void {
  const reply = (status: number, body: string) => {
    res.writeHead(status, { 'content-type': 'text/plain', connection: 'close' });
    res.end(body);
  };
  // Disabled: answer as if the route doesn't exist.
  if (!cfg.adminToken || !onShutdownRequest) return reply(404, 'Not found');
  if (req.method !== 'POST') return reply(405, 'Method not allowed');
  const proxied =
    req.headers['x-forwarded-for'] !== undefined ||
    req.headers.forwarded !== undefined ||
    req.headers['x-real-ip'] !== undefined;
  if (!isLoopback(req.socket.remoteAddress) || proxied) {
    log.warn({ remote: req.socket.remoteAddress, proxied }, 'refused non-local shutdown request');
    return reply(403, 'Forbidden');
  }
  const auth = req.headers.authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
  if (!secretMatches(token, cfg.adminToken)) {
    log.warn('refused shutdown request with a bad or missing admin token');
    return reply(401, 'Unauthorized');
  }
  res.writeHead(202, { 'content-type': 'text/plain', connection: 'close' });
  // Answer first, then stop, so the caller learns the request was accepted.
  res.end('shutting down\n', onShutdownRequest);
}

/**
 * Content-Security-Policy for the web app's document responses. This is
 * defense-in-depth for the chat-render XSS boundary (an honest server protecting its
 * users from malicious *message* content) — it is **not** a control against a hostile
 * server, which serves its own headers. The load-bearing directive is `script-src
 * 'self'`: the Vite build emits only external, same-origin scripts (no inline/eval), so
 * an escaping bug can't turn injected markup into script execution.
 *
 * Deliberately permissive where the product requires it:
 * - `img-src` is broad because chat allows inline images from arbitrary URLs. Images
 *   don't execute, so this doesn't weaken the script protection — but it does mean data
 *   can still be smuggled out via an `<img>` URL, so `connect-src` is not a complete
 *   exfil boundary (an accepted, well-understood CSP limitation).
 * - `connect-src` allows `https:`/`ws:`/`wss:` so the same-origin WebSocket works on both
 *   plaintext-LAN and TLS deployments, and so the desktop update banner can fetch its
 *   (cross-origin) update manifest.
 * - `style-src 'unsafe-inline'` covers Svelte's scoped styles / `style=` attributes;
 *   this is far lower risk than inline script and can be tightened to hashes later.
 *
 * Uploads are served separately with their own stricter CSP (see uploads.ts).
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: http: data: blob:",
  "font-src 'self'",
  "connect-src 'self' https: ws: wss:",
].join('; ');

export interface MaraServer {
  readonly hub: Hub;
  /** Actual bound port (useful when configured with port 0). */
  readonly port: number;
  close(): Promise<void>;
}

export interface ServerHooks {
  /** Called when an authorized `POST /admin/shutdown` arrives. Without it the endpoint is off. */
  onShutdownRequest?: () => void;
}

/**
 * Start the unified server and resolve once it is listening. A single HTTP
 * server hosts the built web client (and a `/health` check) while the WebSocket
 * endpoint shares the same port on {@link ServerConfig.wsPath}.
 */
export function startServer(
  cfg: ServerConfig,
  log: Logger,
  hooks: ServerHooks = {},
): Promise<MaraServer> {
  return new Promise((resolve, reject) => {
    const hub = new Hub(cfg, log);

    const serveStatic = cfg.webRoot
      ? sirv(cfg.webRoot, {
          single: true,
          dev: false,
          setHeaders(res, pathname) {
            // Content-hashed build assets are safe to cache forever; the HTML
            // shell (and anything else) must always revalidate so a rebuild's
            // renamed assets are picked up instead of a stale cached index.
            if (pathname.includes('/assets/')) {
              res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            } else {
              res.setHeader('Cache-Control', 'no-cache');
            }
            // Defense-in-depth for the web UI (mainly the chat-render XSS boundary).
            // Enforced only on the document; harmless on static assets. Don't sniff a
            // declared type into something executable.
            res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
            res.setHeader('X-Content-Type-Options', 'nosniff');
          },
        })
      : null;

    // Route precedence: health and the upload API are matched before the static
    // handler so the SPA fallback (single:true) can't swallow them.
    const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/health' || req.url === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
        return;
      }
      // Public, unauthenticated server identity — lets the pre-connection startup
      // screen show the operator-set name (and versions) before a WS login exists.
      if (req.url === '/info') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(
          JSON.stringify({
            name: cfg.serverName,
            version: hub.serverInfo.version,
            protocol: hub.serverInfo.protocol,
          }),
        );
        return;
      }
      if (req.url === SHUTDOWN_ENDPOINT) {
        handleShutdownRequest(req, res, cfg, log, hooks.onShutdownRequest);
        return;
      }
      if (req.url === UPLOAD_ENDPOINT) {
        // Authorize uploads against a live session: the bearer token must match a
        // current session secret. GETs on UPLOAD_ROUTE stay open (capability URLs).
        void handleUpload(
          req,
          res,
          cfg,
          log,
          (token) => token !== undefined && hub.state.sessionBySessionToken(token) !== undefined,
        );
        return;
      }
      if (req.url?.startsWith(UPLOAD_ROUTE)) {
        void serveUpload(req, res, cfg);
        return;
      }
      if (req.url === FILE_ENDPOINT) {
        // Same session authorization as image uploads. GETs on FILE_ROUTE stay open
        // (capability URLs), and every one of them downloads rather than renders.
        void handleFileUpload(
          req,
          res,
          cfg,
          log,
          (token) => token !== undefined && hub.state.sessionBySessionToken(token) !== undefined,
        );
        return;
      }
      if (req.url?.startsWith(FILE_ROUTE)) {
        void serveFile(req, res, cfg);
        return;
      }
      if (req.url === AVATAR_ENDPOINT) {
        // Same session authorization as uploads; GETs on AVATAR_ROUTE stay open.
        void handleAvatarUpload(
          req,
          res,
          cfg,
          log,
          (token) => token !== undefined && hub.state.sessionBySessionToken(token) !== undefined,
        );
        return;
      }
      if (req.url?.startsWith(AVATAR_ROUTE)) {
        void serveAvatar(req, res, cfg);
        return;
      }
      if (req.url === EMOJI_UPLOAD_ENDPOINT) {
        // Same session authorization as uploads; binding a `:shortcode:` to the stored image
        // (and the ownership/dedupe rules) happens over the WS in `addEmoji`.
        void handleEmojiUpload(
          req,
          res,
          cfg,
          log,
          (token) => token !== undefined && hub.state.sessionBySessionToken(token) !== undefined,
        );
        return;
      }
      if (req.url?.startsWith(EMOJI_ROUTE)) {
        void serveEmoji(req, res, cfg);
        return;
      }
      if (serveStatic) {
        serveStatic(req, res, () => {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('Not found');
        });
        return;
      }
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end(
        'Mara 3 server is running, but no web build was found.\nRun: pnpm --filter @mara/web build',
      );
    });

    // Share the HTTP server; only upgrades on wsPath become WebSocket connections.
    const wss = new WebSocketServer({
      server: httpServer,
      path: cfg.wsPath,
      maxPayload: MAX_FRAME_BYTES,
    });
    let counter = 0;

    wss.on('connection', (ws) => {
      const conn = new Connection(`c${++counter}`, ws);
      hub.onConnect(conn);
      ws.on('message', (data) => hub.onMessage(conn, data.toString()));
      // The close CODE is the only thing separating "they quit" from "their connection
      // died", so it has to reach the hub rather than being dropped here.
      ws.on('close', (code: number) => hub.onClose(conn, code));
      ws.on('error', (err) => log.warn({ err, conn: conn.id }, 'socket error'));
    });

    httpServer.on('error', reject);

    httpServer.listen(cfg.port, cfg.host, () => {
      const address = httpServer.address();
      const port = typeof address === 'object' && address ? address.port : cfg.port;
      log.info(
        {
          version: hub.serverInfo.version,
          protocol: hub.serverInfo.protocol,
          webBuild: hub.serverInfo.webBuild ?? '(none)',
          host: cfg.host,
          port,
          wsPath: cfg.wsPath,
          web: cfg.webRoot ?? '(none)',
          name: cfg.serverName,
        },
        'Mara 3 server listening',
      );
      let closed = false;
      resolve({
        hub,
        port,
        close: () =>
          new Promise<void>((res, rej) => {
            if (closed) return res();
            closed = true;
            // Persist pending history, identities + user emoji first, synchronously, so
            // the data is on disk whatever happens to the sockets below.
            hub.flush();
            // Close with 1012 "service restart" so clients know this is a planned stop,
            // not a network fault, and reconnect promptly.
            for (const client of wss.clients)
              client.close(CLOSE_SERVICE_RESTART, 'server restarting');
            wss.close();
            // A client that never answers the close handshake, or an upload still
            // streaming in, mustn't hold the process open: after a short grace, drop
            // whatever is left.
            const force = setTimeout(() => {
              for (const client of wss.clients) client.terminate();
              httpServer.closeAllConnections();
            }, CLOSE_GRACE_MS);
            force.unref();
            httpServer.close((err) => {
              clearTimeout(force);
              // Catch anything that changed while the sockets drained.
              hub.flush();
              if (err) rej(err);
              else res();
            });
          }),
      });
    });
  });
}
