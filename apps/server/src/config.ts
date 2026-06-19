import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const DEFAULTS = {
  host: '0.0.0.0',
  port: 5050,
  serverName: 'Mara 3 Server',
  motd: 'Welcome to Mara 3.',
  minAppVersion: 0,
  wsPath: '/ws',
  defaultChannel: 'Main',
  uploadDir: join(tmpdir(), 'mara-uploads'),
  maxUploadMb: 10,
  maxCacheMb: 512,
};

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
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
    uploadDir: env.MARA_UPLOAD_DIR?.trim() || DEFAULTS.uploadDir,
    maxUploadBytes: mb(env.MARA_MAX_UPLOAD_MB, DEFAULTS.maxUploadMb),
    maxCacheBytes: mb(env.MARA_MAX_CACHE_MB, DEFAULTS.maxCacheMb),
  };
}
