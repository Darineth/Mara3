import { get } from 'svelte/store';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, startServer, createLogger, type MaraServer } from '@mara/server';
import { MaraClient } from './client.js';
import type { ClientEvents, ClientOptions, WebSocketCtor } from './types.js';

const color: ClientOptions['color'] = '#cccccc';

let server: MaraServer;
let url: string;

beforeEach(async () => {
  server = await startServer(
    {
      ...loadConfig(),
      host: '127.0.0.1',
      port: 0,
      defaultChannel: '',
      historyFile: '',
      identityFile: '',
    },
    createLogger('silent'),
  );
  url = `ws://127.0.0.1:${server.port}/ws`;
});

afterEach(async () => {
  await server.close();
});

function makeClient(name: string, opts: Partial<ClientOptions> = {}): MaraClient {
  return new MaraClient({
    url,
    name,
    color,
    webSocket: WebSocket as unknown as WebSocketCtor,
    autoReconnect: false,
    heartbeatIntervalMs: 0,
    ...opts,
  });
}

function waitEvent<K extends keyof ClientEvents>(
  client: MaraClient,
  event: K,
): Promise<ClientEvents[K]> {
  return new Promise((resolve) => client.events.once(event, resolve));
}

async function connected(client: MaraClient): Promise<ClientEvents['connected']> {
  const p = waitEvent(client, 'connected');
  client.connect();
  return p;
}

describe('handshake + session', () => {
  it('logs in and reaches active with self populated', async () => {
    const client = makeClient('alice');
    const info = await connected(client);
    expect(info.name).toBe('alice');
    expect(client.status).toBe('active');
    expect(get(client.self)?.token).toBe(info.token);
    client.disconnect();
  });

  it('disconnect() closes without reconnecting', async () => {
    const client = makeClient('alice');
    await connected(client);
    client.disconnect();
    expect(client.status).toBe('closed');
  });
});

describe('channels + chat', () => {
  it('rejoins the persisted initialChannels on a fresh connect', async () => {
    // Server has no default channel (defaultChannel: ''), so the only joins are the
    // ones the client replays from its persisted set.
    const client = makeClient('alice', { initialChannels: ['lobby', 'random'] });
    const names = new Set<string>();
    const bothJoined = new Promise<void>((resolve) => {
      client.events.on('channelJoined', (ch) => {
        names.add(ch.name);
        if (names.size === 2) resolve();
      });
    });
    client.connect();
    await bothJoined;
    expect([...names].sort()).toEqual(['lobby', 'random']);
    expect([...get(client.channels).values()].map((c) => c.name).sort()).toEqual([
      'lobby',
      'random',
    ]);
    client.disconnect();
  });

  it('tracks channel state and receives its own chat echo', async () => {
    const client = makeClient('alice');
    const me = await connected(client);

    const joined = waitEvent(client, 'channelJoined');
    client.joinChannel('lobby');
    const channel = await joined;
    expect(channel.name).toBe('lobby');
    expect(get(client.channels).get(channel.token)?.name).toBe('lobby');

    const chat = waitEvent(client, 'chat');
    client.sendChat(channel.token, 'hello');
    await chat;

    const lines = get(client.channelMessages).get(channel.token) ?? [];
    const chatLine = lines.find((l) => l.kind === 'chat');
    expect(chatLine?.text).toBe('hello');
    expect(chatLine?.from).toBe(me.token);
    client.disconnect();
  });

  it('two clients see each other join and chat', async () => {
    const a = makeClient('alice');
    const b = makeClient('bob');
    await connected(a);

    // alice learns about bob via the global userConnect broadcast
    const sawBob = waitEvent(a, 'userConnect');
    await connected(b);
    const bob = await sawBob;
    expect(bob.name).toBe('bob');
    expect(get(a.users).get(bob.token)?.name).toBe('bob');

    const aJoined = waitEvent(a, 'channelJoined');
    a.joinChannel('lobby');
    const channel = await aJoined;

    const bJoined = waitEvent(b, 'channelJoined');
    b.joinChannel('lobby');
    await bJoined;

    const bGotChat = waitEvent(b, 'chat');
    a.sendChat(channel.token, 'hi bob');
    const received = await bGotChat;
    expect(received.text).toBe('hi bob');

    a.disconnect();
    b.disconnect();
  });

  it('seeds a channel backlog into the log when a later user joins', async () => {
    const a = makeClient('alice');
    const me = await connected(a);
    const aJoined = waitEvent(a, 'channelJoined');
    a.joinChannel('lobby');
    const channel = await aJoined;
    a.sendChat(channel.token, 'earlier message');
    await waitEvent(a, 'chat');

    // bob joins after the message was sent; he only learns it via backlog.
    const b = makeClient('bob');
    await connected(b);
    const bJoined = waitEvent(b, 'channelJoined');
    b.joinChannel('lobby');
    const chB = await bJoined;

    const lines = get(b.channelMessages).get(chB.token) ?? [];
    const backlog = lines.find((l) => l.kind === 'chat' && l.text === 'earlier message');
    expect(backlog).toBeDefined();
    expect(backlog?.from).toBe(me.token);

    a.disconnect();
    b.disconnect();
  });

  it('posts a "you joined" system line when joining a channel', async () => {
    const a = makeClient('alice');
    await connected(a);
    const joined = waitEvent(a, 'channelJoined');
    a.joinChannel('lobby');
    const ch = await joined;

    const lines = get(a.channelMessages).get(ch.token) ?? [];
    expect(lines.some((l) => l.kind === 'system' && l.text === 'You joined #lobby')).toBe(true);
    a.disconnect();
  });
});

