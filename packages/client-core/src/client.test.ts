import { get } from 'svelte/store';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
      // Announce disconnects synchronously: these tests assert the client's reaction to
      // a `userDisconnect`, not the server's grace/flap timing (which defaults to a 15s
      // hold — longer than the test timeout — and is covered by the server's own suite).
      disconnectGraceMs: 0,
      flapSettleMs: 0,
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

describe('restored PM history', () => {
  it('seeds privateMessages and the directory, reassigning line ids', () => {
    const client = makeClient('alice', {
      initialPrivateMessages: [
        {
          peer: 42,
          name: 'Bob',
          color: '#3366cc',
          lines: [
            { kind: 'chat', from: 42, text: 'hi', at: 1000 },
            { kind: 'chat', from: 1, text: 'hey back', at: 2000 },
          ],
        },
      ],
    });
    const pms = get(client.privateMessages).get(42)!;
    expect(pms.map((l) => l.text)).toEqual(['hi', 'hey back']);
    // Ids are (re)assigned locally and unique, so live lines can't collide.
    expect(new Set(pms.map((l) => l.id)).size).toBe(2);
    // The snapshot fills the directory so the offline peer's lines render.
    expect(get(client.directory).get(42)?.name).toBe('Bob');
  });
});

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

  it('pages older channel history on request, prepending and updating hasMore', async () => {
    const s = await startServer(
      {
        ...loadConfig(),
        host: '127.0.0.1',
        port: 0,
        defaultChannel: '',
        historyFile: '',
        identityFile: '',
        historyChunk: 2, // small so five messages span multiple pages
      },
      createLogger('silent'),
    );
    const u = `ws://127.0.0.1:${s.port}/ws`;
    try {
      const a = makeClient('alice', { url: u });
      await connected(a);
      const aJoined = waitEvent(a, 'channelJoined');
      a.joinChannel('lobby');
      const ch = await aJoined;
      for (const t of ['m1', 'm2', 'm3', 'm4', 'm5']) {
        const got = waitEvent(a, 'chat');
        a.sendChat(ch.token, t);
        await got;
      }

      const b = makeClient('bob', { url: u });
      await connected(b);
      const bJoined = waitEvent(b, 'channelJoined');
      b.joinChannel('lobby');
      const tok = (await bJoined).token;

      const chatTexts = () =>
        (get(b.channelMessages).get(tok) ?? []).filter((l) => l.kind === 'chat').map((l) => l.text);

      // Join seeds only the newest chunk; more is available.
      expect(chatTexts()).toEqual(['m4', 'm5']);
      expect(get(b.hasMoreHistory).get(tok)).toBe(true);

      // Paging prepends older messages without dropping the ones we already hold.
      b.requestOlderHistory(tok);
      await vi.waitFor(() => expect(chatTexts().length).toBe(4));
      expect(chatTexts()).toEqual(['m2', 'm3', 'm4', 'm5']);
      expect(get(b.hasMoreHistory).get(tok)).toBe(true);

      b.requestOlderHistory(tok);
      await vi.waitFor(() => expect(chatTexts().length).toBe(5));
      expect(chatTexts()).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
      expect(get(b.hasMoreHistory).get(tok)).toBe(false);

      a.disconnect();
      b.disconnect();
    } finally {
      await s.close();
    }
  });

  it('clears a channel to a marker and restores its backlog on request', async () => {
    const s = await startServer(
      {
        ...loadConfig(),
        host: '127.0.0.1',
        port: 0,
        defaultChannel: '',
        historyFile: '',
        identityFile: '',
        historyChunk: 10, // one page holds all the messages, so restore brings them all back
      },
      createLogger('silent'),
    );
    const u = `ws://127.0.0.1:${s.port}/ws`;
    try {
      const a = makeClient('alice', { url: u });
      await connected(a);
      const aJoined = waitEvent(a, 'channelJoined');
      a.joinChannel('lobby');
      const tok = (await aJoined).token;
      for (const t of ['m1', 'm2', 'm3']) {
        const got = waitEvent(a, 'chat');
        a.sendChat(tok, t);
        await got;
      }

      const linesOf = () => get(a.channelMessages).get(tok) ?? [];
      const chatTexts = () =>
        linesOf()
          .filter((l) => l.kind === 'chat')
          .map((l) => l.text);
      expect(chatTexts()).toEqual(['m1', 'm2', 'm3']);

      // Clear: local log collapses to a single "cleared" marker and the loader falls silent.
      a.clearChannel(tok);
      expect(linesOf().map((l) => l.kind)).toEqual(['cleared']);
      expect(chatTexts()).toEqual([]);
      expect(get(a.hasMoreHistory).get(tok)).toBe(false);

      // Restore: a cursor-less history request repopulates the backlog and drops the marker.
      a.restoreChannel(tok);
      await vi.waitFor(() => expect(chatTexts()).toEqual(['m1', 'm2', 'm3']));
      expect(linesOf().some((l) => l.kind === 'cleared')).toBe(false);

      a.disconnect();
    } finally {
      await s.close();
    }
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

  it('announces away and back as a coloured line in shared channels', async () => {
    const a = makeClient('alice');
    const b = makeClient('bob');
    await connected(a);
    const bSelf = await connected(b);
    a.joinChannel('lobby');
    const aJoin = await waitEvent(a, 'channelJoined');
    b.joinChannel('lobby');
    await waitEvent(b, 'channelJoined');
    await waitEvent(a, 'userJoinedChannel'); // a now has bob in the channel roster

    await Promise.all([waitEvent(a, 'away'), Promise.resolve(b.sendAway('lunch'))]);
    let lines = get(a.channelMessages).get(aJoin.token) ?? [];
    // The line carries the predicate as text + `from` (the renderer prepends the name).
    const awayLine = lines.find((l) => l.kind === 'away' && l.text === 'is away (lunch)');
    expect(awayLine).toBeDefined();
    expect(awayLine?.from).toBe(bSelf.token);

    await Promise.all([waitEvent(a, 'away'), Promise.resolve(b.sendAway(''))]);
    lines = get(a.channelMessages).get(aJoin.token) ?? [];
    expect(lines.some((l) => l.kind === 'away' && l.text === 'is back.')).toBe(true);

    a.disconnect();
    b.disconnect();
  });

  it('echoes outstanding away notices to someone who joins later', async () => {
    const a = makeClient('alice');
    const b = makeClient('bob');
    await connected(a);
    await connected(b);
    b.joinChannel('lobby');
    await waitEvent(b, 'channelJoined');
    // Wait for b's own away echo, so the server has recorded it before alice joins.
    await Promise.all([waitEvent(b, 'away'), Promise.resolve(b.sendAway('brb'))]);

    a.joinChannel('lobby');
    const aJoin = await waitEvent(a, 'channelJoined');
    const lines = get(a.channelMessages).get(aJoin.token) ?? [];
    expect(lines.some((l) => l.kind === 'away' && l.text === 'is away (brb)')).toBe(true);

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

    // ...and announced it via `privateMessageSent` (the server never echoes our own PM back,
    // so this is the only signal a logger gets for it).
    const aSent = waitEvent(a, 'privateMessageSent');
    a.sendPrivateMessage(bob.token, 'again');
    expect(await aSent).toEqual({ to: bob.token, text: 'again' });
    // recipient recorded the incoming line
    const bIncoming = get(b.privateMessages).get(alice.token) ?? [];
    expect(bIncoming.at(-1)?.text).toBe('secret');

    a.disconnect();
    b.disconnect();
  });

  it("mirrors a sent PM into the sender's other window", async () => {
    // Two windows of one user share an identityKey so the server multiplexes them.
    const a1 = makeClient('alice', { identityKey: 'alice-key' });
    const a2 = makeClient('alice', { identityKey: 'alice-key' });
    const b = makeClient('bob');
    const alice = await connected(a1);
    await connected(a2);
    const a1SawBob = waitEvent(a1, 'userConnect');
    await connected(b);
    const bob = await a1SawBob;

    // a1 sends; a2 (the other window) should learn of the outgoing PM via the mirror,
    // threaded under bob and surfaced as `privateMessageSent`.
    const a2Sent = waitEvent(a2, 'privateMessageSent');
    a1.sendPrivateMessage(bob.token, 'from window one');
    expect(await a2Sent).toEqual({ to: bob.token, text: 'from window one' });

    const a2Thread = get(a2.privateMessages).get(bob.token) ?? [];
    expect(a2Thread.at(-1)?.text).toBe('from window one');
    expect(a2Thread.at(-1)?.from).toBe(alice.token); // rendered as our own outgoing line

    a1.disconnect();
    a2.disconnect();
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

  it('keeps a mid-session rename across an auto-reconnect (server restart)', async () => {
    const client = makeClient('alice', { autoReconnect: true, reconnectBaseDelayMs: 50 });
    const first = await connected(client);
    expect(first.name).toBe('alice');

    // Rename mid-session and wait for the server-confirmed profile.
    const renamed = waitEvent(client, 'userProfile');
    client.setProfile({ name: 'Alice2' });
    await renamed;
    expect(get(client.self)?.name).toBe('Alice2');

    // Restart the server on the same port (it loses all session state); the client
    // auto-reconnects and re-logs in.
    const port = server.port;
    const reconnected = waitEvent(client, 'connected');
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

    // It re-logs in as the renamed identity — not the original 'alice', which the
    // restarted server no longer remembers.
    const again = await reconnected;
    expect(again.name).toBe('Alice2');
    expect(get(client.self)?.name).toBe('Alice2');

    client.disconnect();
  });
});
