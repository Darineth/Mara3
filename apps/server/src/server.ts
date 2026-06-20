import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import sirv from 'sirv';
import { WebSocketServer } from 'ws';
import { Connection } from './connection.js';
import type { ServerConfig } from './config.js';
import { Hub } from './hub.js';
import type { Logger } from './logger.js';
import { handleUpload, serveUpload, UPLOAD_ENDPOINT, UPLOAD_ROUTE } from './uploads.js';

/**
 * Hard cap on a single inbound WebSocket frame. The largest legitimate message
 * (a max-length chat plus JSON overhead, or a capped pluginData blob) is well
 * under this; it exists to stop a client from forcing us to buffer ws's 100 MiB
 * default per frame.
 */
const MAX_FRAME_BYTES = 256 * 1024;

export interface MaraServer {
  readonly hub: Hub;
  /** Actual bound port (useful when configured with port 0). */
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Start the unified server and resolve once it is listening. A single HTTP
 * server hosts the built web client (and a `/health` check) while the WebSocket
 * endpoint shares the same port on {@link ServerConfig.wsPath}.
 */
export function startServer(cfg: ServerConfig, log: Logger): Promise<MaraServer> {
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
      ws.on('close', () => hub.onClose(conn));
      ws.on('error', (err) => log.warn({ err, conn: conn.id }, 'socket error'));
    });

    httpServer.on('error', reject);

    httpServer.listen(cfg.port, cfg.host, () => {
      const address = httpServer.address();
      const port = typeof address === 'object' && address ? address.port : cfg.port;
      log.info(
        {
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
            // Persist any pending message history before we tear everything down.
            hub.flushHistory();
            // terminate(), not close(): drop sockets immediately so a slow/idle
            // client can't hold the process open past shutdown.
            for (const client of wss.clients) client.terminate();
            wss.close();
            httpServer.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}
