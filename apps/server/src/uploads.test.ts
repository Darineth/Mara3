import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@mara/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { startServer, type MaraServer } from './server.js';

let server: MaraServer;
let dir: string;
let base: string;
let token: string; // a valid per-session upload token
let ws: WebSocket | undefined;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Log in (client speaks first) and resolve the session secret used as the upload bearer. */
function login(port: number): Promise<{ token: string; ws: WebSocket }> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    sock.on('error', reject);
    sock.on('open', () => {
      sock.send(
        JSON.stringify({
          type: 'login',
          protocol: PROTOCOL_VERSION,
          name: 'tester',
          color: '#cccccc',
        }),
      );
    });
    sock.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'welcome') resolve({ token: msg.sessionToken, ws: sock });
    });
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mara-upl-'));
});

afterEach(async () => {
  ws?.close();
  ws = undefined;
  await server?.close();
  await rm(dir, { recursive: true, force: true });
});

async function start(overrides: Partial<ReturnType<typeof loadConfig>> = {}) {
  server = await startServer(
    {
      ...loadConfig(),
      host: '127.0.0.1',
      port: 0,
      defaultChannel: '',
      historyFile: '',
      identityFile: '',
      uploadDir: dir,
      maxUploadBytes: 1024,
      maxCacheBytes: 10 * 1024,
      ...overrides,
    },
    createLogger('silent'),
  );
  base = `http://127.0.0.1:${server.port}`;
  ({ token, ws } = await login(server.port));
}

function upload(bytes: Uint8Array, type = 'image/png', auth = token) {
  return fetch(`${base}/upload`, {
    method: 'POST',
    headers: { 'content-type': type, ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
    body: bytes,
  });
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Bytes that pass the PNG magic-byte sniff, padded to `size` (>= the 8-byte signature). */
function png(size = PNG_SIG.length): Uint8Array {
  const buf = new Uint8Array(Math.max(size, PNG_SIG.length));
  buf.set(PNG_SIG);
  return buf;
}

describe('upload endpoint', () => {
  it('stores an image and serves it back', async () => {
    await start();
    const body = png(12);
    const res = await upload(body);
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(url).toMatch(/^\/uploads\/[0-9a-f]{32}\.png$/);

    const fetched = await fetch(base + url);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get('content-type')).toBe('image/png');
    expect(fetched.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(body);
  });

  it('rejects uploads without a valid session token', async () => {
    await start();
    expect((await upload(new Uint8Array([1, 2, 3, 4]), 'image/png', '')).status).toBe(401);
    expect((await upload(new Uint8Array([1, 2, 3, 4]), 'image/png', 'bogustoken')).status).toBe(
      401,
    );
  });

  it('rejects non-image and oversize uploads', async () => {
    await start();
    expect((await upload(new Uint8Array([1]), 'text/plain')).status).toBe(415);
    expect((await upload(png(2048))).status).toBe(413);
  });

  it('rejects bytes that do not match the declared image type (magic-byte sniff)', async () => {
    await start();
    // Declared image/png but the bytes are not a PNG → 415, nothing stored.
    expect((await upload(new Uint8Array([1, 2, 3, 4]), 'image/png')).status).toBe(415);
    // A real PNG signature passes.
    expect((await upload(png(16), 'image/png')).status).toBe(200);
  });

  it('refuses to serve a path outside its naming scheme', async () => {
    await start();
    expect((await fetch(`${base}/uploads/..%2Fconfig.js`)).status).toBe(404);
    expect((await fetch(`${base}/uploads/nope.png`)).status).toBe(404);
  });

  it('evicts the oldest file when a new upload exceeds the cache cap', async () => {
    await start({ maxCacheBytes: 150 });
    const a = (await (await upload(png(100))).json()) as { url: string };
    await delay(20); // guarantee distinct mtimes
    const b = (await (await upload(png(100))).json()) as { url: string };

    expect((await fetch(base + a.url)).status).toBe(404); // evicted
    expect((await fetch(base + b.url)).status).toBe(200); // kept
  });
});

// Shared files: any type, stored opaquely and always handed back as a download.
function postFile(bytes: Uint8Array, name = 'notes.txt', auth = token) {
  return fetch(`${base}/file`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-mara-filename': encodeURIComponent(name),
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
    },
    body: bytes,
  });
}

/** A file store separate from the image dir, with small caps for the tests. */
function startFiles(overrides: Partial<ReturnType<typeof loadConfig>> = {}) {
  return start({
    fileDir: join(dir, 'files'),
    maxFileBytes: 1024,
    maxFilesBytes: 4096,
    ...overrides,
  });
}

