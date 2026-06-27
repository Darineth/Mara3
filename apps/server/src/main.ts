// Process entrypoint: load config, start the server, and shut down cleanly on signals.
import { loadConfig, loadConfigFile } from './config.js';
import { createLogger } from './logger.js';
import { startServer } from './server.js';

const log = createLogger();
// Pull in a mara.config file next to the launcher (if any) before resolving
// config, so its values fill anything not already set in the environment.
const fileResult = loadConfigFile();
if (fileResult) {
  log.info(
    { file: fileResult.path, applied: fileResult.applied },
    fileResult.applied.length > 0
      ? 'loaded config file'
      : 'config file found (all keys overridden by environment)',
  );
}
const config = loadConfig();
const server = await startServer(config, log);

// Drain WS clients and stop listening before exiting, so an orchestrator's
// SIGTERM (or Ctrl-C) doesn't leave sockets dangling.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info({ signal }, 'shutting down');
    void server.close().then(() => process.exit(0));
  });
}