describe('presence system messages', () => {
  it('logs a system line when a user leaves a channel', async () => {
    const a = makeClient('alice');
    const b = makeClient('bob');
    await connected(a);
    await connected(b);
    a.joinChannel('lobby');
    const aJoin = await waitEvent(a, 'channelJoined');
    b.joinChannel('lobby');
    const bJoin = await waitEvent(b, 'channelJoined');

    const left = waitEvent(b, 'userLeftChannel');
    a.leaveChannel(aJoin.token);
    await left;

    const lines = get(b.channelMessages).get(bJoin.token) ?? [];
    expect(lines.some((l) => l.kind === 'system' && l.text.includes('alice left'))).toBe(true);

    a.disconnect();
    b.disconnect();
  });

  it('keeps a disconnected user in the directory so names survive', async () => {
    const a = makeClient('alice');
    const b = makeClient('bob');
    await connected(a);
    const sawBob = waitEvent(a, 'userConnect');
    await connected(b);
    const bob = await sawBob;

    expect(get(a.users).get(bob.token)?.name).toBe('bob');
    expect(get(a.directory).get(bob.token)?.name).toBe('bob');

    const gone = waitEvent(a, 'userDisconnect');
    b.disconnect();
    await gone;

    expect(get(a.users).has(bob.token)).toBe(false); // no longer online
    expect(get(a.directory).get(bob.token)?.name).toBe('bob'); // name retained
    a.disconnect();
  });

  it('logs a system line in the channel when a user disconnects', async () => {
    const a = makeClient('alice');
    const b = makeClient('bob');
    await connected(a);
    await connected(b);
    a.joinChannel('lobby');
    await waitEvent(a, 'channelJoined');
    b.joinChannel('lobby');
    const bJoin = await waitEvent(b, 'channelJoined'); // roster includes alice

    const gone = waitEvent(b, 'userDisconnect');
    a.disconnect();
    await gone;

    const lines = get(b.channelMessages).get(bJoin.token) ?? [];
    expect(lines.some((l) => l.kind === 'system' && l.text.includes('alice disconnected'))).toBe(
      true,
    );

    b.disconnect();
  });

  it('updates the roster and own self on a setProfile broadcast', async () => {
    const a = makeClient('alice');
    const b = makeClient('bob');
    const alice = await connected(a);
    await connected(b);

    const onB = waitEvent(b, 'userProfile');
    a.setProfile({ name: 'Alice2', color: '#112233' });
    const profile = await onB;
    expect(profile.token).toBe(alice.token);
    expect(profile.name).toBe('Alice2');
    expect(profile.color).toBe('#112233');

    // The broadcast upserts the (renamed) user into b's roster, and a's own self
    // reflects the applied name.
    expect(get(b.users).get(alice.token)?.name).toBe('Alice2');
    expect(get(a.self)?.name).toBe('Alice2');

    a.disconnect();
    b.disconnect();
  });
});

