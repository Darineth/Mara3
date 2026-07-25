import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isUploadableImage } from './upload.js';

/**
 * Every server-owned endpoint the client posts to has to be in the dev server's proxy
 * list, or it works in production (same origin) and 404s under `pnpm dev` (where the app
 * is served by Vite on another port). That split is easy to miss when adding an endpoint —
 * the `/file` route did exactly this — so pin it down: each path we fetch must be covered
 * by a proxied prefix.
 */
const viteConfig = readFileSync(
  fileURLToPath(new URL('../../vite.config.ts', import.meta.url)),
  'utf8',
);
const routes = /const serverRoutes = \[([\s\S]*?)\]/.exec(viteConfig)?.[1] ?? '';
const proxied = [...routes.matchAll(/'([^']+)'/g)].map((m) => m[1]);

describe('dev proxy coverage', () => {
  it.each(['upload', 'avatar', 'emoji-upload', 'file'])('proxies %s in dev', (endpoint) => {
    // Vite matches by prefix, so a route covers longer paths that start with it
    // (`upload` also serves `/uploads/…`, `file` also serves `/files/…`).
    expect(proxied.some((route) => route && endpoint.startsWith(route))).toBe(true);
  });

  it('proxies the paths uploads are served back from', () => {
    for (const served of ['uploads', 'files', 'avatars', 'emoji']) {
      expect(proxied.some((route) => route && served.startsWith(route))).toBe(true);
    }
  });
});

describe('isUploadableImage', () => {
  const file = (type: string) => new File([new Uint8Array([1])], 'x', { type });

  it('accepts the types the server hosts inline', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']) {
      expect(isUploadableImage(file(type))).toBe(true);
    }
  });

  it('sends everything else down the shared-file path, including SVG', () => {
    // SVG is deliberately not an inline image (it can carry script); as a shared file it
    // is served as an opaque download, so it is safe to accept that way.
    expect(isUploadableImage(file('image/svg+xml'))).toBe(false);
    expect(isUploadableImage(file('application/pdf'))).toBe(false);
    expect(isUploadableImage(file(''))).toBe(false);
  });
});
