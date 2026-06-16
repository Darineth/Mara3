import { pino, type Logger } from 'pino';

export type { Logger };

/** Create the server logger. Pretty in dev (TTY), JSON otherwise, silent in tests. */
export function createLogger(level = process.env.MARA_LOG_LEVEL ?? 'info'): Logger {
  if (level === 'silent') return pino({ level: 'silent' });
  const pretty = process.stdout.isTTY && process.env.NODE_ENV !== 'production';
  return pino({
    level,
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : {}),
  });
}
