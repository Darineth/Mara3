/** Server configuration, resolved from environment with sensible defaults. */
export interface ServerConfig {
  host: string;
  port: number;
  serverName: string;
  motd: string;
  /** Minimum acceptable client `appVersion`; older clients are told to update. */
  minAppVersion: number;
}

const DEFAULTS: ServerConfig = {
  host: '0.0.0.0',
  port: 5050,
  serverName: 'Mara 3 Server',
  motd: 'Welcome to Mara 3.',
  minAppVersion: 0,
};

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    host: env.MARA_HOST?.trim() || DEFAULTS.host,
    port: num(env.MARA_PORT, DEFAULTS.port),
    serverName: env.MARA_SERVER_NAME?.trim() || DEFAULTS.serverName,
    motd: env.MARA_MOTD ?? DEFAULTS.motd,
    minAppVersion: num(env.MARA_MIN_APP_VERSION, DEFAULTS.minAppVersion),
  };
}
