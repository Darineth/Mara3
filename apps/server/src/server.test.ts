import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { PROTOCOL_VERSION } from '@mara/protocol';
import { startServer, type MaraServer } from './server.js';
import { EmojiStore } from './emoji.js';
import { login, TestClient } from './harness.js';

let server: MaraServer;
let url: string;

beforeEach(async () => {
  const cfg = {
    ...loadConfig(),
    host: '127.0.0.1',
    port: 0,
    serverName: 'Test Server',
    motd: 'hello world',
    motdFile: '', // use the inline motd above, not any MOTD.md in the working dir
    defaultChannel: '',
    historyFile: '',
    userEmojiFile: '',
    identityFile: '', // in-memory; persistence tested explicitly below
    disconnectGraceMs: 0, // announce disconnects immediately (grace tested explicitly below)
  };
  server = await startServer(cfg, createLogger('silent'));
  url = `ws://127.0.0.1:${server.port}/ws`;
});

afterEach(async () => {
  await server.close();
});

describe('http', () => {
  it('answers the health check on the shared port', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('exposes the server name and versions at /info (unauthenticated)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/info`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const info = (await res.json()) as { name: string; version: string; protocol: number };
    expect(info.name).toBe('Test Server');
    expect(typeof info.version).toBe('string');
    expect(typeof info.protocol).toBe('number');
  });

  it('serves a clear message when no web build is present', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    // 503 (no build) in CI/test, or 200 if a web build happens to exist locally.
    expect([200, 503]).toContain(res.status);
  });

  it('never caches the HTML shell but caches hashed assets immutably', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mara-web-'));
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>mara</title>');
    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'assets', 'app.abcd1234.js'), 'export default 1;');

    const s = await startServer(
      {
        ...loadConfig(),
        host: '127.0.0.1',
        port: 0,
        defaultChannel: '',
        historyFile: '',
        userEmojiFile: '',
        identityFile: '',
        webRoot: root,
      },
      createLogger('silent'),
    );
    try {
      const html = await fetch(`http://127.0.0.1:${s.port}/`);
      expect(html.headers.get('cache-control')).toBe('no-cache');
      const asset = await fetch(`http://127.0.0.1:${s.port}/assets/app.abcd1234.js`);
      expect(asset.headers.get('cache-control')).toContain('immutable');
    } finally {
      await s.close();
    }
  });
});

