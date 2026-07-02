import { createReadStream } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { EmojiEntry } from '@mara/protocol';
import type { ServerConfig } from './config.js';
import type { Logger } from './logger.js';

/** Public route prefix custom emoji images are served from. */
export const EMOJI_ROUTE = '/emoji/';

/** Image extensions honored as emoji → their content type. SVG is excluded for the same
 *  reason as uploads (it can carry script if opened directly). */
const EXT_TYPE: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
};

/** A shortcode is the file's basename (sans extension): the emoji charset only. */
const NAME_RE = /^[a-zA-Z0-9_+-]{1,64}$/;
/** A served emoji filename: shortcode charset + a known extension (no `.`/slash in the
 *  stem, so no traversal). */
const SAFE_FILE_RE = /^[a-zA-Z0-9_+-]+\.(png|jpg|jpeg|gif|webp|avif|bmp)$/i;

/**
 * The operator's custom emoji set, read from a directory where each image file's name
 * (sans extension) is its `:shortcode:` — e.g. `blobwave.png` → `:blobwave:`. The scan is
 * cached briefly so a busy login burst doesn't re-read the directory each time, but a short
 * TTL means dropping in new files takes effect within seconds without a restart (mirroring
 * how the MOTD is re-read). Files whose name isn't a valid shortcode are skipped; on a
 * shortcode collision (same name, different extension) the first by sorted filename wins.
 */
export class EmojiStore {
  private cached: EmojiEntry[] = [];
  private scannedAt = -Infinity;

  constructor(
    private readonly dir: string,
    private readonly log: Logger,
    /** Cache lifetime for a scan; 0 forces a fresh scan every call (tests). */
    private readonly ttlMs = 3000,
    private readonly now: () => number = Date.now,
  ) {}

  /** The current manifest (shortcode → URL), re-scanning the directory when the cache is
   *  stale. Never throws — a missing/unreadable directory yields an empty set. */
  manifest(): EmojiEntry[] {
    if (this.now() - this.scannedAt < this.ttlMs) return this.cached;
    this.cached = this.scan();
    this.scannedAt = this.now();
    return this.cached;
  }

  private scan(): EmojiEntry[] {
    let files: string[];
    try {
      files = readdirSync(this.dir).sort(); // sorted → deterministic collision resolution
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.log.warn({ err, dir: this.dir }, 'could not read emoji directory');
      }
      return [];
    }
    const byName = new Map<string, string>();
    for (const file of files) {
      const dot = file.lastIndexOf('.');
      if (dot <= 0) continue;
      const ext = file.slice(dot + 1).toLowerCase();
      if (!(ext in EXT_TYPE)) continue;
      const name = file.slice(0, dot);
      if (!NAME_RE.test(name) || byName.has(name)) continue;
      try {
        if (!statSync(join(this.dir, file)).isFile()) continue;
      } catch {
        continue; // vanished between readdir and stat
      }
      byName.set(name, `${EMOJI_ROUTE}${file}`);
    }
    return [...byName].map(([name, url]) => ({ name, url }));
  }
}

/** Handle `GET /emoji/<file>`: stream a stored emoji image back, safely. */
export async function serveEmoji(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ServerConfig,
): Promise<void> {
  const name = decodeURIComponent((req.url ?? '').slice(EMOJI_ROUTE.length).split(/[?#]/)[0] ?? '');
  if (!SAFE_FILE_RE.test(name)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
    return;
  }
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  const file = join(cfg.emojiDir, name);
  try {
    const s = await stat(file);
    if (!s.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': EXT_TYPE[ext] ?? 'application/octet-stream',
      'content-length': s.size,
      // Not content-hashed (the filename is the shortcode, so a replacement reuses it), so
      // cache modestly rather than immutably — a swapped image propagates within minutes.
      'cache-control': 'public, max-age=300',
      // Defense in depth: never sniff, never let a served file run script.
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; img-src 'self'; sandbox",
    });
    res.on('error', () => {});
    const stream = createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
}
