import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { ServerConfig } from './config.js';
import { EMOJI_ROUTE } from './emoji.js';
import type { Logger } from './logger.js';

/** Public route prefix uploaded files are served from. */
export const UPLOAD_ROUTE = '/uploads/';
/** Endpoint that accepts a raw image body and returns its hosted URL. */
export const UPLOAD_ENDPOINT = '/upload';

/**
 * Public route prefix shared (non-image) files are served from, and the endpoint that
 * accepts one. Unlike `/uploads/`, a URL here carries the original filename and byte size
 * so a client can render a file card straight from the message text — no extra request and
 * nothing added to the wire format. See {@link fileUrl} for the shape.
 */
export const FILE_ROUTE = '/files/';
export const FILE_ENDPOINT = '/file';
/** Header carrying the original filename on a `POST /file`, percent-encoded (the body is
 *  the raw bytes, so there is nowhere else to put it and a header must be latin-1). */
export const FILENAME_HEADER = 'x-mara-filename';

/** Avatars get their own durable store: a set avatar must not vanish from the rolling,
 *  LRU-evicted upload cache, so it's stored in a separate directory that is never evicted
 *  (bounded instead by deleting a user's previous avatar when they change it — see hub). */
export const AVATAR_ROUTE = '/avatars/';
/** Endpoint that accepts a raw avatar image and returns its durable hosted URL. */
export const AVATAR_ENDPOINT = '/avatar';

/** Endpoint that accepts a raw user-contributed emoji image and returns its durable hosted
 *  URL under `/emoji/`. The image is stored like an avatar (never evicted); the caller then
 *  binds a `:shortcode:` to the returned URL over the WebSocket (`addEmoji`). */
export const EMOJI_UPLOAD_ENDPOINT = '/emoji-upload';

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

/**
 * Verify the body's leading bytes match the declared image type, so a client can't
 * store arbitrary bytes by lying in `Content-Type`. Defense-in-depth: stored files
 * are already served with a fixed type + `nosniff` + sandbox CSP, so a mismatch was
 * never an XSS vector — this just refuses to cache non-images.
 */
function sniffMatches(buf: Buffer, ext: string): boolean {
  const at = (offset: number, bytes: number[]): boolean =>
    bytes.every((b, i) => buf[offset + i] === b);
  switch (ext) {
    case 'png':
      return at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'jpg':
      return at(0, [0xff, 0xd8, 0xff]);
    case 'gif':
      return at(0, [0x47, 0x49, 0x46, 0x38]); // "GIF8"
    case 'webp':
      return at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50]); // "RIFF"…"WEBP"
    case 'bmp':
      return at(0, [0x42, 0x4d]); // "BM"
    case 'avif':
      return at(4, [0x66, 0x74, 0x79, 0x70]); // ISO-BMFF "ftyp" box
    default:
      return false;
  }
}

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
  /** Never evict this file — the one we just wrote. Without it a single upload larger
   *  than the whole store would delete itself and 404 the moment it was shared. */
  keep?: string,
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
    if (e.name === keep) continue;
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

/** Pull a bearer token out of the Authorization header, if present. */
function bearerToken(req: IncomingMessage): string | undefined {
  const auth = req.headers['authorization'];
  return auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
}

/** Where + how a POSTed image is stored. Chat uploads use the rolling, evicted cache;
 *  avatars use a durable, never-evicted store with a smaller cap. */
interface StoreOptions {
  dir: string;
  cap: number;
  route: string;
  /** Evict the oldest files to stay under `cacheBytes` before writing (chat uploads only). */
  cacheBytes?: number;
  kind: string;
}

/**
 * Authenticate, validate, (optionally evict-to-fit,) store, and return `{ url }`.
 * `authorize` gates the write to a live WS session (the per-session resume token presented
 * as `Authorization: Bearer …`), so anonymous clients can't store files or churn the cache.
 * Shared by chat uploads (`/upload`) and avatars (`/avatar`).
 */
