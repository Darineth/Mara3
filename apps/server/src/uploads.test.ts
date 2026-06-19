import { mkdtemp, rm } from 'node:fs/promises';
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

describe('upload endpoint', () => {
  it('stores an image and serves it back', async () => {
    await start();
    const res = await upload(new Uint8Array([1, 2, 3, 4]));
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(url).toMatch(/^\/uploads\/[0-9a-f]{32}\.png$/);

    const fetched = await fetch(base + url);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get('content-type')).toBe('image/png');
    expect(fetched.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
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
    expect((await upload(new Uint8Array(2048))).status).toBe(413);
  });

  it('refuses to serve a path outside its naming scheme', async () => {
    await start();
    expect((await fetch(`${base}/uploads/..%2Fconfig.js`)).status).toBe(404);
    expect((await fetch(`${base}/uploads/nope.png`)).status).toBe(404);
  });

  it('evicts the oldest file when a new upload exceeds the cache cap', async () => {
    await start({ maxCacheBytes: 150 });
    const a = (await (await upload(new Uint8Array(100))).json()) as { url: string };
    await delay(20); // guarantee distinct mtimes
    const b = (await (await upload(new Uint8Array(100))).json()) as { url: string };

    expect((await fetch(base + a.url)).status).toBe(404); // evicted
    expect((await fetch(base + b.url)).status).toBe(200); // kept
  });
});
