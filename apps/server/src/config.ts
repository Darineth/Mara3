import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
}

/** Where the web client build lands by default: `apps/web/dist`, relative to here. */
function defaultWebRoot(): string | null {
  const dist = fileURLToPath(new URL('../../web/dist/', import.meta.url));
  return existsSync(dist) ? dist : null;
}

/**
 * Upload cache, nested under the server's own directory so it travels with the
 * deployment. Resolved relative to this module, so it lands in the server
 * package root whether running from `src/` (tsx) or the built `dist/`.
 */
function defaultUploadDir(): string {
  return fileURLToPath(new URL('../uploads/', import.meta.url));
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
};

// Parse a numeric env var, falling back on missing/blank/non-finite input
// (rather than letting a typo collapse to NaN and propagate).
function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Resolve the full server config from `env`, applying defaults for anything unset. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  // MB env var → bytes; clamp negatives to 0 so a bad value can't widen a limit.
  const mb = (v: string | undefined, fallback: number) =>
    Math.max(0, num(v, fallback)) * 1024 * 1024;
  return {
    host: env.MARA_HOST?.trim() || DEFAULTS.host,
    port: num(env.MARA_PORT, DEFAULTS.port),
    serverName: env.MARA_SERVER_NAME?.trim() || DEFAULTS.serverName,
    motd: env.MARA_MOTD ?? DEFAULTS.motd,
    minAppVersion: num(env.MARA_MIN_APP_VERSION, DEFAULTS.minAppVersion),
    webRoot: env.MARA_WEB_ROOT?.trim() || defaultWebRoot(),
    wsPath: env.MARA_WS_PATH?.trim() || DEFAULTS.wsPath,
    defaultChannel: (env.MARA_DEFAULT_CHANNEL ?? DEFAULTS.defaultChannel).trim(),
    uploadDir: env.MARA_UPLOAD_DIR?.trim() || defaultUploadDir(),
    maxUploadBytes: mb(env.MARA_MAX_UPLOAD_MB, DEFAULTS.maxUploadMb),
    maxCacheBytes: mb(env.MARA_MAX_CACHE_MB, DEFAULTS.maxCacheMb),
  };
}