async function storeImage(
  req: IncomingMessage,
  res: ServerResponse,
  log: Logger,
  authorize: (token: string | undefined) => boolean,
  opts: StoreOptions,
): Promise<void> {
  if (req.method !== 'POST') {
    send(res, 405, 'Method not allowed');
    return;
  }
  // Reject before reading the body so an unauthorized client can't make us
  // buffer a large upload.
  if (!authorize(bearerToken(req))) {
    send(res, 401, 'Unauthorized');
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
    body = await readCappedBody(req, opts.cap);
  } catch (err) {
    log.warn({ err, kind: opts.kind }, 'upload read failed');
    send(res, 400, 'Upload failed');
    return;
  }
  if (body === null) {
    send(res, 413, `File exceeds ${Math.round(opts.cap / 1024 / 1024)} MB limit`);
    return;
  }
  if (body.length === 0) {
    send(res, 400, 'Empty upload');
    return;
  }
  // The bytes must actually look like the declared image type (not just the header).
  if (!sniffMatches(body, ext)) {
    send(res, 415, 'Upload does not look like a valid image');
    return;
  }

  const name = `${randomBytes(16).toString('hex')}.${ext}`;
  try {
    await mkdir(opts.dir, { recursive: true });
    if (opts.cacheBytes !== undefined) {
      await evictToFit(opts.dir, opts.cacheBytes, body.length, log);
    }
    await writeFile(join(opts.dir, name), body);
  } catch (err) {
    log.error({ err, dir: opts.dir, kind: opts.kind }, 'upload store failed');
    send(res, 500, 'Could not store upload');
    return;
  }

  const url = `${opts.route}${name}`;
  log.info({ name, bytes: body.length, kind: opts.kind }, 'stored upload');
  send(res, 200, JSON.stringify({ url }), 'application/json');
}

/** Handle `POST /upload`: a chat image, stored in the rolling (LRU-evicted) cache. */
export function handleUpload(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ServerConfig,
  log: Logger,
  authorize: (token: string | undefined) => boolean,
): Promise<void> {
  return storeImage(req, res, log, authorize, {
    dir: cfg.uploadDir,
    cap: cfg.maxUploadBytes,
    route: UPLOAD_ROUTE,
    cacheBytes: cfg.maxCacheBytes,
    kind: 'upload',
  });
}

/** Handle `POST /avatar`: an avatar image, stored durably (never evicted, smaller cap). */
export function handleAvatarUpload(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ServerConfig,
  log: Logger,
  authorize: (token: string | undefined) => boolean,
): Promise<void> {
  return storeImage(req, res, log, authorize, {
    dir: cfg.avatarDir,
    cap: cfg.maxAvatarBytes,
    route: AVATAR_ROUTE,
    kind: 'avatar',
  });
}

// ---------------------------------------------------------------------------
// Shared files (any type)
// ---------------------------------------------------------------------------

/** A stored file on disk: random id + a sanitized extension (`bin` when the original had
 *  none). Same shape as the image store, so the traversal-proofing is identical. */
const STORED_FILE_RE = /^[0-9a-f]{32}\.[a-z0-9]{1,12}$/;

/**
 * The extension we store a file under, taken from the original name: lowercased, letters
 * and digits only, at most 12 chars. Anything else (no extension, an odd one, a trailing
 * dot) becomes `bin`. It never reaches a `Content-Type` — every file is served as
 * `application/octet-stream` — it just keeps the store legible to an operator.
 */
function safeExt(name: string): string {
  const dot = name.lastIndexOf('.');
  const raw = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return /^[a-z0-9]{1,12}$/.test(raw) ? raw : 'bin';
}

/**
 * The original filename, made safe to hand back out: path separators and control
 * characters removed (so it can never escape a download directory or smuggle a newline
 * into a header), leading dots stripped, and capped at 128 chars. Empty input — or input
 * that sanitizes away to nothing — becomes `download`.
 */
export function safeFilename(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 128);
  return cleaned || 'download';
}

/**
 * The URL a stored file is shared under:
 *
 *     /files/<32hex>.<ext>/<bytes>/<percent-encoded original name>
 *
 * Only the first segment addresses anything on disk. The other two are display data
 * riding in the URL so a client can render a file card — name and size — from the message
 * text alone, with no extra fetch and no attachment metadata on the wire. Neither is
 * trusted when serving: the size sent to the browser is the real file's, and the name is
 * re-sanitized before it goes into a header.
 */
export function fileUrl(stored: string, bytes: number, name: string): string {
  return `${FILE_ROUTE}${stored}/${bytes}/${encodeURIComponent(safeFilename(name))}`;
}

/**
 * Stream a request body straight to `path`, enforcing `cap` as it arrives — a shared file
 * can be hundreds of MB, so it is never buffered in memory the way an image is. Resolves
 * the byte count, or null if the body ran past the cap (the partial file is removed).
 */
