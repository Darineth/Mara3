import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

/** Server configuration, resolved from environment with sensible defaults. */
export interface ServerConfig {
  host: string;
  port: number;
  serverName: string;
  motd: string;
  /** Minimum acceptable client `appVersion`; older clients are told to update. */
  minAppVersion: number;
  /** Directory of the built web client to serve, or null to serve none. */
  webRoot: string | null;
  /** Path the WebSocket endpoint listens on (HTTP serves everything else). */
  wsPath: string;
  /** Channel every user is auto-joined to on login; empty string disables it. */
  defaultChannel: string;
  /** Directory where uploaded images are cached and served from. */
  uploadDir: string;
  /** Maximum size of a single uploaded file, in bytes. */
  maxUploadBytes: number;
  /** Cap on total upload-cache size; oldest files are evicted on new uploads. */
  maxCacheBytes: number;
  /** Recent messages retained per channel and replayed as backlog on join. */
  historyLimit: number;
  /**
   * File the per-channel message history is persisted to (so backlog survives a
   * restart). On by default (`apps/server/data/history.json`); set
   * `MARA_HISTORY_FILE` empty to disable — history then stays in-memory only
   * (tests do this to stay isolated).
   */
  historyFile: string;
  /**
   * File the client identity → token map is persisted to, so a client keeps its
   * token across reconnects and restarts. On by default; set `MARA_IDENTITY_FILE`
   * empty to disable (in-memory only; tests do this).
   */
  identityFile: string;
}

/** Where the web client build lands by default: `apps/web/dist`, relative to here. */
function defaultWebRoot(): string | null {
  const dist = fileURLToPath(new URL('../../web/dist/', import.meta.url));
  return existsSync(dist) ? dist : null;
}

/**
 * Base directory for the server's PERSISTENT state — message history, the identity
 * map, and the upload cache. Deliberately kept apart from the server CODE so a
 * deployment can be updated by replacing the code (the bundle's `app/` + `web/`)
 * without disturbing saved data.
 *
 * Defaults to the server package root (relative to this module), so a dev run keeps
 * using `apps/server/{data,uploads}`. The portable launcher sets `MARA_BASE_DIR` to
 * the bundle root, so in a packaged install the state lives next to the launcher and
 * `mara.config` — outside the replaceable `app/` folder. Per-store overrides
 * (`MARA_UPLOAD_DIR`, `MARA_HISTORY_FILE`, `MARA_IDENTITY_FILE`) still win over this.
 */
function baseDir(env: NodeJS.ProcessEnv): string {
  return env.MARA_BASE_DIR?.trim() || fileURLToPath(new URL('../', import.meta.url));
}

// Bare defaults; size limits are kept in MB here and converted to bytes at load
// (env vars are also expressed in MB, so the unit lives in one place).
const DEFAULTS = {
  host: '0.0.0.0',
  port: 5050,
  serverName: 'Mara 3 Server',
  motd: 'Welcome to Mara 3.',
  minAppVersion: 0,
  wsPath: '/ws',
  defaultChannel: 'Main',
  maxUploadMb: 10,
  maxCacheMb: 512,
  historyLimit: 100,
};

// Parse a numeric env var, falling back on missing/blank/non-finite input
// (rather than letting a typo collapse to NaN and propagate).
function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Load a `KEY=value` config file (next to the launcher) into `env`, layering it
 * UNDER the real environment: a variable already present in `env` is never
 * overwritten, so precedence stays defaults < file < environment. Only keys in
 * the `MARA_*` namespace are honored, so the file can't tamper with PATH,
 * NODE_OPTIONS, etc. Lines are `KEY=value`; blank lines and `#` comments are
 * skipped, and one layer of matching surrounding quotes is stripped from values.
 *
 * The file is `mara.config` in the working directory by default (the launcher
 * `cd`s next to itself first, so that's right beside the executable); override
 * the location with `MARA_CONFIG=<path>`. Returns the path loaded and which keys
 * it actually applied (those not already set in `env`), or null if no file.
 */
export function loadConfigFile(
  env: NodeJS.ProcessEnv = process.env,
): { path: string; applied: string[] } | null {
  const path = env.MARA_CONFIG?.trim() || resolve(process.cwd(), 'mara.config');
  if (!existsSync(path)) return null;

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null; // unreadable file → fall back to env/defaults rather than crash
  }

  const applied: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue; // no key, or malformed line
    const key = line.slice(0, eq).trim();
    if (!/^MARA_[A-Z0-9_]+$/.test(key)) continue; // only our namespace
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1); // strip one layer of matching quotes
    }
    if (env[key] === undefined) {
      env[key] = value; // real environment wins; only fill what's unset
      applied.push(key);
    }
  }
  return { path, applied };
}

/** Resolve the full server config from `env`, applying defaults for anything unset. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  // MB env var → bytes; clamp negatives to 0 so a bad value can't widen a limit.
  const mb = (v: string | undefined, fallback: number) =>
    Math.max(0, num(v, fallback)) * 1024 * 1024;
  // Persistent state lives under here (overridable per-store below). See baseDir().
  const base = baseDir(env);
  return {
    host: env.MARA_HOST?.trim() || DEFAULTS.host,
    port: num(env.MARA_PORT, DEFAULTS.port),
    serverName: env.MARA_SERVER_NAME?.trim() || DEFAULTS.serverName,
    motd: env.MARA_MOTD ?? DEFAULTS.motd,
    minAppVersion: num(env.MARA_MIN_APP_VERSION, DEFAULTS.minAppVersion),
    webRoot: env.MARA_WEB_ROOT?.trim() || defaultWebRoot(),
    wsPath: env.MARA_WS_PATH?.trim() || DEFAULTS.wsPath,
    defaultChannel: (env.MARA_DEFAULT_CHANNEL ?? DEFAULTS.defaultChannel).trim(),
    uploadDir: env.MARA_UPLOAD_DIR?.trim() || join(base, 'uploads'),
    maxUploadBytes: mb(env.MARA_MAX_UPLOAD_MB, DEFAULTS.maxUploadMb),
    maxCacheBytes: mb(env.MARA_MAX_CACHE_MB, DEFAULTS.maxCacheMb),
    historyLimit: Math.max(0, num(env.MARA_HISTORY_LIMIT, DEFAULTS.historyLimit)),
    // Persist by default; set MARA_HISTORY_FILE='' to disable (in-memory only).
    historyFile: (env.MARA_HISTORY_FILE ?? join(base, 'data', 'history.json')).trim(),
    identityFile: (env.MARA_IDENTITY_FILE ?? join(base, 'data', 'identity.json')).trim(),
  };
}
