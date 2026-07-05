import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@mara/protocol';
import { loadConfig, type ServerConfig } from './config.js';
import { createLogger } from './logger.js';
import { startServer, type MaraServer } from './server.js';
import { login, TestClient } from './harness.js';

// A real 1×1 PNG (valid magic bytes so the server's sniff check passes).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let base: string;
let cfg: ServerConfig;
let server: MaraServer;
let httpBase: string;

async function boot(): Promise<void> {
  server = await startServer(cfg, createLogger('silent'));
  httpBase = `http://127.0.0.1:${server.port}`;
}
const wsUrl = () => `ws://127.0.0.1:${server.port}/ws`;

/** POST an image to the emoji upload endpoint as an authed session; returns its hosted URL. */
async function uploadEmoji(sessionToken: string, body: Buffer = PNG): Promise<Response> {
  return fetch(`${httpBase}/emoji-upload`, {
    method: 'POST',
    headers: { 'content-type': 'image/png', authorization: `Bearer ${sessionToken}` },
    body,
  });
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'mara-emoji-e2e-'));
  cfg = {
    ...loadConfig(),
    host: '127.0.0.1',
    port: 0,
    defaultChannel: '',
    motdFile: '',
    historyFile: '',
    identityFile: join(base, 'identity.json'), // persisted → stable tokens across restart
    emojiDir: join(base, 'emoji'),
    userEmojiDir: join(base, 'user-emoji'),
    // Index lives inside the image dir (matches the default), so the file-watch shares a
    // directory with image uploads — the operator-moderation test exercises that.
    userEmojiFile: join(base, 'user-emoji', 'index.json'),
    disconnectGraceMs: 0,
  };
  await boot();
});

afterEach(async () => {
  await server.close();
  rmSync(base, { recursive: true, force: true });
});

