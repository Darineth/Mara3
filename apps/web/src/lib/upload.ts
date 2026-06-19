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

export function isUploadableImage(file: File): boolean {
  return ACCEPTED.has(file.type);
}

/**
 * POST an image file to the server and return its absolute hosted URL. The URL
 * is absolute (origin-prefixed) so that when it is sent in a chat message every
 * client recognises it as an `http(s)` image and renders it inline.
 */
export async function uploadImage(file: File): Promise<string> {
  const res = await fetch('/upload', {
    method: 'POST',
    headers: { 'content-type': file.type },
    body: file,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(detail || `Upload failed (${res.status})`);
  }
  const { url } = (await res.json()) as { url: string };
  return new URL(url, window.location.origin).href;
}
