import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { startServer } from './server.js';

const config = loadConfig();
const log = createLogger();
const server = await startServer(config, log);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info({ signal }, 'shutting down');
    void server.close().then(() => process.exit(0));
  });
}
