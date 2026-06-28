import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { PROTOCOL_VERSION } from '@mara/protocol';
import { startServer, type MaraServer } from './server.js';
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
    defaultChannel: '',
    historyFile: '',
    identityFile: '', // in-memory; persistence tested explicitly below
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

  it('denies a protocol-version mismatch', async () => {
    const client = await TestClient.connect(url);
    client.send({ type: 'login', protocol: PROTOCOL_VERSION + 1, name: 'alice', color: '#ffffff' });
    const denied = await client.waitFor('loginDenied');
    expect(denied.reason).toMatch(/protocol/i);
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
    expect(received.text).toBe('secret');

    a.close();
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