describe('file endpoint', () => {
  it('stores any file type and serves it back as an inert download', async () => {
    await startFiles();
    // Not an image, and content that WOULD be dangerous if a browser ever rendered it.
    const body = new TextEncoder().encode('<script>alert(1)</script>');
    const res = await postFile(body, 'report.html');
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(url).toMatch(/^\/files\/[0-9a-f]{32}\.html\/\d+\/report\.html$/);

    const fetched = await fetch(base + url);
    expect(fetched.status).toBe(200);
    // Opaque type + attachment disposition + nosniff: it downloads, it never renders.
    expect(fetched.headers.get('content-type')).toBe('application/octet-stream');
    expect(fetched.headers.get('content-disposition')).toContain('attachment');
    expect(fetched.headers.get('content-disposition')).toContain('filename="report.html"');
    expect(fetched.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(body);
  });

  it('carries the real byte size in the URL so a client can render it without asking', async () => {
    await startFiles();
    const { url } = (await (await postFile(new Uint8Array(300), 'data.bin')).json()) as {
      url: string;
    };
    expect(url.split('/')[3]).toBe('300');
  });

  it('rejects uploads without a valid session token', async () => {
    await startFiles();
    expect((await postFile(new Uint8Array([1]), 'a.txt', '')).status).toBe(401);
    expect((await postFile(new Uint8Array([1]), 'a.txt', 'bogustoken')).status).toBe(401);
  });

  it('rejects an oversize file and stores nothing', async () => {
    await startFiles();
    expect((await postFile(new Uint8Array(2048), 'big.bin')).status).toBe(413);
    // The partial write is cleaned up: the store is empty, so nothing was left behind.
    expect(await readdir(join(dir, 'files')).catch(() => [])).toEqual([]);
  });

  it('rejects an empty file', async () => {
    await startFiles();
    expect((await postFile(new Uint8Array(0), 'empty.txt')).status).toBe(400);
  });

  it('sanitizes a hostile filename instead of trusting it', async () => {
    await startFiles();
    const { url } = (await (
      await postFile(new Uint8Array([1, 2, 3]), '../../etc/passwd')
    ).json()) as { url: string };
    // Path separators are gone from both the stored name and the download name.
    expect(url).toMatch(/^\/files\/[0-9a-f]{32}\.[a-z0-9]{1,12}\/3\/etcpasswd$/);
    const disposition = (await fetch(base + url)).headers.get('content-disposition') ?? '';
    expect(disposition).toContain('filename="etcpasswd"');
    expect(disposition).not.toContain('..');
  });

  it('keeps a non-ASCII filename intact via filename*', async () => {
    await startFiles();
    const { url } = (await (await postFile(new Uint8Array([1]), 'résumé.pdf')).json()) as {
      url: string;
    };
    const disposition = (await fetch(base + url)).headers.get('content-disposition') ?? '';
    expect(disposition).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.pdf");
    expect(disposition).toMatch(/filename="r_sum_\.pdf"/); // ASCII fallback
  });

  it('refuses to serve a path outside its naming scheme', async () => {
    await startFiles();
    expect((await fetch(`${base}/files/..%2F..%2Fconfig.js/1/x`)).status).toBe(404);
    expect((await fetch(`${base}/files/nope.txt/1/x`)).status).toBe(404);
    expect((await fetch(`${base}/files/`)).status).toBe(404);
  });

  it('says a rolled-out file is gone, rather than a bare "not found"', async () => {
    await startFiles({ maxFilesBytes: 700 });
    const a = (await (await postFile(new Uint8Array(500), 'a.bin')).json()) as { url: string };
    await delay(20);
    await postFile(new Uint8Array(500), 'b.bin'); // evicts a

    const res = await fetch(base + a.url);
    expect(res.status).toBe(404);
    // The client keys its "no longer available" card off the status; this text is what
    // someone sees opening the URL directly, so it should explain itself.
    expect(await res.text()).toMatch(/no longer available/i);

    // A HEAD works too — that's what the client asks with before starting a download.
    expect((await fetch(base + a.url, { method: 'HEAD' })).status).toBe(404);
  });

  it('evicts the oldest file once the store passes its cap, never the new one', async () => {
    await startFiles({ maxFilesBytes: 700 });
    const a = (await (await postFile(new Uint8Array(500), 'a.bin')).json()) as { url: string };
    await delay(20); // guarantee distinct mtimes
    const b = (await (await postFile(new Uint8Array(500), 'b.bin')).json()) as { url: string };

    expect((await fetch(base + a.url)).status).toBe(404); // evicted
    expect((await fetch(base + b.url)).status).toBe(200); // kept

    // A single file bigger than the whole store survives rather than evicting itself.
    const big = (await (await postFile(new Uint8Array(900), 'big.bin')).json()) as { url: string };
    expect((await fetch(base + big.url)).status).toBe(200);
  });

  it('does not disturb the image cache (separate stores)', async () => {
    await startFiles({ maxCacheBytes: 150 });
    const img = (await (await upload(png(100))).json()) as { url: string };
    // A file far past the image cache cap lands in its own store; the image stays.
    await postFile(new Uint8Array(600), 'big.bin');
    expect((await fetch(base + img.url)).status).toBe(200);
  });
});