describe('user-contributed emoji', () => {
  it('uploads, binds a shortcode, and broadcasts the new set to everyone', async () => {
    const a = await TestClient.connect(wsUrl());
    const b = await TestClient.connect(wsUrl());
    const alice = await login(a, 'Alice', '#ff0000', 'key-alice');
    await login(b, 'Bob', '#00ff00', 'key-bob');

    const up = await uploadEmoji(alice.sessionToken);
    expect(up.status).toBe(200);
    const { url } = (await up.json()) as { url: string };
    expect(url).toMatch(/^\/emoji\/[0-9a-f]{32}\.png$/);

    a.send({ type: 'addEmoji', name: 'blobwave', url });

    // Both clients see the live update, with owner + adder name attached.
    for (const c of [a, b]) {
      const upd = await c.waitFor('emojiUpdate');
      const entry = upd.emoji.find((e) => e.name === 'blobwave');
      expect(entry).toMatchObject({ url, owner: alice.token, by: 'Alice' });
    }

    // The bound image is actually served back at its /emoji/ URL.
    const served = await fetch(`${httpBase}${url}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
  });

  it('lets only the owner replace or remove it', async () => {
    const a = await TestClient.connect(wsUrl());
    const b = await TestClient.connect(wsUrl());
    const alice = await login(a, 'Alice', '#ff0000', 'key-alice');
    const bob = await login(b, 'Bob', '#00ff00', 'key-bob');

    const { url } = (await (await uploadEmoji(alice.sessionToken)).json()) as { url: string };
    a.send({ type: 'addEmoji', name: 'mine', url });
    await a.waitFor('emojiUpdate');
    await b.waitFor('emojiUpdate');

    // Bob can't take the name…
    const bobUp = (await (await uploadEmoji(bob.sessionToken)).json()) as { url: string };
    b.send({ type: 'addEmoji', name: 'mine', url: bobUp.url });
    expect((await b.waitFor('error')).message).toMatch(/added by someone else/i);

    // …nor remove it.
    b.send({ type: 'removeEmoji', name: 'mine' });
    expect((await b.waitFor('error')).message).toMatch(/added by someone else/i);

    // Alice replaces her own: a new image, same shortcode → the URL changes.
    const replacement = (await (await uploadEmoji(alice.sessionToken)).json()) as { url: string };
    expect(replacement.url).not.toBe(url);
    a.send({ type: 'addEmoji', name: 'mine', url: replacement.url });
    const afterReplace = await a.waitFor('emojiUpdate');
    expect(afterReplace.emoji.find((e) => e.name === 'mine')?.url).toBe(replacement.url);

    // Alice removes it → gone for everyone.
    a.send({ type: 'removeEmoji', name: 'mine' });
    const afterRemove = await a.waitFor('emojiUpdate');
    expect(afterRemove.emoji.some((e) => e.name === 'mine')).toBe(false);
  });

  it("rejects a shortcode that shadows an operator emoji, and a URL we didn't issue", async () => {
    // Operator emoji: a file named for its shortcode in the operator dir.
    mkdirSync(cfg.emojiDir, { recursive: true });
    writeFileSync(join(cfg.emojiDir, 'official.png'), PNG);

    const a = await TestClient.connect(wsUrl());
    const alice = await login(a, 'Alice', '#ff0000', 'key-alice');
    const { url } = (await (await uploadEmoji(alice.sessionToken)).json()) as { url: string };

    a.send({ type: 'addEmoji', name: 'official', url });
    expect((await a.waitFor('error')).message).toMatch(/built-in/i);

    // A made-up image path (never uploaded) is refused.
    a.send({ type: 'addEmoji', name: 'faker', url: '/emoji/deadbeefdeadbeefdeadbeefdeadbeef.png' });
    expect((await a.waitFor('error')).message).toMatch(/could not be found/i);
  });

  it('lets an operator remove an emoji by editing the file on disk (live)', async () => {
    const a = await TestClient.connect(wsUrl());
    const alice = await login(a, 'Alice', '#ff0000', 'key-alice');
    const { url } = (await (await uploadEmoji(alice.sessionToken)).json()) as { url: string };
    a.send({ type: 'addEmoji', name: 'moderateme', url });
    await a.waitFor('emojiUpdate');

    const hex = url.slice('/emoji/'.length);
    expect(existsSync(join(cfg.userEmojiDir, hex))).toBe(true);

    // Wait until the server has persisted the add, so our edit isn't clobbered by its debounced
    // write; then the operator hand-edits the file, removing the entry.
    const persisted = () => {
      try {
        return readFileSync(cfg.userEmojiFile, 'utf8').includes('moderateme');
      } catch {
        return false; // not written yet
      }
    };
    for (let i = 0; i < 80 && !persisted(); i++) await new Promise((r) => setTimeout(r, 50));
    expect(persisted()).toBe(true);
    writeFileSync(cfg.userEmojiFile, JSON.stringify({}));

    // The removal is broadcast live to the connected client…
    const upd = await a.waitFor('emojiUpdate', 5000);
    expect(upd.emoji.some((e) => e.name === 'moderateme')).toBe(false);

    // …the orphaned image is reclaimed from disk…
    for (let i = 0; i < 60 && existsSync(join(cfg.userEmojiDir, hex)); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(existsSync(join(cfg.userEmojiDir, hex))).toBe(false);
    // …and it's no longer served at its old URL.
    expect((await fetch(`${httpBase}${url}`)).status).toBe(404);
  });

  it('persists across a restart and keeps ownership', async () => {
    const a = await TestClient.connect(wsUrl());
    const alice = await login(a, 'Alice', '#ff0000', 'key-alice');
    const { url } = (await (await uploadEmoji(alice.sessionToken)).json()) as { url: string };
    a.send({ type: 'addEmoji', name: 'persist', url });
    await a.waitFor('emojiUpdate');
    a.close();

    // Restart the server against the same data dirs.
    await server.close();
    await boot();

    // Fresh client: the persisted emoji is back in the welcome set, owner intact.
    const a2 = await TestClient.connect(wsUrl());
    a2.send({
      type: 'login',
      protocol: PROTOCOL_VERSION,
      name: 'Alice',
      color: '#ff0000',
      identityKey: 'key-alice',
    });
    const welcome = await a2.waitFor('welcome');
    // Stable identity → same token, so still the owner.
    expect(welcome.self.token).toBe(alice.token);
    expect(welcome.emoji?.find((e) => e.name === 'persist')?.owner).toBe(alice.token);

    // …and the owner can still remove it after the restart.
    a2.send({ type: 'removeEmoji', name: 'persist' });
    const upd = await a2.waitFor('emojiUpdate');
    expect(upd.emoji.some((e) => e.name === 'persist')).toBe(false);
  });
});
