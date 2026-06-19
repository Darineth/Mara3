import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { ServerConfig } from './config.js';
import type { Logger } from './logger.js';

/** Public route prefix uploaded files are served from. */
export const UPLOAD_ROUTE = '/uploads/';
/** Endpoint that accepts a raw image body and returns its hosted URL. */
export const UPLOAD_ENDPOINT = '/upload';

/**
 * Accepted image content types → file extension. SVG is intentionally excluded:
 * we host uploads on our own origin, and an SVG can carry script that would run
 * if opened directly, so we never store user-supplied SVG. (External SVG URLs
 * are still fine — they render via `<img>`, which never executes their script.)
 */
const TYPE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
};

const EXT_TYPE: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
};

/** Our generated names only: 32 hex chars + a known extension. */
const SAFE_NAME_RE = /^[0-9a-f]{32}\.(png|jpg|gif|webp|avif|bmp)$/;

function send(res: ServerResponse, status: number, body: string, contentType = 'text/plain') {
  // The client may have already hung up (e.g. after an early 413); swallow the
  // resulting socket error rather than letting it crash the process.
  res.on('error', () => {});
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': contentType });
  res.end(body);
}

/**
 * Make room for `incoming` bytes by deleting the oldest files until the cache
 * (existing total + incoming) fits under `maxBytes`. Runs at the start of each
 * upload, so the cache is a rolling window bounded by `maxCacheBytes`.
 */
async function evictToFit(
  dir: string,
  maxBytes: number,
  incoming: number,
  log: Logger,
): Promise<void> {
  let entries: { name: string; size: number; mtime: number }[];
  try {
    const names = await readdir(dir);
    entries = [];
    for (const name of names) {
      try {
        const s = await stat(join(dir, name));
        if (s.isFile()) entries.push({ name, size: s.size, mtime: s.mtimeMs });
      } catch {
        /* file vanished between readdir and stat; ignore */
      }
    }
  } catch {
    return; // dir missing — nothing to evict
  }

  let total = entries.reduce((sum, e) => sum + e.size, 0);
  if (total + incoming <= maxBytes) return;

  entries.sort((a, b) => a.mtime - b.mtime); // oldest first
  for (const e of entries) {
    if (total + incoming <= maxBytes) break;
    try {
      await unlink(join(dir, e.name));
      total -= e.size;
      log.debug({ file: e.name, size: e.size }, 'evicted cached upload');
    } catch {
      /* already gone; ignore */
    }
  }
}

/** Read the request body, enforcing the per-file byte cap as it streams. */
function readCappedBody(req: IncomingMessage, cap: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > cap) {
        aborted = true;
        chunks.length = 0; // release what we buffered
        req.resume(); // drain & discard the rest so we can still reply 413
        resolve(null); // signals "too large"
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!aborted) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!aborted) reject(err);
    });
  });
}

/** Handle `POST /upload`: validate, evict-to-fit, store, return `{ url }`. */
export async function handleUpload(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ServerConfig,
  log: Logger,
): Promise<void> {
  if (req.method !== 'POST') {
    send(res, 405, 'Method not allowed');
    return;
  }
  const contentType = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  const ext = contentType ? TYPE_EXT[contentType] : undefined;
  if (!ext) {
    send(res, 415, 'Unsupported image type');
    return;
  }

  let body: Buffer | null;
  try {
    body = await readCappedBody(req, cfg.maxUploadBytes);
  } catch (err) {
    log.warn({ err }, 'upload read failed');
    send(res, 400, 'Upload failed');
    return;
  }
  if (body === null) {
    send(res, 413, `File exceeds ${Math.round(cfg.maxUploadBytes / 1024 / 1024)} MB limit`);
    return;
  }
  if (body.length === 0) {
    send(res, 400, 'Empty upload');
    return;
  }

  const name = `${randomBytes(16).toString('hex')}.${ext}`;
  try {
    await mkdir(cfg.uploadDir, { recursive: true });
    await evictToFit(cfg.uploadDir, cfg.maxCacheBytes, body.length, log);
    await writeFile(join(cfg.uploadDir, name), body);
  } catch (err) {
    log.error({ err, dir: cfg.uploadDir }, 'upload store failed');
    send(res, 500, 'Could not store upload');
    return;
  }

  const url = `${UPLOAD_ROUTE}${name}`;
  log.info({ name, bytes: body.length }, 'stored upload');
  send(res, 200, JSON.stringify({ url }), 'application/json');
}

/** Handle `GET /uploads/<name>`: stream a stored file back, safely. */
export async function serveUpload(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ServerConfig,
): Promise<void> {
  const name = decodeURIComponent((req.url ?? '').slice(UPLOAD_ROUTE.length).split(/[?#]/)[0] ?? '');
  if (!SAFE_NAME_RE.test(name)) {
    send(res, 404, 'Not found');
    return;
  }
  const ext = name.slice(name.lastIndexOf('.') + 1);
  const file = join(cfg.uploadDir, name);
  try {
    const s = await stat(file);
    if (!s.isFile()) {
      send(res, 404, 'Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': EXT_TYPE[ext] ?? 'application/octet-stream',
      'content-length': s.size,
      // Names are content-random and never reused, so cache aggressively.
      'cache-control': 'public, max-age=31536000, immutable',
      // Defense in depth: never sniff, never let a stored file run script.
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; img-src 'self'; sandbox",
    });
    res.on('error', () => {});
    const stream = createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch {
    send(res, 404, 'Not found');
  }
}