describe('handshake', () => {
  it('accepts login (client speaks first) and welcomes with a token + MOTD', async () => {
    const client = await TestClient.connect(url);
    client.send({ type: 'login', protocol: PROTOCOL_VERSION, name: 'alice', color: '#ffffff' });
    const welcome = await client.waitFor('welcome');
    expect(welcome.self.name).toBe('alice');
    expect(welcome.self.token).toBeGreaterThan(0);
    expect(welcome.sessionToken).toBeTruthy();
    expect(welcome.motd).toBe('hello world');
    // Version/build identity for the client to display + stale-check.
    expect(welcome.server?.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(welcome.server?.protocol).toBe(PROTOCOL_VERSION);
    client.close();
  });

  it('re-reads the MOTD file on each login, so edits apply without a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mara-motd-'));
    const file = join(dir, 'MOTD.md');
    writeFileSync(file, 'first message');
    const srv = await startServer(
      {
        ...loadConfig(),
        host: '127.0.0.1',
        port: 0,
        motd: 'fallback',
        motdFile: file,
        defaultChannel: '',
        historyFile: '',
        userEmojiFile: '',
        identityFile: '',
      },
      createLogger('silent'),
    );
    const u = `ws://127.0.0.1:${srv.port}/ws`;
    const welcomeMotd = async (name: string): Promise<string> => {
      const c = await TestClient.connect(u);
      c.send({ type: 'login', protocol: PROTOCOL_VERSION, name, color: '#ffffff' });
      const w = await c.waitFor('welcome');
      c.close();
      return w.motd;
    };
    try {
      expect(await welcomeMotd('alice')).toBe('first message');
      writeFileSync(file, 'second message'); // edited while the server keeps running
      expect(await welcomeMotd('bob')).toBe('second message');
    } finally {
      await srv.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('denies a protocol-version mismatch', async () => {
    const client = await TestClient.connect(url);
    client.send({ type: 'login', protocol: PROTOCOL_VERSION + 1, name: 'alice', color: '#ffffff' });
    const denied = await client.waitFor('loginDenied');
    expect(denied.reason).toMatch(/protocol/i);
    // Machine-readable cause so the client can auto-reload to a newer build.
    expect(denied.code).toBe('protocol');
    client.close();
  });

  it('de-duplicates a name already in use', async () => {
    const a = await TestClient.connect(url);
    await login(a, 'sam');
    const b = await TestClient.connect(url);
    const { name } = await login(b, 'sam');
    expect(name).toBe('sam2');
    a.close();
    b.close();
  });

  it('rejects a message before login', async () => {
    const client = await TestClient.connect(url);
    client.send({ type: 'chat', channelToken: 1, text: 'hi' });
    const err = await client.waitFor('error');
    expect(err.message).toMatch(/not logged in/i);
    client.close();
  });
});

describe('default channel', () => {
  it('auto-joins every user to the configured default channel on login', async () => {
    const s2 = await startServer(
      {
        ...loadConfig(),
        host: '127.0.0.1',
        port: 0,
        defaultChannel: 'Main',
        historyFile: '',
        userEmojiFile: '',
        identityFile: '',
      },
      createLogger('silent'),
    );
    try {
      const client = await TestClient.connect(`ws://127.0.0.1:${s2.port}/ws`);
      await login(client, 'alice');
      const joined = await client.waitFor('channelJoined');
      expect(joined.channel).toBe('Main');
      expect(joined.users.map((u) => u.name)).toContain('alice');
      client.close();
    } finally {
      await s2.close();
    }
  });
});

describe('setProfile (mid-session rename / recolor)', () => {
  it('broadcasts a name + colour change to others and back to the user', async () => {
    const a = await TestClient.connect(url);
    const b = await TestClient.connect(url);
    const alice = await login(a, 'alice');
    await login(b, 'bob');

    a.send({ type: 'setProfile', name: 'Alice Cooper', color: '#ff0000' });

    const onB = await b.waitFor('userProfile');
    expect(onB.user.token).toBe(alice.token);
    expect(onB.user.name).toBe('Alice Cooper');
    expect(onB.user.color).toBe('#ff0000');
    // The user gets the update too (so a deduped name reaches their own client).
    const onA = await a.waitFor('userProfile');
    expect(onA.user.name).toBe('Alice Cooper');

    a.close();
    b.close();
  });

  it('dedupes a rename to a name another user holds (suffixes it)', async () => {
    const a = await TestClient.connect(url);
    const b = await TestClient.connect(url);
    await login(a, 'alice');
    await login(b, 'bob');

    a.send({ type: 'setProfile', name: 'bob' }); // taken -> bob2
    const upd = await a.waitFor('userProfile');
    expect(upd.user.name).toBe('bob2');

    a.close();
    b.close();
  });

  it('does not clash a rename against the user’s own current name', async () => {
    const a = await TestClient.connect(url);
    await login(a, 'alice');

    a.send({ type: 'setProfile', name: 'Alice' }); // case change, otherwise free
    const upd = await a.waitFor('userProfile');
    expect(upd.user.name).toBe('Alice'); // not "Alice2"

    a.close();
  });

  it('a colour-only change keeps the name', async () => {
    const a = await TestClient.connect(url);
    await login(a, 'alice');

    a.send({ type: 'setProfile', color: '#00ff00' });
    const upd = await a.waitFor('userProfile');
    expect(upd.user.name).toBe('alice');
    expect(upd.user.color).toBe('#00ff00');

    a.close();
  });
});

describe('rate limiting (flood control)', () => {
  it('drops over-limit messages and closes a persistent flooder', async () => {
    const s2 = await startServer(
      {
        ...loadConfig(),
        host: '127.0.0.1',
        port: 0,
        defaultChannel: '',
        historyFile: '',
        userEmojiFile: '',
        identityFile: '',
        msgRate: 1, // ~no refill on the timescale of a tight send loop
        msgBurst: 3,
        msgFloodKick: 8,
      },
      createLogger('silent'),
    );
    try {
      const c = await TestClient.connect(`ws://127.0.0.1:${s2.port}/ws`);
      await login(c, 'alice');
      // Flood well past burst + kick: the server drops the excess and then closes
      // the socket with 1008 (policy violation).
      for (let i = 0; i < 40; i++) c.send({ type: 'ping', id: i });
      const close = await Promise.race([
        c.closed,
        new Promise<{ code: number }>((_, reject) =>
          setTimeout(() => reject(new Error('socket was not closed')), 2000),
        ),
      ]);
      expect(close.code).toBe(1008);
    } finally {
      await s2.close();
    }
  });

  it('does not throttle normal traffic (msgRate disabled)', async () => {
    const s2 = await startServer(
      {
        ...loadConfig(),
        host: '127.0.0.1',
        port: 0,
        defaultChannel: '',
        historyFile: '',
        userEmojiFile: '',
        identityFile: '',
        msgRate: 0, // disabled
      },
      createLogger('silent'),
    );
    try {
      const c = await TestClient.connect(`ws://127.0.0.1:${s2.port}/ws`);
      await login(c, 'alice');
      for (let i = 0; i < 50; i++) c.send({ type: 'ping', id: i });
      // All pings answered, nothing dropped or closed.
      for (let i = 0; i < 50; i++) {
        const pong = await c.waitFor('pong');
        expect(pong.id).toBeGreaterThanOrEqual(0);
      }
      c.close();
    } finally {
      await s2.close();
    }
  });
});

describe('channels and chat', () => {
  it('delivers a channel roster on join and notifies existing members', async () => {
    const a = await TestClient.connect(url);
    const alice = await login(a, 'alice');
    a.send({ type: 'joinChannel', channel: 'lobby' });
    const joinedA = await a.waitFor('channelJoined');
    expect(joinedA.channel).toBe('lobby');
    expect(joinedA.users.map((u) => u.name)).toEqual(['alice']);

    const b = await TestClient.connect(url);
    await login(b, 'bob');
    b.send({ type: 'joinChannel', channel: 'lobby' });
    const joinedB = await b.waitFor('channelJoined');
    expect(joinedB.channelToken).toBe(joinedA.channelToken);
    expect(joinedB.users.map((u) => u.name).sort()).toEqual(['alice', 'bob']);

    // alice should hear that bob joined
    const notice = await a.waitFor('userJoinedChannel');
    expect(notice.token).toBe(joinedB.users.find((u) => u.name === 'bob')!.token);
    expect(notice.channelToken).toBe(joinedA.channelToken);

    a.close();
    b.close();
  });

  it('broadcasts chat to every channel member including the sender', async () => {
    const a = await TestClient.connect(url);
    const alice = await login(a, 'alice');
    const b = await TestClient.connect(url);
    await login(b, 'bob');

    a.send({ type: 'joinChannel', channel: 'lobby' });
    const joined = await a.waitFor('channelJoined');
    b.send({ type: 'joinChannel', channel: 'lobby' });
    await b.waitFor('channelJoined');

    a.send({ type: 'chat', channelToken: joined.channelToken, text: 'hello all' });
    const onA = await a.waitFor('chat');
    const onB = await b.waitFor('chat');
    expect(onA.text).toBe('hello all');
    expect(onA.from).toBe(alice.token);
    expect(onB.text).toBe('hello all');

    a.close();
    b.close();
  });

  it('replays recent channel messages as backlog to a new joiner', async () => {
    const a = await TestClient.connect(url);
    const alice = await login(a, 'alice');
    a.send({ type: 'joinChannel', channel: 'lobby' });
    const aj = await a.waitFor('channelJoined');
    a.send({ type: 'chat', channelToken: aj.channelToken, text: 'first' });
    await a.waitFor('chat');
    a.send({ type: 'emote', channelToken: aj.channelToken, text: 'waves' });
    await a.waitFor('emote');

    const b = await TestClient.connect(url);
    await login(b, 'bob');
    b.send({ type: 'joinChannel', channel: 'lobby' });
    const bj = await b.waitFor('channelJoined');
    expect(bj.history.map((h) => h.text)).toEqual(['first', 'waves']);
    expect(bj.history.map((h) => h.kind)).toEqual(['chat', 'emote']);
    expect(bj.history.every((h) => h.from === alice.token)).toBe(true);
    expect(bj.history.every((h) => h.name === 'alice')).toBe(true);
    expect(bj.history.every((h) => typeof h.at === 'number')).toBe(true);
    // Each message carries a monotonic server id (stable identity for dedupe/paging).
    expect(bj.history[0]!.id).toBeGreaterThan(0);
    expect(bj.history[1]!.id).toBeGreaterThan(bj.history[0]!.id);

    a.close();
    b.close();
  });

  it('refuses chat to a channel the user has not joined', async () => {
    const a = await TestClient.connect(url);
    await login(a, 'alice');
    a.send({ type: 'chat', channelToken: 999999, text: 'nope' });
    const err = await a.waitFor('error');
    expect(err.message).toMatch(/not in that channel/i);
    a.close();
  });
});

describe('private messages, presence, ping', () => {
  it('routes a private message to the target', async () => {
    const a = await TestClient.connect(url);
    const alice = await login(a, 'alice');
    const b = await TestClient.connect(url);
    const bob = await login(b, 'bob');

    a.send({ type: 'privateMessage', to: bob.token, text: 'secret' });
    const received = await b.waitFor('privateMessage');
    expect(received.from).toBe(alice.token);
    expect(received.to).toBe(bob.token);
    expect(received.text).toBe('secret');

    a.close();
    b.close();
  });

  it("mirrors an outgoing PM to the sender's other windows (not the sending one)", async () => {
    // Two windows of one user (same identityKey), plus a recipient.
    const a1 = await TestClient.connect(url);
    const alice = await login(a1, 'alice', '#cccccc', 'alice-key');
    const a2 = await TestClient.connect(url);
    await login(a2, 'alice', '#cccccc', 'alice-key'); // second window multiplexes onto alice
    const b = await TestClient.connect(url);
    const bob = await login(b, 'bob');

    a1.send({ type: 'privateMessage', to: bob.token, text: 'hi bob' });

    // The recipient gets it, and so does alice's *other* window — keyed by the
    // recipient token so it threads under the same conversation.
    const [atBob, atA2] = await Promise.all([
      b.waitFor('privateMessage'),
      a2.waitFor('privateMessage'),
    ]);
    expect(atBob.from).toBe(alice.token);
    expect(atA2.from).toBe(alice.token);
    expect(atA2.to).toBe(bob.token);
    expect(atA2.text).toBe('hi bob');

    // The sending window is skipped (it renders its own line locally): a follow-up
    // PM the other way round is the next thing a1 should see, not an echo of its own.
    b.send({ type: 'privateMessage', to: alice.token, text: 'hey alice' });
    const back = await a1.waitFor('privateMessage');
    expect(back.from).toBe(bob.token);
    expect(back.text).toBe('hey alice');

    a1.close();
    a2.close();
    b.close();
  });

  it('replies to ping with pong carrying the same id', async () => {
    const a = await TestClient.connect(url);
    await login(a, 'alice');
    a.send({ type: 'ping', id: 7 });
    const pong = await a.waitFor('pong');
    expect(pong.id).toBe(7);
    a.close();
  });

  it('broadcasts away status and disconnects', async () => {
    const a = await TestClient.connect(url);
    const alice = await login(a, 'alice');
    const b = await TestClient.connect(url);
    await login(b, 'bob');

    a.send({ type: 'away', text: 'lunch' });
    const away = await b.waitFor('away');
    expect(away.token).toBe(alice.token);
    expect(away.text).toBe('lunch');

    a.close();
    const gone = await b.waitFor('userDisconnect');
    expect(gone.token).toBe(alice.token);
    b.close();
  });
});

describe('custom emoji', () => {
  function makeEmojiDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mara-emoji-'));
    writeFileSync(join(dir, 'blob.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(dir, 'wave.gif'), Buffer.from('GIF8'));
    writeFileSync(join(dir, 'Bad Name.png'), Buffer.from([0x89])); // invalid shortcode → skipped
    writeFileSync(join(dir, 'notes.txt'), 'x'); // not an image → skipped
    return dir;
  }

  it('scans a directory into a shortcode→url manifest, skipping invalid names/types', () => {
    const dir = makeEmojiDir();
    try {
      const store = new EmojiStore(dir, createLogger('silent'), 0);
      expect(store.manifest()).toEqual([
        { name: 'blob', url: '/emoji/blob.png' },
        { name: 'wave', url: '/emoji/wave.gif' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty manifest for a missing directory', () => {
    const store = new EmojiStore(
      join(tmpdir(), 'mara-emoji-nope-does-not-exist'),
      createLogger('silent'),
      0,
    );
    expect(store.manifest()).toEqual([]);
  });

  it('includes the emoji manifest in welcome and serves the files (allowlisted)', async () => {
    const dir = makeEmojiDir();
    const s = await startServer(
      {
        ...loadConfig(),
        host: '127.0.0.1',
        port: 0,
        defaultChannel: '',
        historyFile: '',
        userEmojiFile: '',
        identityFile: '',
        emojiDir: dir,
      },
      createLogger('silent'),
    );
    try {
      const c = await TestClient.connect(`ws://127.0.0.1:${s.port}/ws`);
      c.send({ type: 'login', protocol: PROTOCOL_VERSION, name: 'alice', color: '#ffffff' });
      const welcome = await c.waitFor('welcome');
      expect(welcome.emoji).toEqual([
        { name: 'blob', url: '/emoji/blob.png' },
        { name: 'wave', url: '/emoji/wave.gif' },
      ]);
      c.close();

      // The referenced file is served with its image type…
      const ok = await fetch(`http://127.0.0.1:${s.port}/emoji/blob.png`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type')).toBe('image/png');
      // …an unknown name 404s, and a disallowed extension (SVG) is refused.
      expect((await fetch(`http://127.0.0.1:${s.port}/emoji/nope.png`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${s.port}/emoji/blob.svg`)).status).toBe(404);
    } finally {
      await s.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('history pagination', () => {
  it('sends a chunk on join and pages older messages on request', async () => {
    const s = await startServer(
      {
        ...loadConfig(),
        host: '127.0.0.1',
        port: 0,
        defaultChannel: '',
        historyFile: '',
        userEmojiFile: '',
        identityFile: '',
        historyChunk: 2, // small so five messages span multiple pages
      },
      createLogger('silent'),
    );
    try {
      const wsUrl = `ws://127.0.0.1:${s.port}/ws`;
      const a = await TestClient.connect(wsUrl);
      await login(a, 'alice');
      a.send({ type: 'joinChannel', channel: 'lobby' });
      const aj = await a.waitFor('channelJoined');
      for (const t of ['m1', 'm2', 'm3', 'm4', 'm5']) {
        a.send({ type: 'chat', channelToken: aj.channelToken, text: t });
        await a.waitFor('chat');
      }

      const b = await TestClient.connect(wsUrl);
      await login(b, 'bob');
      b.send({ type: 'joinChannel', channel: 'lobby' });
      const bj = await b.waitFor('channelJoined');
      // Join delivers only the newest chunk, flagged as having more before it.
      expect(bj.history.map((h) => h.text)).toEqual(['m4', 'm5']);
      expect(bj.historyHasMore).toBe(true);

      // Page older: the two messages just before what we hold, still more remaining.
      b.send({ type: 'requestHistory', channelToken: bj.channelToken, before: bj.history[0]!.id });
      const page1 = await b.waitFor('historyChunk');
      expect(page1.channelToken).toBe(bj.channelToken);
      expect(page1.messages.map((m) => m.text)).toEqual(['m2', 'm3']);
      expect(page1.hasMore).toBe(true);

      // Page again reaches the start — no more.
      b.send({
        type: 'requestHistory',
        channelToken: bj.channelToken,
        before: page1.messages[0]!.id,
      });
      const page2 = await b.waitFor('historyChunk');
      expect(page2.messages.map((m) => m.text)).toEqual(['m1']);
      expect(page2.hasMore).toBe(false);

      a.close();
      b.close();
    } finally {
      await s.close();
    }
  });

  it('rejects a history request for a channel the session is not in', async () => {
    const c = await TestClient.connect(url);
    await login(c, 'alice');
    c.send({ type: 'requestHistory', channelToken: 999999, before: 10 });
    const err = await c.waitFor('error');
    expect(err.message).toMatch(/not in that channel/i);
    c.close();
  });
});

describe('history persistence', () => {
  it('reloads channel backlog from disk after a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mara-hist-'));
    const historyFile = join(dir, 'history.json');
    const cfg = {
      ...loadConfig(),
      host: '127.0.0.1',
      port: 0,
      defaultChannel: '',
      historyFile,
      userEmojiFile: '',
      identityFile: '',
    };

    const s1 = await startServer(cfg, createLogger('silent'));
    const a = await TestClient.connect(`ws://127.0.0.1:${s1.port}/ws`);
    await login(a, 'alice');
    a.send({ type: 'joinChannel', channel: 'lobby' });
    const aj = await a.waitFor('channelJoined');
    a.send({ type: 'chat', channelToken: aj.channelToken, text: 'persist me' });
    await a.waitFor('chat');
    a.close();
    await s1.close(); // flushes history to disk

    // A fresh server instance pointed at the same history file.
    const s2 = await startServer(cfg, createLogger('silent'));
    try {
      const b = await TestClient.connect(`ws://127.0.0.1:${s2.port}/ws`);
      await login(b, 'bob');
      b.send({ type: 'joinChannel', channel: 'lobby' });
      const bj = await b.waitFor('channelJoined');
      const entry = bj.history.find((h) => h.text === 'persist me');
      expect(entry).toBeDefined();
      expect(entry?.name).toBe('alice'); // author snapshot survived the restart
      // A message sent after the restart gets an id ABOVE the persisted one — the id
      // counter was reseeded from the reloaded history's max, not reset to zero.
      b.send({ type: 'chat', channelToken: bj.channelToken, text: 'after restart' });
      const live = await b.waitFor('chat');
      expect(live.id).toBeGreaterThan(entry!.id);
      b.close();
    } finally {
      await s2.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('identity persistence', () => {
  it('hands back the same token for an identity key, even across a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mara-id-'));
    const identityFile = join(dir, 'identity.json');
    const cfg = {
      ...loadConfig(),
      host: '127.0.0.1',
      port: 0,
      defaultChannel: '',
      historyFile: '',
      identityFile,
    };

    const s1 = await startServer(cfg, createLogger('silent'));
    const c1 = await TestClient.connect(`ws://127.0.0.1:${s1.port}/ws`);
    const first = await login(c1, 'alice', '#ffffff', 'alice-secret');
    c1.close();
    await s1.close(); // flushes the identity map to disk

    // Fresh server instance, same identity file: the same key → the same token.
    const s2 = await startServer(cfg, createLogger('silent'));
    try {
      const c2 = await TestClient.connect(`ws://127.0.0.1:${s2.port}/ws`);
      const second = await login(c2, 'alice', '#ffffff', 'alice-secret');
      expect(second.token).toBe(first.token);

      // A different key gets a different token.
      const c3 = await TestClient.connect(`ws://127.0.0.1:${s2.port}/ws`);
      const other = await login(c3, 'bob', '#00ff00', 'bob-secret');
      expect(other.token).not.toBe(first.token);
      c2.close();
      c3.close();
    } finally {
      await s2.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps an identity's name + colour across a restart, overriding a later login", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mara-id-'));
    const identityFile = join(dir, 'identity.json');
    const cfg = {
      ...loadConfig(),
      host: '127.0.0.1',
      port: 0,
      defaultChannel: '',
      historyFile: '',
      identityFile,
    };

    const s1 = await startServer(cfg, createLogger('silent'));
    const c1 = await TestClient.connect(`ws://127.0.0.1:${s1.port}/ws`);
    const first = await login(c1, 'Alice', '#112233', 'shared-key');
    c1.close();
    await s1.close(); // flushes name/colour to disk with the identity

    const s2 = await startServer(cfg, createLogger('silent'));
    try {
      // A client adopts the identity but sends a different name/colour: the stored
      // profile wins, so the identity looks identical wherever its key is used.
      const c2 = await TestClient.connect(`ws://127.0.0.1:${s2.port}/ws`);
      c2.send({
        type: 'login',
        protocol: PROTOCOL_VERSION,
        name: 'Impostor',
        color: '#ffffff',
        identityKey: 'shared-key',
      });
      const welcome = await c2.waitFor('welcome');
      expect(welcome.self.token).toBe(first.token);
      expect(welcome.self.name).toBe('Alice');
      expect(welcome.self.color).toBe('#112233');
      c2.close();
    } finally {
      await s2.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists an in-session name/colour change to the identity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mara-id-'));
    const identityFile = join(dir, 'identity.json');
    const cfg = {
      ...loadConfig(),
      host: '127.0.0.1',
      port: 0,
      defaultChannel: '',
      historyFile: '',
      identityFile,
    };

    const s1 = await startServer(cfg, createLogger('silent'));
    const c1 = await TestClient.connect(`ws://127.0.0.1:${s1.port}/ws`);
    await login(c1, 'Alice', '#112233', 'edit-key');
    c1.send({ type: 'setProfile', name: 'Alicia', color: '#445566' });
    await c1.waitFor('userProfile');
    c1.close();
    await s1.close();

    const s2 = await startServer(cfg, createLogger('silent'));
    try {
      const c2 = await TestClient.connect(`ws://127.0.0.1:${s2.port}/ws`);
      // Log in with the *original* name/colour; the persisted edit still takes over.
      c2.send({
        type: 'login',
        protocol: PROTOCOL_VERSION,
        name: 'Alice',
        color: '#112233',
        identityKey: 'edit-key',
      });
      const welcome = await c2.waitFor('welcome');
      expect(welcome.self.name).toBe('Alicia');
      expect(welcome.self.color).toBe('#445566');
      c2.close();
    } finally {
      await s2.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honours a legacy identity file that maps a key straight to a token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mara-id-'));
    const identityFile = join(dir, 'identity.json');
    // v1 on-disk format: hash(key) -> bare token number, no profile.
    const legacyToken = 4242;
    const hash = createHash('sha256').update('legacy-key').digest('hex');
    writeFileSync(identityFile, JSON.stringify({ [hash]: legacyToken }));

    const cfg = {
      ...loadConfig(),
      host: '127.0.0.1',
      port: 0,
      defaultChannel: '',
      historyFile: '',
      identityFile,
    };
    const s = await startServer(cfg, createLogger('silent'));
    try {
      const c = await TestClient.connect(`ws://127.0.0.1:${s.port}/ws`);
      c.send({
        type: 'login',
        protocol: PROTOCOL_VERSION,
        name: 'Legacy',
        color: '#abcdef',
        identityKey: 'legacy-key',
      });
      const welcome = await c.waitFor('welcome');
      // The legacy token is honoured; with no stored profile, this login seeds it.
      expect(welcome.self.token).toBe(legacyToken);
      expect(welcome.self.name).toBe('Legacy');
      expect(welcome.self.color).toBe('#abcdef');
      c.close();
    } finally {
      await s.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('multiplexed windows (same identity)', () => {
  it('treats a second window with the same identity key as the same user', async () => {
    // Bob is watching so we can assert presence (no duplicate userConnect).
    const watcher = await TestClient.connect(url);
    await login(watcher, 'bob');

    const w1 = await TestClient.connect(url);
    const first = await login(w1, 'alice', '#ffffff', 'alice-key');
    const aliceConnect = await watcher.waitFor('userConnect');
    expect(aliceConnect.user.token).toBe(first.token);

    // Second window, same identity key: same token, same display name (no "alice2").
    const w2 = await TestClient.connect(url);
    const second = await login(w2, 'alice', '#ffffff', 'alice-key');
    expect(second.token).toBe(first.token);
    expect(second.name).toBe('alice');

    // The watcher must NOT see a second connect — alice was already present.
    watcher.send({ type: 'ping', id: 1 });
    const next = await watcher.next();
    expect(next.type).toBe('pong');

    w1.close();
    w2.close();
    watcher.close();
  });

  it('syncs a freshly-opened window into the user’s current channels', async () => {
    const w1 = await TestClient.connect(url);
    await login(w1, 'alice', '#ffffff', 'alice-key');
    w1.send({ type: 'joinChannel', channel: 'lobby' });
    await w1.waitFor('channelJoined');

    // A new window for the same identity is brought up to speed automatically.
    const w2 = await TestClient.connect(url);
    await login(w2, 'alice', '#ffffff', 'alice-key');
    const synced = await w2.waitFor('channelJoined');
    expect(synced.channel).toBe('lobby');

    w1.close();
    w2.close();
  });

  it('delivers channel chat to every window of the user', async () => {
    const w1 = await TestClient.connect(url);
    await login(w1, 'alice', '#ffffff', 'alice-key');
    w1.send({ type: 'joinChannel', channel: 'lobby' });
    const joined = await w1.waitFor('channelJoined');

    const w2 = await TestClient.connect(url);
    await login(w2, 'alice', '#ffffff', 'alice-key');
    await w2.waitFor('channelJoined');

    // A message sent from window 1 echoes to BOTH windows.
    w1.send({ type: 'chat', channelToken: joined.channelToken, text: 'hello' });
    const onW1 = await w1.waitFor('chat');
    const onW2 = await w2.waitFor('chat');
    expect(onW1.text).toBe('hello');
    expect(onW2.text).toBe('hello');

    w1.close();
    w2.close();
  });

  it('stays present until the last window closes', async () => {
    const watcher = await TestClient.connect(url);
    await login(watcher, 'bob');

    const w1 = await TestClient.connect(url);
    const alice = await login(w1, 'alice', '#ffffff', 'alice-key');
    await watcher.waitFor('userConnect');
    const w2 = await TestClient.connect(url);
    await login(w2, 'alice', '#ffffff', 'alice-key');

    // Closing the first window must NOT mark alice offline — w2 is still open.
    w1.close();
    // Prove no disconnect arrives before alice actually leaves: a round-trip ping
    // would surface any buffered userDisconnect ahead of the pong.
    watcher.send({ type: 'ping', id: 2 });
    expect((await watcher.next()).type).toBe('pong');

    // Closing the last window finally announces the disconnect.
    w2.close();
    const gone = await watcher.waitFor('userDisconnect');
    expect(gone.token).toBe(alice.token);

    watcher.close();
  });
});

describe('disconnect grace period', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let graceServer: MaraServer;
  let graceUrl: string;
  const GRACE_MS = 200;

  beforeEach(async () => {
    graceServer = await startServer(
      {
        ...loadConfig(),
        host: '127.0.0.1',
        port: 0,
        defaultChannel: '',
        historyFile: '',
        userEmojiFile: '',
        identityFile: '',
        disconnectGraceMs: GRACE_MS,
      },
      createLogger('silent'),
    );
    graceUrl = `ws://127.0.0.1:${graceServer.port}/ws`;
  });

  afterEach(async () => {
    await graceServer.close();
  });

  it('suppresses leave/join churn when a user reconnects within the grace window', async () => {
    const watcher = await TestClient.connect(graceUrl);
    await login(watcher, 'bob');

    const w1 = await TestClient.connect(graceUrl);
    const alice = await login(w1, 'alice', '#ffffff', 'alice-key');
    expect((await watcher.waitFor('userConnect')).user.token).toBe(alice.token);

    // The socket drops (mobile backgrounded / network switch) then comes straight
    // back with the same identity — well inside the grace window.
    w1.close();
    await sleep(GRACE_MS / 4);
    const w2 = await TestClient.connect(graceUrl);
    const back = await login(w2, 'alice', '#ffffff', 'alice-key');
    expect(back.token).toBe(alice.token);

    // The watcher must see NEITHER a disconnect nor a fresh connect: from its point
    // of view alice never left. Wait out the original grace window, then prove the
    // channel is quiet with a ping round-trip.
    await sleep(GRACE_MS + 50);
    watcher.send({ type: 'ping', id: 1 });
    expect((await watcher.next()).type).toBe('pong');

    w2.close();
    watcher.close();
  });

  it('announces the disconnect once the grace window elapses with no reconnect', async () => {
    const watcher = await TestClient.connect(graceUrl);
    await login(watcher, 'bob');

    const w1 = await TestClient.connect(graceUrl);
    const alice = await login(w1, 'alice', '#ffffff', 'alice-key');
    await watcher.waitFor('userConnect');

    // No reconnect: the held disconnect fires after the grace window.
    w1.close();
    const gone = await watcher.waitFor('userDisconnect', GRACE_MS + 1000);
    expect(gone.token).toBe(alice.token);

    watcher.close();
  });

  it('keeps channel membership intact across a within-grace reconnect', async () => {
    const watcher = await TestClient.connect(graceUrl);
    await login(watcher, 'bob');
    watcher.send({ type: 'joinChannel', channel: 'lobby' });
    const lobby = await watcher.waitFor('channelJoined');

    const w1 = await TestClient.connect(graceUrl);
    await login(w1, 'alice', '#ffffff', 'alice-key');
    w1.send({ type: 'joinChannel', channel: 'lobby' });
    await w1.waitFor('channelJoined');
    // watcher sees alice join the channel exactly once.
    const joined = await watcher.waitFor('userJoinedChannel');
    expect(joined.channelToken).toBe(lobby.channelToken);

    // Drop + reconnect within grace: no channel leave/re-join is broadcast, and
    // alice is auto-resynced into lobby (membership was never scrubbed).
    w1.close();
    await sleep(GRACE_MS / 4);
    const w2 = await TestClient.connect(graceUrl);
    await login(w2, 'alice', '#ffffff', 'alice-key');
    const resynced = await w2.waitFor('channelJoined');
    expect(resynced.channel).toBe('lobby');

    await sleep(GRACE_MS + 50);
    watcher.send({ type: 'ping', id: 2 });
    expect((await watcher.next()).type).toBe('pong');

    w2.close();
    watcher.close();
  });
});

describe('flap damping (long-term reconnect churn)', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const BASE_GRACE = 40;
  const FLAP_SETTLE = 1500; // must comfortably exceed the warm-up cycles below
  let s: MaraServer;
  let u: string;

  beforeEach(async () => {
    s = await startServer(
      {
        ...loadConfig(),
        host: '127.0.0.1',
        port: 0,
        defaultChannel: '',
        historyFile: '',
        userEmojiFile: '',
        identityFile: '',
        disconnectGraceMs: BASE_GRACE,
        flapSettleMs: FLAP_SETTLE,
        unreliableDrops: 0, // isolate the time-windowed flap from the interaction-based flag
      },
      createLogger('silent'),
    );
    u = `ws://127.0.0.1:${s.port}/ws`;
  });
  afterEach(async () => {
    await s.close();
  });

  // Discard everything currently buffered/incoming for a client (used to ignore the
  // bounded warm-up churn before the interesting, post-damping assertions).
  async function drain(c: TestClient): Promise<void> {
    for (;;) {
      try {
        await c.next(40);
      } catch {
        return;
      }
    }
  }

  // One full connect → join lobby → drop cycle for the flapper identity. Each drop
  // (a last-window close) is what the flap detector counts.
  async function flapCycle(): Promise<void> {
    const w = await TestClient.connect(u);
    await login(w, 'flapper', '#ffffff', 'flap-key');
    w.send({ type: 'joinChannel', channel: 'lobby' });
    await w.waitFor('channelJoined');
    w.close();
  }

  it('falls silent once a user is flapping, then resumes after they participate', async () => {
    const watcher = await TestClient.connect(u);
    await login(watcher, 'bob');
    watcher.send({ type: 'joinChannel', channel: 'lobby' });
    const lobby = await watcher.waitFor('channelJoined');

    // Three drops in the window trip the flap detector (a little churn is expected
    // during this warm-up — we only care that it goes quiet afterwards).
    for (let i = 0; i < 3; i++) {
      await flapCycle();
      await sleep(BASE_GRACE + 40);
    }
    await drain(watcher);

    // Now flagged flapping: the session is held on the long window, so a reconnect
    // is a silent multiplex — bob sees no connect/join at all.
    const back = await TestClient.connect(u);
    const flapper = await login(back, 'flapper', '#ffffff', 'flap-key');
    await back.waitFor('channelJoined'); // auto-resynced into lobby by the multiplex path
    watcher.send({ type: 'ping', id: 1 });
    expect((await watcher.next()).type).toBe('pong');

    // They finally speak → participation clears the flap flag.
    back.send({ type: 'chat', channelToken: lobby.channelToken, text: 'anyone there?' });
    expect((await watcher.waitFor('chat')).text).toBe('anyone there?');

    // ...so their next real drop is announced again on the ordinary short grace.
    back.close();
    const gone = await watcher.waitFor('userDisconnect', BASE_GRACE + 1000);
    expect(gone.token).toBe(flapper.token);
    watcher.close();
  });

  it('announces one disconnect only after a flapping user stays gone past the settle window', async () => {
    const watcher = await TestClient.connect(u);
    await login(watcher, 'bob');
    watcher.send({ type: 'joinChannel', channel: 'lobby' });
    await watcher.waitFor('channelJoined');

    for (let i = 0; i < 3; i++) {
      await flapCycle();
      await sleep(BASE_GRACE + 40);
    }
    await drain(watcher);

    // Reconnect (silent multiplex), then vanish for good.
    const back = await TestClient.connect(u);
    const flapper = await login(back, 'flapper', '#ffffff', 'flap-key');
    await back.waitFor('channelJoined');
    back.close();

    // The disconnect is held for the LONG window: nothing at the short-grace mark.
    await sleep(BASE_GRACE + 60);
    watcher.send({ type: 'ping', id: 1 });
    expect((await watcher.next()).type).toBe('pong');

    // ...then exactly one disconnect once the settle window elapses.
    const gone = await watcher.waitFor('userDisconnect', FLAP_SETTLE + 1000);
    expect(gone.token).toBe(flapper.token);
    watcher.close();
  });
});

describe('unreliable-client suppression (silent join/leave churn)', () => {
  let s: MaraServer;
  let u: string;

  beforeEach(async () => {
    s = await startServer(
      {
        ...loadConfig(),
        host: '127.0.0.1',
        port: 0,
        defaultChannel: 'lobby', // both parties auto-join, so join/disconnect is visible
        historyFile: '',
        userEmojiFile: '',
        identityFile: '',
        disconnectGraceMs: 0, // finalize immediately
        flapSettleMs: 0, // isolate the interaction-based flag from the time-windowed one
        unreliableDrops: 2,
      },
      createLogger('silent'),
    );
    u = `ws://127.0.0.1:${s.port}/ws`;
  });
  afterEach(async () => {
    await s.close();
  });

  // One connect → auto-join lobby → drop cycle for the flapper identity, with no interaction.
  async function silentCycle(): Promise<void> {
    const w = await TestClient.connect(u);
    await login(w, 'star', '#cccccc', 'star-key');
    await w.waitFor('channelJoined');
    w.close();
    await w.closed;
  }

  it('mutes join/disconnect after two no-interaction cycles, until the client speaks', async () => {
    const bob = await TestClient.connect(u);
    await login(bob, 'bob');
    await bob.waitFor('channelJoined'); // bob's own lobby join

    // Two silent cycles are still announced (some churn is expected before flagging).
    await silentCycle();
    const j1 = await bob.waitFor('userJoinedChannel');
    await bob.waitFor('userDisconnect');
    await silentCycle();
    await bob.waitFor('userJoinedChannel');
    await bob.waitFor('userDisconnect');

    // Now flagged unreliable: a third silent cycle is fully muted. Prove it by connecting a
    // DIFFERENT user right after — bob's next join is that user, not the (muted) flapper.
    await silentCycle();
    const charlie = await TestClient.connect(u);
    const c = await login(charlie, 'charlie');
    const nextJoin = await bob.waitFor('userJoinedChannel');
    expect(nextJoin.token).toBe(c.token);
    expect(nextJoin.token).not.toBe(j1.token);
    charlie.close();
    await bob.waitFor('userDisconnect'); // charlie leaves (reliable → still announced)

    // The flapper reconnects (still muted) and finally SPEAKS — which reveals it: bob sees
    // its join, then its message.
    const star = await TestClient.connect(u);
    const sid = await login(star, 'star', '#cccccc', 'star-key');
    const lobby = await star.waitFor('channelJoined');
    expect(sid.token).toBe(j1.token); // same identity throughout
    star.send({ type: 'chat', channelToken: lobby.channelToken, text: 'hello at last' });
    const reveal = await bob.waitFor('userJoinedChannel');
    expect(reveal.token).toBe(j1.token);
    const msg = await bob.waitFor('chat');
    expect(msg.text).toBe('hello at last');
    expect(msg.from).toBe(j1.token);
    star.close();
    bob.close();
  });
});
