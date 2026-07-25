// Reactions end-to-end. A reaction is a claim about who reacted, so these tests pin the
// properties that make it trustworthy — you can only ever add or remove *yourself*, only on
// a message that really exists in a channel you are really in — plus the parts that are easy
// to get subtly wrong: idempotence, the last reactor leaving, and surviving in the backlog.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_REACTIONS_PER_MESSAGE } from '@mara/protocol';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { startServer, type MaraServer } from './server.js';
import { login, TestClient } from './harness.js';

let server: MaraServer;
let url: string;

beforeEach(async () => {
  server = await startServer(
    {
      ...loadConfig(),
      host: '127.0.0.1',
      port: 0,
      motd: '',
      motdFile: '',
      defaultChannel: '',
      historyFile: '', // in-memory backlog
      userEmojiFile: '',
      identityFile: '',
      disconnectGraceMs: 0,
    },
    createLogger('silent'),
  );
  url = `ws://127.0.0.1:${server.port}/ws`;
});

afterEach(async () => {
  await server.close();
});

async function joined(name: string, channel = 'lobby') {
  const client = await TestClient.connect(url);
  const user = await login(client, name);
  client.send({ type: 'joinChannel', channel });
  const ch = await client.waitFor('channelJoined');
  return { client, user, channelToken: ch.channelToken };
}

/** Say something and resolve the id everyone will react to. */
async function say(
  a: Awaited<ReturnType<typeof joined>>,
  b: Awaited<ReturnType<typeof joined>>,
  text = 'ship it',
) {
  a.client.send({ type: 'chat', channelToken: a.channelToken, text });
  const mine = await a.client.waitFor('chat');
  await b.client.waitFor('chat');
  return mine.id;
}

/**
 * React as `who`, then drain the resulting broadcast from EVERY client in the channel —
 * the reactor included, since a reaction is echoed to the whole channel rather than to
 * everyone else. Leaving a client's copy queued makes the next `waitFor` return that stale
 * frame instead of the one under test. Resolves the reactor set as `who` saw it.
 */
async function react(
  who: Awaited<ReturnType<typeof joined>>,
  everyone: Awaited<ReturnType<typeof joined>>[],
  messageId: number,
  emoji: string,
  on: boolean,
) {
  who.client.send({ type: 'react', channelToken: who.channelToken, messageId, emoji, on });
  let seen: number[] = [];
  for (const c of everyone) {
    const frame = await c.client.waitFor('reaction');
    if (c === who) seen = frame.by;
  }
  return seen;
}