function streamToFile(req: IncomingMessage, path: string, cap: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(path);
    let size = 0;
    let settled = false;
    // Abandon the write and remove what was written. The unlink has to wait for the
    // stream's `close`: createWriteStream opens the fd asynchronously, so deleting
    // straight after destroy() can race the open and leave the partial file behind.
    const discard = (done: () => void) => {
      out.once('close', () => {
        void unlink(path)
          .catch(() => {})
          .then(done);
      });
      out.destroy();
    };
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > cap) {
        settled = true;
        req.resume(); // drain the rest so we can still answer 413, not reset the socket
        discard(() => resolve(null));
      } else {
        out.write(chunk);
      }
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      out.end(() => resolve(size));
    });
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      discard(() => reject(err));
    };
    req.on('error', fail);
    out.on('error', fail);
  });
}

/**
 * Handle `POST /file`: store a shared file of ANY type and return `{ url }`.
 *
 * Deliberately no type gate and no magic-byte sniff — that is the point of the feature.
 * Safety comes at the other end instead: {@link serveFile} hands every file back as an
 * opaque `application/octet-stream` attachment that a browser downloads rather than
 * renders, so an uploaded `.html`/`.svg` is inert even though it sits on our own origin.
 * The original filename arrives percent-encoded in `x-mara-filename`.
 */
export async function handleFileUpload(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ServerConfig,
  log: Logger,
  authorize: (token: string | undefined) => boolean,
): Promise<void> {
  if (req.method !== 'POST') {
    send(res, 405, 'Method not allowed');
    return;
  }
  // Reject before reading the body so an unauthorized client can't stream us 100 MB.
  if (!authorize(bearerToken(req))) {
    send(res, 401, 'Unauthorized');
    return;
  }
  const header = req.headers[FILENAME_HEADER];
  const raw = Array.isArray(header) ? header[0] : header;
  let original: string;
  try {
    original = safeFilename(decodeURIComponent(raw ?? ''));
  } catch {
    original = safeFilename(raw ?? ''); // not valid percent-encoding; take it literally
  }

  const stored = `${randomBytes(16).toString('hex')}.${safeExt(original)}`;
  const target = join(cfg.fileDir, stored);
  let bytes: number | null;
  try {
    await mkdir(cfg.fileDir, { recursive: true });
    bytes = await streamToFile(req, target, cfg.maxFileBytes);
  } catch (err) {
    log.error({ err, dir: cfg.fileDir }, 'file upload failed');
    send(res, 500, 'Could not store file');
    return;
  }
  if (bytes === null) {
    send(res, 413, `File exceeds ${Math.round(cfg.maxFileBytes / 1024 / 1024)} MB limit`);
    return;
  }
  if (bytes === 0) {
    await unlink(target).catch(() => {});
    send(res, 400, 'Empty upload');
    return;
  }
  // Trim the store to its cap now that the new file is in it (never evicting the new file
  // itself, so sharing something bigger than the whole cap still works — briefly).
  await evictToFit(cfg.fileDir, cfg.maxFilesBytes, 0, log, stored);

  const url = fileUrl(stored, bytes, original);
  log.info({ stored, bytes, name: original }, 'stored file');
  send(res, 200, JSON.stringify({ url }), 'application/json');
}

/**
 * Handle `GET /files/<stored>/<bytes>/<name>`: stream a shared file back as a download.
 *
 * The response is deliberately inert. Everything is `application/octet-stream` with
 * `Content-Disposition: attachment`, `nosniff`, and the same sandbox CSP the image store
 * uses, so no uploaded file — HTML, SVG, anything — can execute script on our origin or
 * be framed into something that does. Only the first path segment selects the file (and
 * must match our own generated shape); the size segment is ignored in favour of the real
 * file's, and the name is re-sanitized before it reaches a header.
 */
