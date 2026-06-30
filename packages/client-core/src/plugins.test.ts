import { get } from 'svelte/store';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, startServer, createLogger, type MaraServer } from '@mara/server';
import { createPipeline, type MaraPlugin } from '@mara/plugin-api';
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

describe('plugin pipeline integration', () => {
  it('applies preprocessOutgoing before sending (other clients see transformed text)', async () => {
    const exclaim: MaraPlugin = { name: 'exclaim', preprocessOutgoing: (t) => `${t}!` };
    const sender = makeClient('alice', { plugins: createPipeline([exclaim]) });
    const receiver = makeClient('bob');
    await connected(sender);
    await connected(receiver);

    const joined = waitEvent(sender, 'channelJoined');
    sender.joinChannel('lobby');
    const channel = await joined;
    receiver.joinChannel('lobby');
    await waitEvent(receiver, 'channelJoined');

    const got = waitEvent(receiver, 'chat');
    sender.sendChat(channel.token, 'hi there');
    const received = await got;
    expect(received.text).toBe('hi there!');

    sender.disconnect();
    receiver.disconnect();
  });

  it('applies incoming hooks before storing received text', async () => {
    const upper: MaraPlugin = { name: 'upper', postprocessText: (t) => t.toUpperCase() };
    const alice = makeClient('alice');
    const bob = makeClient('bob', { plugins: createPipeline([upper]) });
    await connected(alice);
    await connected(bob);

    alice.joinChannel('lobby');
    const aJoined = await waitEvent(alice, 'channelJoined');
    bob.joinChannel('lobby');
    await waitEvent(bob, 'channelJoined');

    const bobGot = waitEvent(bob, 'chat');
    alice.sendChat(aJoined.token, 'hello bob');
    const received = await bobGot;
    expect(received.text).toBe('HELLO BOB');

    const lines = get(bob.channelMessages).get(aJoined.token) ?? [];
    expect(lines.at(-1)?.text).toBe('HELLO BOB');

    alice.disconnect();
    bob.disconnect();
  });
});