describe('private messages + ping', () => {
  it('records both sides of a private message', async () => {
    const a = makeClient('alice');
    const b = makeClient('bob');
    const alice = await connected(a);
    // alice (already online) learns about bob via the userConnect broadcast
    const aSawBob = waitEvent(a, 'userConnect');
    await connected(b);
    const bob = await aSawBob;

    const bGotPm = waitEvent(b, 'privateMessage');
    a.sendPrivateMessage(bob.token, 'secret');
    const pm = await bGotPm;
    expect(pm.from).toBe(alice.token);

    // sender recorded its own outgoing line
    const aOutgoing = get(a.privateMessages).get(bob.token) ?? [];
    expect(aOutgoing.at(-1)?.text).toBe('secret');
    // recipient recorded the incoming line
    const bIncoming = get(b.privateMessages).get(alice.token) ?? [];
    expect(bIncoming.at(-1)?.text).toBe('secret');

    a.disconnect();
    b.disconnect();
  });

  it('notes in the PM thread when the other party disconnects', async () => {
    const a = makeClient('alice');
    await connected(a);
    const sawBob = waitEvent(a, 'userConnect');
    const b = makeClient('bob');
    const bob = await connected(b);
    await sawBob;

    // Open a PM thread with bob.
    const bGot = waitEvent(b, 'privateMessage');
    a.sendPrivateMessage(bob.token, 'hi');
    await bGot;

    // When bob disconnects, his PM thread should show he left.
    const gone = waitEvent(a, 'userDisconnect');
    b.disconnect();
    await gone;
    const lines = get(a.privateMessages).get(bob.token) ?? [];
    expect(lines.some((l) => l.kind === 'system' && /disconnected/.test(l.text))).toBe(true);

    a.disconnect();
  });

  it('measures round-trip time on pong', async () => {
    const client = makeClient('alice');
    await connected(client);
    const pong = waitEvent(client, 'pong');
    client.ping();
    const result = await pong;
    expect(result.rtt).toBeGreaterThanOrEqual(0);
    client.disconnect();
  });
});

describe('reconnect', () => {
  it('enters reconnecting when the connection drops unexpectedly', async () => {
    const client = makeClient('alice', { autoReconnect: true, reconnectBaseDelayMs: 50 });
    await connected(client);
    const reconnecting = waitEvent(client, 'statusChanged');
    await server.close(); // drop every socket
    // wait until we observe the reconnecting status
    let status = await reconnecting;
    while (status !== 'reconnecting' && status !== 'closed') {
      status = await waitEvent(client, 'statusChanged');
    }
    expect(status).toBe('reconnecting');
    client.disconnect();
  });

  it('replaces a channel instead of duplicating it when its token changes on reconnect', async () => {
    const client = makeClient('alice', { autoReconnect: true, reconnectBaseDelayMs: 50 });
    await connected(client);

    const firstJoin = waitEvent(client, 'channelJoined');
    client.joinChannel('Main');
    const first = await firstJoin;

    // Restart the server on the same port so 'Main' is allocated a fresh token.
    const port = server.port;
    await server.close();
    server = await startServer(
      {
        ...loadConfig(),
        host: '127.0.0.1',
        port,
        defaultChannel: '',
        historyFile: '',
        identityFile: '',
      },
      createLogger('silent'),
    );

    // The client reconnects, re-logs in, and rejoins 'Main' under a new token.
    const second = await waitEvent(client, 'channelJoined');
    expect(second.token).not.toBe(first.token);

    const mains = [...get(client.channels).values()].filter((c) => c.name === 'Main');
    expect(mains).toHaveLength(1);
    expect(mains[0]?.token).toBe(second.token);

    client.disconnect();
  });
});