export async function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ServerConfig,
): Promise<void> {
  const path = (req.url ?? '').slice(FILE_ROUTE.length).split(/[?#]/)[0] ?? '';
  const [stored = '', , rawName = ''] = path.split('/');
  if (!STORED_FILE_RE.test(stored)) {
    send(res, 404, 'Not found'); // never one of ours — say nothing more
    return;
  }
  let name: string;
  try {
    name = safeFilename(decodeURIComponent(rawName));
  } catch {
    name = 'download';
  }
  // RFC 6266: a plain ASCII `filename` for old clients, plus `filename*` carrying the real
  // UTF-8 name. Quotes/backslashes are stripped from the ASCII form so it can't break out
  // of its own quoting; control characters are already gone (safeFilename).
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '') || 'download';
  // A well-formed id with nothing behind it is the ordinary end of a shared file's life:
  // the store rolls oldest-first, so a link in old scrollback outlives its file. Say that,
  // rather than a bare "Not found" — this text is what someone sees if they open the URL
  // directly, and clients key their own "no longer available" state off this 404.
  const gone = 'File no longer available — shared files are removed as the store fills up.';
  const file = join(cfg.fileDir, stored);
  try {
    const s = await stat(file);
    if (!s.isFile()) {
      send(res, 404, gone);
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': s.size,
      'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      // Ids are content-random and never reused, so cache aggressively.
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    });
    res.on('error', () => {});
    const stream = createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch {
    send(res, 404, gone); // the usual case: evicted out of the store
  }
}

/** Best-effort delete of a stored avatar file, given its `/avatars/<name>` URL — called
 *  when a user replaces or clears their avatar so the durable store keeps ~one file per
 *  user. Ignores anything that isn't one of our own avatar paths. */
export async function deleteAvatar(cfg: ServerConfig, url: string, log: Logger): Promise<void> {
  const name = url.startsWith(AVATAR_ROUTE) ? url.slice(AVATAR_ROUTE.length).split(/[?#]/)[0] : '';
  if (!name || !SAFE_NAME_RE.test(name)) return;
  try {
    await unlink(join(cfg.avatarDir, name));
    log.debug({ name }, 'deleted replaced avatar');
  } catch {
    /* already gone; ignore */
  }
}

/** Handle `POST /emoji-upload`: a user-contributed emoji image, stored durably under the
 *  user-emoji dir and served at `/emoji/`. Returns `{ url: '/emoji/<id>.<ext>' }`. */
export function handleEmojiUpload(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ServerConfig,
  log: Logger,
  authorize: (token: string | undefined) => boolean,
): Promise<void> {
  return storeImage(req, res, log, authorize, {
    dir: cfg.userEmojiDir,
    cap: cfg.maxEmojiBytes,
    route: EMOJI_ROUTE,
    kind: 'emoji',
  });
}

/** The `<hex>.<ext>` filename of one of our stored user-emoji images, parsed from its
 *  `/emoji/<name>` URL — or '' if the URL isn't one we issued. Our uploads have random hex
 *  names, so an operator emoji (whose file is its `:shortcode:`) never matches; this is what
 *  lets `addEmoji` accept only genuinely-uploaded images and delete only user-emoji files. */
export function userEmojiName(url: string): string {
  const name = url.startsWith(EMOJI_ROUTE)
    ? (url.slice(EMOJI_ROUTE.length).split(/[?#]/)[0] ?? '')
    : '';
  return SAFE_NAME_RE.test(name) ? name : '';
}

/** Best-effort delete of a stored user-emoji image (given its `/emoji/<name>` URL), called
 *  when its owner replaces or removes the emoji. Only ever removes our own hex-named files in
 *  the user-emoji dir — never the operator's shortcode-named emoji. */
export async function deleteUserEmoji(cfg: ServerConfig, url: string, log: Logger): Promise<void> {
  const name = userEmojiName(url);
  if (!name) return;
  try {
    await unlink(join(cfg.userEmojiDir, name));
    log.debug({ name }, 'deleted user emoji');
  } catch {
    /* already gone; ignore */
  }
}

/** Stream a stored image back, safely — shared by `/uploads/` and `/avatars/`. */
async function serveStored(
  req: IncomingMessage,
  res: ServerResponse,
  dir: string,
  route: string,
): Promise<void> {
  const name = decodeURIComponent((req.url ?? '').slice(route.length).split(/[?#]/)[0] ?? '');
  if (!SAFE_NAME_RE.test(name)) {
    send(res, 404, 'Not found');
    return;
  }
  const ext = name.slice(name.lastIndexOf('.') + 1);
  const file = join(dir, name);
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

/** Handle `GET /uploads/<name>`: stream a stored chat image. */
export function serveUpload(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ServerConfig,
): Promise<void> {
  return serveStored(req, res, cfg.uploadDir, UPLOAD_ROUTE);
}

/** Handle `GET /avatars/<name>`: stream a stored avatar. */
export function serveAvatar(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ServerConfig,
): Promise<void> {
  return serveStored(req, res, cfg.avatarDir, AVATAR_ROUTE);
}
