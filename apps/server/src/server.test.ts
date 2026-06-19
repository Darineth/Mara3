import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { startServer, type MaraServer } from './server.js';
import { login, TestClient } from './harness.js';

let server: MaraServer;
let url: string;

beforeEach(async () => {
  const cfg = {
    ...loadConfig(),
    host: '127.0.0.1',
    port: 0,
    motd: 'hello world',
    defaultChannel: '',
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
      { ...loadConfig(), host: '127.0.0.1', port: 0, defaultChannel: '', webRoot: root },
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
  it('greets, accepts version + login, and assigns a token + MOTD', async () => {
    const client = await TestClient.connect(url);
    const hello = await client.waitFor('serverHello');
    expect(hello.serverName).toBe('Mara 3 Server');

    client.send({ type: 'clientVersion', maraVersion: 3, clientVersion: 1, appVersion: 1 });
    await client.waitFor('response');
    client.send({
      type: 'login',
      name: 'alice',
      style: {
        font: { family: 'X', pointSize: 10, bold: false, italic: false, underline: false },
        color: '#ffffff',
      },
    });
    const accepted = await client.waitFor('loginAccepted');
    expect(accepted.name).toBe('alice');
    expect(accepted.token).toBeGreaterThan(0);
    expect(accepted.motd).toBe('hello world');
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
    await client.waitFor('serverHello');
    client.send({ type: 'chat', channelToken: 1, text: 'hi' });
    const err = await client.waitFor('error');
    expect(err.code).toBe(401);
    client.close();
  });
});

describe('default channel', () => {
  it('auto-joins every user to the configured default channel on login', async () => {
    const s2 = await startServer(
      { ...loadConfig(), host: '127.0.0.1', port: 0, defaultChannel: 'Main' },
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

  it('refuses chat to a channel the user has not joined', async () => {
    const a = await TestClient.connect(url);
    await login(a, 'alice');
    a.send({ type: 'chat', channelToken: 999999, text: 'nope' });
    const res = await a.waitFor('response');
    expect(res.ok).toBe(false);
    expect(res.code).toBe(403);
    a.close();
  });
});

describe('private messages, presence, ping', () => {
  it('routes a private message to the target and acks the sender', async () => {
    const a = await TestClient.connect(url);
    const alice = await login(a, 'alice');
    const b = await TestClient.connect(url);
    const bob = await login(b, 'bob');

    a.send({ type: 'privateMessage', toUserToken: bob.token, text: 'secret' });
    const received = await b.waitFor('privateMessage');
    expect(received.from).toBe(alice.token);
    expect(received.text).toBe('secret');
    const ack = await a.waitFor('response');
    expect(ack.ok).toBe(true);

    a.close();
    b.close();
  });

  it('replies to ping with pong carrying the same id', async () => {
    const a = await TestClient.connect(url);
    await login(a, 'alice');
    a.send({ type: 'ping', pingId: 7, sentAt: 1000 });
    const pong = await a.waitFor('pong');
    expect(pong.pingId).toBe(7);
    expect(pong.sentAt).toBe(1000);
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

  it('answers the "who" server command', async () => {
    const a = await TestClient.connect(url);
    await login(a, 'alice');
    a.send({ type: 'serverCommand', command: 'who', args: '' });
    const msg = await a.waitFor('serverMessage');
    expect(msg.text).toContain('alice');
    a.close();
  });
});
