/** Image upload to the Mara server's `/upload` endpoint (same origin). */

/** Content types the server accepts; mirror of the server's allow-list. */
const ACCEPTED = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
]);

/** Client-side gate matching the server allow-list, so we reject non-images before POSTing. */
export function isUploadableImage(file: File): boolean {
  return ACCEPTED.has(file.type);
}

/**
 * POST an image body to `endpoint` and return its hosted path. The path is left
 * *relative* (e.g. `/uploads/<id>.png`) on purpose: it travels in a chat message or a
 * profile and each client resolves it against the page base it loaded from, so the image
 * loads correctly regardless of how a given client reaches the server (localhost vs machine
 * name vs proxy vs a subpath). A baked-in absolute URL would force the uploader's hostname
 * onto everyone else. The endpoint is requested relative to the document base (no leading
 * slash) so it survives a subpath deployment like `https://host/mara/`.
 */
async function postImage(
  endpoint: string,
  body: BodyInit,
  contentType: string,
  token: string | null,
): Promise<string> {
  const res = await fetch(new URL(endpoint, document.baseURI), {
    method: 'POST',
    headers: {
      'content-type': contentType,
      // Authenticate the write against our live WS session.
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(detail || `Upload failed (${res.status})`);
  }
  const { url } = (await res.json()) as { url: string };
  return url;
}

/** POST a chat image to `/upload` (rolling cache) and return its hosted path. */
export function uploadImage(file: File, token: string | null): Promise<string> {
  return postImage('upload', file, file.type, token);
}

/**
 * Downscale an image to a centered `size`×`size` PNG so avatars stay light — they load in
 * every message header, so a multi-MB original would be wasteful. Crops to a square (matching
 * the round display) and re-encodes; animation (GIF) collapses to its first frame.
 */
export async function downscaleToSquare(file: File, size = 256): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - side) / 2;
  const sy = (bitmap.height - side) / 2;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not process the image');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
  bitmap.close?.();
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Could not process the image'))),
      'image/png',
    ),
  );
}

/** Downscale + POST an avatar to the durable `/avatar` endpoint; returns its hosted path. */
export async function uploadAvatar(file: File, token: string | null): Promise<string> {
  const blob = await downscaleToSquare(file, 256);
  return postImage('avatar', blob, blob.type, token);
}

/**
 * Downscale an image to fit within `max`×`max` (aspect preserved, never upscaled) and
 * re-encode as PNG — for custom emoji, which show inline in messages so they must stay small
 * and light. Returns the original bytes unchanged for a GIF (a canvas would flatten its
 * animation to the first frame).
 */
export async function downscaleToFit(file: File, max = 128): Promise<Blob> {
  if (file.type === 'image/gif') return file;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not process the image');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Could not process the image'))),
      'image/png',
    ),
  );
}

/**
 * Downscale (or, for a GIF, keep as-is) + POST a custom-emoji image to the durable
 * `/emoji-upload` endpoint; returns its hosted `/emoji/<id>` path. The caller then binds a
 * `:shortcode:` to it via `client.addEmoji`.
 */
export async function uploadEmoji(file: File, token: string | null): Promise<string> {
  const body = await downscaleToFit(file, 128);
  return postImage('emoji-upload', body, body.type, token);
}