describe('reactions', () => {
  it('broadcasts the full reactor set to the channel as people react and un-react', async () => {
    const a = await joined('alice');
    const b = await joined('bob');
    const id = await say(a, b);

    const all = [a, b];
    expect(await react(a, all, id, '👍', true)).toEqual([a.user.token]);
    expect(await react(b, all, id, '👍', true)).toEqual([a.user.token, b.user.token]);

    // Taking one back leaves the other in place...
    expect(await react(a, all, id, '👍', false)).toEqual([b.user.token]);
    // ...and the last one leaving empties the emoji entirely, which is how a client knows
    // to drop the chip rather than show a zero.
    expect(await react(b, all, id, '👍', false)).toEqual([]);
  });

  it('applies the stated value, so repeats are idempotent', async () => {
    const a = await joined('alice');
    const b = await joined('bob');
    const id = await say(a, b);

    a.client.send({
      type: 'react',
      channelToken: a.channelToken,
      messageId: id,
      emoji: '🎉',
      on: true,
    });
    expect((await b.client.waitFor('reaction')).by).toEqual([a.user.token]);

    // Reacting again the same way changes nothing — no double-count, and (since nothing
    // changed) nothing to broadcast. Prove it by racing a ping past it.
    a.client.send({
      type: 'react',
      channelToken: a.channelToken,
      messageId: id,
      emoji: '🎉',
      on: true,
    });
    b.client.send({ type: 'ping', id: 1 });
    expect((await b.client.next()).type).toBe('pong');

    // Un-reacting twice is equally harmless.
    a.client.send({
      type: 'react',
      channelToken: a.channelToken,
      messageId: id,
      emoji: '🎉',
      on: false,
    });
    expect((await b.client.waitFor('reaction')).by).toEqual([]);
    a.client.send({
      type: 'react',
      channelToken: a.channelToken,
      messageId: id,
      emoji: '🎉',
      on: false,
    });
    b.client.send({ type: 'ping', id: 2 });
    expect((await b.client.next()).type).toBe('pong');
  });

  it('refuses a reaction from someone not in the channel', async () => {
    const a = await joined('alice');
    const b = await joined('bob');
    const id = await say(a, b);

    // An outsider who knows the channel token (they are global) and the message id still
    // can't reach in: membership is checked, not just the token's existence.
    const outsider = await TestClient.connect(url);
    await login(outsider, 'mallory');
    await a.client.waitFor('userConnect'); // their login is announced; drain it first
    outsider.send({
      type: 'react',
      channelToken: a.channelToken,
      messageId: id,
      emoji: '👍',
      on: true,
    });
    expect((await outsider.waitFor('error')).message).toMatch(/not in that channel/i);

    a.client.send({ type: 'ping', id: 9 });
    expect((await a.client.next()).type).toBe('pong'); // nothing was broadcast
    outsider.close();
  });

  it('refuses a reaction to a message the server does not have', async () => {
    const a = await joined('alice');
    a.client.send({
      type: 'react',
      channelToken: a.channelToken,
      messageId: 999999,
      emoji: '👍',
      on: true,
    });
    expect((await a.client.waitFor('error')).message).toMatch(/no such message/i);
  });

  it('refuses a shortcode that is not one of this server emoji', async () => {
    const a = await joined('alice');
    const b = await joined('bob');
    const id = await say(a, b);

    // Shortcode-shaped values parse fine on the wire — the server is what knows whether the
    // emoji exists. Without this, any word could be pinned under a message as "a reaction".
    a.client.send({
      type: 'react',
      channelToken: a.channelToken,
      messageId: id,
      emoji: 'nope',
      on: true,
    });
    expect((await a.client.waitFor('error')).message).toMatch(/no such emoji/i);
  });

  it('caps the distinct emoji on one message', async () => {
    const a = await joined('alice');
    const b = await joined('bob');
    const id = await say(a, b);

    // Fill the message to the cap with distinct emoji.
    const all = [a, b];
    const pool = [...'😀😁😂🤣😃😄😅😆😉😊😋😎😍😘🥰😗😙😚🙂🤗🤩🤔'];
    for (let i = 0; i < MAX_REACTIONS_PER_MESSAGE; i++) {
      await react(a, all, id, pool[i]!, true);
    }
    // One more DISTINCT emoji is refused...
    a.client.send({
      type: 'react',
      channelToken: a.channelToken,
      messageId: id,
      emoji: '🥳',
      on: true,
    });
    expect((await a.client.waitFor('error')).message).toMatch(/too many reactions/i);
    // ...but joining an emoji that's already there still works, since it adds no new entry.
    expect(await react(b, all, id, pool[0]!, true)).toEqual([a.user.token, b.user.token]);
  });

  it('replays reactions with the backlog, so a joiner sees them', async () => {
    const a = await joined('alice');
    const b = await joined('bob');
    const id = await say(a, b, 'the release is out');
    await react(a, [a, b], id, '🎉', true);

    // Someone joining later gets the reaction as part of the message itself, rather than
    // having missed the event that created it.
    const carol = await TestClient.connect(url);
    await login(carol, 'carol');
    carol.send({ type: 'joinChannel', channel: 'lobby' });
    const ch = await carol.waitFor('channelJoined');
    const line = ch.history.find((h) => h.id === id);
    expect(line?.text).toBe('the release is out');
    expect(line?.reactions).toEqual([{ emoji: '🎉', by: [a.user.token] }]);
    carol.close();
  });

  it('leaves no reactions key on a message nobody reacted to', async () => {
    const a = await joined('alice');
    const b = await joined('bob');
    const id = await say(a, b, 'just a message');

    // React and then take it back: the entry must come out as it went in, not carrying an
    // empty array that would sit in the history file forever.
    await react(a, [a, b], id, '👍', true);
    await react(a, [a, b], id, '👍', false);

    const carol = await TestClient.connect(url);
    await login(carol, 'carol');
    carol.send({ type: 'joinChannel', channel: 'lobby' });
    const ch = await carol.waitFor('channelJoined');
    expect(ch.history.find((h) => h.id === id)?.reactions).toBeUndefined();
    carol.close();
  });
});
