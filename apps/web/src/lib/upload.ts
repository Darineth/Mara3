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
 * POST an image file to the server and return its hosted path. The path is
 * left *relative* (e.g. `/uploads/<id>.png`) on purpose: it travels in the chat
 * message and each client resolves it against the page base it loaded from, so
 * the image loads correctly regardless of how a given client reaches the server
 * (localhost vs machine name vs proxy vs a subpath). A baked-in absolute URL would
 * force the uploader's hostname onto everyone else and break cross-machine viewing.
 *
 * The endpoint itself is requested relative to the document base (`upload`, no
 * leading slash) so it survives a subpath deployment like `https://host/mara/`.
 */
export async function uploadImage(file: File, token: string | null): Promise<string> {
  const res = await fetch(new URL('upload', document.baseURI), {
    method: 'POST',
    headers: {
      'content-type': file.type,
      // Authenticate the write against our live WS session.
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: file,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(detail || `Upload failed (${res.status})`);
  }
  const { url } = (await res.json()) as { url: string };
  return url;
}
