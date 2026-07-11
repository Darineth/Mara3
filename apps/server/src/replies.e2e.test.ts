// Replies end-to-end: a client sends only the id of the message it replies to, and the server
// broadcasts back the quoted snapshot it built itself. These tests pin the two properties that
// design exists for — a replier can't dictate what the quote says, and a quote can't reach into
// a channel they aren't in — plus what happens when the quoted message is simply gone.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClientMessage } from '@mara/protocol';
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
    motd: '',
    motdFile: '',
    defaultChannel: '',
    historyFile: '', // in-memory backlog
    userEmojiFile: '',
    identityFile: '',
    disconnectGraceMs: 0,
  };
  server = await startServer(cfg, createLogger('silent'));
  url = `ws://127.0.0.1:${server.port}/ws`;
});

afterEach(async () => {
  await server.close();
});

/** Log in, join `channel`, and return the client, its token, and the join frame (whose
 *  `history` is the backlog the joiner was handed). */
async function joined(name: string, channel = 'lobby') {
  const client = await TestClient.connect(url);
  const user = await login(client, name);
  client.send({ type: 'joinChannel', channel });
  const ch = await client.waitFor('channelJoined');
  return { client, user, channelToken: ch.channelToken, backlog: ch.history };
}

describe('replies', () => {
  it('resolves the reply into a quoted snapshot of the parent, for everyone in the channel', async () => {
    const a = await joined('alice');
    const b = await joined('bob');

    a.client.send({ type: 'chat', channelToken: a.channelToken, text: 'is the build green?' });
    const parent = await a.client.waitFor('chat');
    await b.client.waitFor('chat');

    b.client.send({
      type: 'chat',
      channelToken: b.channelToken,
      text: 'yes, just went green',
      replyTo: parent.id,
    });
    const seenByA = await a.client.waitFor('chat');

    expect(seenByA.text).toBe('yes, just went green');
    expect(seenByA.replyTo).toEqual({
      id: parent.id,
      from: a.user.token,
      name: 'alice',
      color: '#cccccc',
      kind: 'chat',
      excerpt: 'is the build green?',
    });

    a.client.close();
    b.client.close();
  });

  it("quotes the server's own copy of the parent, not anything the replier sends", async () => {
    const a = await joined('alice');
    a.client.send({ type: 'chat', channelToken: a.channelToken, text: 'the real message' });
    const parent = await a.client.waitFor('chat');

    // A hand-rolled frame trying to smuggle its own quoted author/text in alongside the id
    // (hence the cast — the typed client frame has no such fields). The schema drops them, and
    // the server rebuilds the snapshot from its own history.
    a.client.send({
      type: 'chat',
      channelToken: a.channelToken,
      text: 'reply',
      replyTo: { id: parent.id, name: 'someone else', excerpt: 'a thing they never said' },
    } as unknown as ClientMessage);
    // The bogus object fails `replyTo`'s number schema, so the frame is rejected outright...
    expect((await a.client.waitFor('error')).message).toBeTruthy();

    // ...and an honest reply quotes what the parent actually said.
    a.client.send({
      type: 'chat',
      channelToken: a.channelToken,
      text: 'reply',
      replyTo: parent.id,
    });
    const reply = await a.client.waitFor('chat');

    expect(reply.replyTo?.name).toBe('alice');
    expect(reply.replyTo?.excerpt).toBe('the real message');

    a.client.close();
  });

  it("ignores a reply to a message in a channel the replier isn't in", async () => {
    const a = await joined('alice', 'private-ish');
    const b = await joined('bob', 'lobby');

    a.client.send({ type: 'chat', channelToken: a.channelToken, text: 'secret plans' });
    const secret = await a.client.waitFor('chat');

    // bob is only in `lobby`, and ids are global — so a guessed id from another channel must
    // not resolve, or replying would leak the text of a message he can't see.
    b.client.send({
      type: 'chat',
      channelToken: b.channelToken,
      text: 'what plans?',
      replyTo: secret.id,
    });
    const reply = await b.client.waitFor('chat');

    expect(reply.text).toBe('what plans?'); // still delivered...
    expect(reply.replyTo).toBeUndefined(); // ...but quoting nothing

    a.client.close();
    b.client.close();
  });

  it('posts a reply to an unknown message as an ordinary one rather than dropping it', async () => {
    const a = await joined('alice');
    a.client.send({
      type: 'chat',
      channelToken: a.channelToken,
      text: 'replying into the void',
      replyTo: 999_999, // never existed (an aged-out parent looks the same to the server)
    });
    const reply = await a.client.waitFor('chat');

    expect(reply.text).toBe('replying into the void');
    expect(reply.replyTo).toBeUndefined();

    a.client.close();
  });

  it('flattens and truncates the quoted excerpt, and replays it in the backlog', async () => {
    const a = await joined('alice');
    const long = `line one\nline two ${'x'.repeat(400)}`;
    a.client.send({ type: 'chat', channelToken: a.channelToken, text: long });
    const parent = await a.client.waitFor('chat');

    a.client.send({
      type: 'emote',
      channelToken: a.channelToken,
      text: 'nods',
      replyTo: parent.id,
    });
    const reply = await a.client.waitFor('emote');

    const excerpt = reply.replyTo!.excerpt;
    expect(excerpt).not.toContain('\n'); // one line, whatever the original looked like
    expect(excerpt.startsWith('line one line two')).toBe(true);
    expect(excerpt.length).toBe(200);
    expect(excerpt.endsWith('…')).toBe(true);

    // A joiner gets the reply — quote and all — from the retained backlog.
    const b = await joined('bob');
    const replayed = b.backlog.find((e) => e.text === 'nods');
    expect(replayed?.replyTo?.id).toBe(parent.id);
    expect(replayed?.replyTo?.excerpt).toBe(excerpt);
    expect(replayed?.replyTo?.kind).toBe('chat');

    a.client.close();
    b.client.close();
  });
});
