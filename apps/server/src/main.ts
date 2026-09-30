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

/**
 * How long a stop may take before we exit anyway. The data is already flushed synchronously
 * at the start of close(), so this only bounds a hung socket drain.
 */
const FORCE_EXIT_MS = 5000;

let stopping = false;

/**
 * Stop cleanly: flush state, close sockets, exit. Every requested stop exits **0**, which the
 * launcher (Mara3-Server.bat) reads as "don't restart"; a crash exits non-zero and is
 * relaunched. A second request while stopping exits at once (the flush has already run).
 */
function shutdown(reason: string): void {
  if (stopping) {
    log.warn({ reason }, 'second stop request; exiting now');
    process.exit(0);
  }
  stopping = true;
  log.info({ reason }, 'shutting down');
  setTimeout(() => {
    log.warn({ afterMs: FORCE_EXIT_MS }, 'shutdown timed out; exiting anyway');
    process.exit(0);
  }, FORCE_EXIT_MS).unref();
  server.close().then(
    () => process.exit(0),
    (err: unknown) => {
      log.error({ err }, 'error while shutting down; exiting anyway');
      process.exit(0);
    },
  );
}

const server = await startServer(config, log, {
  onShutdownRequest: () => shutdown('admin request'),
});

// Windows has no real SIGTERM: SIGINT is Ctrl+C, SIGBREAK is Ctrl+Break, and SIGHUP arrives
// when the console window is closed (Windows kills the process a few seconds later, which is
// long enough for the synchronous flush). Hard kills (taskkill /F, ending a scheduled task)
// run no handler at all — use POST /admin/shutdown for a clean stop from outside.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as const) {
  process.on(signal, () => shutdown(signal));
}
