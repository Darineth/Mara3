import { WebSocketServer } from 'ws';
import { Connection } from './connection.js';
import type { ServerConfig } from './config.js';
import { Hub } from './hub.js';
import type { Logger } from './logger.js';

export interface MaraServer {
  readonly hub: Hub;
  /** Actual bound port (useful when configured with port 0). */
  readonly port: number;
  close(): Promise<void>;
}

/** Start the WebSocket server and resolve once it is listening. */
export function startServer(cfg: ServerConfig, log: Logger): Promise<MaraServer> {
  return new Promise((resolve, reject) => {
    const hub = new Hub(cfg, log);
    const wss = new WebSocketServer({ host: cfg.host, port: cfg.port });
    let counter = 0;

    wss.on('connection', (ws) => {
      const conn = new Connection(`c${++counter}`, ws);
      hub.onConnect(conn);
      ws.on('message', (data) => hub.onMessage(conn, data.toString()));
      ws.on('close', () => hub.onClose(conn));
      ws.on('error', (err) => log.warn({ err, conn: conn.id }, 'socket error'));
    });

    wss.on('error', reject);

    wss.on('listening', () => {
      const address = wss.address();
      const port = typeof address === 'object' && address ? address.port : cfg.port;
      log.info({ host: cfg.host, port, name: cfg.serverName }, 'Mara 3 server listening');
      let closed = false;
      resolve({
        hub,
        port,
        close: () =>
          new Promise<void>((res, rej) => {
            if (closed) return res();
            closed = true;
            for (const client of wss.clients) client.terminate();
            wss.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}
