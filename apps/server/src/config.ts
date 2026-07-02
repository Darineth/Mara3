import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { MOTD_MAX_LEN } from '@mara/protocol';

/** Server configuration, resolved from environment with sensible defaults. */
export interface ServerConfig {
  host: string;
  port: number;
  serverName: string;
  motd: string;
  /** Path the MOTD is re-read from on each login, so edits to `MOTD.md` apply without a
   *  server restart. Empty/absent → the static `motd` (from `MARA_MOTD`/default) is used. */
  motdFile?: string;
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
  /** Directory of custom emoji images the operator provides; each file's name (sans
   *  extension) is its `:shortcode:`. Scanned on demand and served at `/emoji/`. */
  emojiDir: string;
  /** Maximum size of a single uploaded file, in bytes. */
  maxUploadBytes: number;
  /** Cap on total upload-cache size; oldest files are evicted on new uploads. */
  maxCacheBytes: number;
  /** Messages retained per channel (persisted, and the deepest a client can page back). */
  historyLimit: number;
  /** Messages sent on join, and per "load older" page as the user scrolls up. */
  historyChunk: number;
  /** Per-connection message rate limit (sustained msgs/sec, token bucket). `<= 0`
   *  disables flood control entirely (e.g. a trusted LAN). */
  msgRate: number;
  /** Token-bucket capacity: how many messages a connection may send in a quick burst. */
  msgBurst: number;
  /** Consecutive over-limit (dropped) messages before the flooding socket is closed. */
  msgFloodKick: number;
  /**
   * Grace period (ms) between a user's *last* socket closing and announcing their
   * disconnect. A reconnect within this window (same identity) is treated as
   * continuous presence — no leave/join churn — which matters on mobile, where
   * backgrounding a tab or switching networks drops and re-opens the socket
   * constantly. `<= 0` disables it (immediate disconnect, as before). */
  disconnectGraceMs: number;
  /**
   * Longer grace applied to a user detected *flapping* (repeatedly dropping and
   * reconnecting over a long stretch — the classic backgrounded-Android-tab
   * pattern). Once flagged, their presence churn is suppressed: reconnects within
   * this window stay silent (no join/disconnect lines), and only a continuous
   * absence past it announces the departure. Actively participating (sending a
   * chat/emote) clears the flag. `<= 0` disables flap damping entirely. */
  flapSettleMs: number;
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

/**
 * Message of the day. A `MOTD.md` file next to the launcher (the working directory,
 * where `mara.config` also lives) is the zero-config way to set a longer / markdown
 * message: if it exists, its contents are the MOTD. Otherwise fall back to the inline
 * `MARA_MOTD` (or the built-in default). Truncated to the protocol's cap so an
 * oversized file can't make the `welcome` frame fail validation. `MARA_MOTD_FILE`
 * overrides the path for a file kept elsewhere.
 */
/** Candidate MOTD file path: `MARA_MOTD_FILE`, else `MOTD.md` in the working directory. */
function motdPath(env: NodeJS.ProcessEnv): string {
  return env.MARA_MOTD_FILE?.trim() || resolve(process.cwd(), 'MOTD.md');
}

function readMotd(env: NodeJS.ProcessEnv): string {
  const file = motdPath(env);
  if (existsSync(file)) {
    try {
      return readFileSync(file, 'utf8').trim().slice(0, MOTD_MAX_LEN);
    } catch {
      /* unreadable → fall through to env/default */
    }
  }
  return (env.MARA_MOTD ?? DEFAULTS.motd).slice(0, MOTD_MAX_LEN);
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
  historyLimit: 1000,
  historyChunk: 50,
  msgRate: 15,
  msgBurst: 30,
  msgFloodKick: 300,
  disconnectGraceMs: 15_000,
  flapSettleMs: 300_000,
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
    if (value.startsWith('"') || value.startsWith("'")) {
      // Quoted value: take the contents up to the matching closing quote; anything
      // after it (e.g. an inline comment) is ignored, and a literal '#' inside is
      // kept.
      const quote = value.startsWith('"') ? '"' : "'";
      const close = value.indexOf(quote, 1);
      value = (close >= 0 ? value.slice(1, close) : value.slice(1)).trim();
    } else {
      // Unquoted value: strip an inline comment introduced by whitespace + '#'
      // (`KEY=val   # note` → `val`), so uncommenting an annotated example line
      // works. A '#' with no leading whitespace stays part of the value (paths,
      // colours, …); quote the value to keep a space-prefixed '#'.
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trim();
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
    motd: readMotd(env),
    motdFile: motdPath(env),
    minAppVersion: num(env.MARA_MIN_APP_VERSION, DEFAULTS.minAppVersion),
    webRoot: env.MARA_WEB_ROOT?.trim() || defaultWebRoot(),
    wsPath: env.MARA_WS_PATH?.trim() || DEFAULTS.wsPath,
    defaultChannel: (env.MARA_DEFAULT_CHANNEL ?? DEFAULTS.defaultChannel).trim(),
    uploadDir: env.MARA_UPLOAD_DIR?.trim() || join(base, 'uploads'),
    emojiDir: env.MARA_EMOJI_DIR?.trim() || join(base, 'emoji'),
    maxUploadBytes: mb(env.MARA_MAX_UPLOAD_MB, DEFAULTS.maxUploadMb),
    maxCacheBytes: mb(env.MARA_MAX_CACHE_MB, DEFAULTS.maxCacheMb),
    historyLimit: Math.max(0, num(env.MARA_HISTORY_LIMIT, DEFAULTS.historyLimit)),
    historyChunk: Math.max(1, num(env.MARA_HISTORY_CHUNK, DEFAULTS.historyChunk)),
    msgRate: num(env.MARA_MSG_RATE, DEFAULTS.msgRate),
    msgBurst: Math.max(1, num(env.MARA_MSG_BURST, DEFAULTS.msgBurst)),
    msgFloodKick: Math.max(1, num(env.MARA_MSG_FLOOD_KICK, DEFAULTS.msgFloodKick)),
    disconnectGraceMs: Math.max(0, num(env.MARA_DISCONNECT_GRACE_MS, DEFAULTS.disconnectGraceMs)),
    flapSettleMs: Math.max(0, num(env.MARA_FLAP_SETTLE_MS, DEFAULTS.flapSettleMs)),
    // Persist by default; set MARA_HISTORY_FILE='' to disable (in-memory only).
    historyFile: (env.MARA_HISTORY_FILE ?? join(base, 'data', 'history.json')).trim(),
    identityFile: (env.MARA_IDENTITY_FILE ?? join(base, 'data', 'identity.json')).trim(),
  };
}
