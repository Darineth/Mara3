import { describe, expect, it } from 'vitest';
import {
  clientMessageSchema,
  serverMessageSchema,
  type ClientMessage,
  type ServerMessage,
} from './messages.js';
import {
  encode,
  parseClientMessage,
  parseServerMessage,
  ProtocolError,
  safeParseClientMessage,
} from './codec.js';
import type { UserInfo } from './primitives.js';

const user: UserInfo = { token: 678, name: 'alice', color: '#3366cc', away: '' };

// One fully-specified (defaults included) sample per client message type.
const clientSamples: Record<ClientMessage['type'], ClientMessage> = {
  login: { type: 'login', protocol: 1, name: 'alice', color: '#3366cc' },
  joinChannel: { type: 'joinChannel', channel: 'lobby' },
  leaveChannel: { type: 'leaveChannel', channelToken: 12345 },
  chat: { type: 'chat', channelToken: 12345, text: 'hello' },
  emote: { type: 'emote', channelToken: 12345, text: 'waves' },
  privateMessage: { type: 'privateMessage', to: 999, text: 'psst' },
  away: { type: 'away', text: 'brb' },
  requestHistory: { type: 'requestHistory', channelToken: 12345, before: 42 },
  setProfile: { type: 'setProfile', name: 'alice', color: '#3366cc' },
  ping: { type: 'ping', id: 1 },
};

const serverSamples: Record<ServerMessage['type'], ServerMessage> = {
  welcome: {
    type: 'welcome',
    self: user,
    sessionToken: 'xyz',
    motd: 'Welcome',
    emoji: [{ name: 'blob', url: '/emoji/blob.png' }],
  },
  loginDenied: { type: 'loginDenied', reason: 'name taken' },
  userConnect: { type: 'userConnect', user },
  userDisconnect: { type: 'userDisconnect', token: 678 },
  channelJoined: {
    type: 'channelJoined',
    channelToken: 12345,
    channel: 'lobby',
    users: [user],
    history: [
      {
        id: 1,
        from: 678,
        name: 'alice',
        color: '#3366cc',
        kind: 'chat',
        text: 'earlier',
        at: 1700000000,
      },
    ],
    historyHasMore: false,
  },
  channelLeft: { type: 'channelLeft', channelToken: 12345 },
  userJoinedChannel: { type: 'userJoinedChannel', token: 678, channelToken: 12345 },
  userLeftChannel: { type: 'userLeftChannel', token: 678, channelToken: 12345 },
  chat: { type: 'chat', id: 2, from: 678, channelToken: 12345, text: 'hello', at: 1700000001 },
  emote: { type: 'emote', id: 3, from: 678, channelToken: 12345, text: 'waves', at: 1700000002 },
  away: { type: 'away', token: 678, text: 'brb' },
  userProfile: { type: 'userProfile', user },
  privateMessage: { type: 'privateMessage', from: 678, to: 999, text: 'psst' },
  historyChunk: {
    type: 'historyChunk',
    channelToken: 12345,
    messages: [
      {
        id: 1,
        from: 678,
        name: 'alice',
        color: '#3366cc',
        kind: 'chat',
        text: 'old',
        at: 1699999999,
      },
    ],
    hasMore: true,
  },
  pong: { type: 'pong', id: 1 },
  error: { type: 'error', message: 'bad' },
};

describe('client messages', () => {
  it('covers every type in the union', () => {
    const unionTypes = clientMessageSchema.options.map((o) => o.shape.type.value).sort();
    expect(Object.keys(clientSamples).sort()).toEqual(unionTypes);
  });

  it.each(Object.entries(clientSamples))('round-trips %s', (_type, sample) => {
    expect(parseClientMessage(encode(sample))).toEqual(sample);
  });
});

describe('server messages', () => {
  it('covers every type in the union', () => {
    const unionTypes = serverMessageSchema.options.map((o) => o.shape.type.value).sort();
    expect(Object.keys(serverSamples).sort()).toEqual(unionTypes);
  });

  it.each(Object.entries(serverSamples))('round-trips %s', (_type, sample) => {
    expect(parseServerMessage(encode(sample))).toEqual(sample);
  });
});

describe('validation failures', () => {
  it('rejects invalid JSON', () => {
    expect(() => parseClientMessage('{not json')).toThrow(ProtocolError);
  });

  it('rejects an unknown message type', () => {
    expect(() => parseClientMessage('{"type":"nope"}')).toThrow(ProtocolError);
  });

  it('rejects a missing required field', () => {
    expect(() => parseClientMessage('{"type":"chat","channelToken":1}')).toThrow(ProtocolError);
  });

  it('rejects a non-positive token', () => {
    const bad = JSON.stringify({ type: 'leaveChannel', channelToken: 0 });
    expect(() => parseClientMessage(bad)).toThrow(ProtocolError);
  });

  it('rejects a malformed color', () => {
    const bad = JSON.stringify({ type: 'login', protocol: 1, name: 'a', color: 'red' });
    expect(() => parseClientMessage(bad)).toThrow(ProtocolError);
  });

  it('safeParse reports issues without throwing', () => {
    const result = safeParseClientMessage('{"type":"chat"}');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ProtocolError);
      expect(result.error.issues?.length).toBeGreaterThan(0);
    }
  });
});

describe('schema defaults', () => {
  it('fills optional defaults (away, motd)', () => {
    // userInfo.away defaults to "" when omitted.
    const connect = parseServerMessage(
      JSON.stringify({ type: 'userConnect', user: { token: 1, name: 'a', color: '#ffffff' } }),
    );
    if (connect.type !== 'userConnect') throw new Error('unexpected');
    expect(connect.user.away).toBe('');

    // welcome.motd defaults to "" when omitted.
    const welcome = parseServerMessage(
      JSON.stringify({
        type: 'welcome',
        self: { token: 1, name: 'a', color: '#ffffff' },
        sessionToken: 's',
      }),
    );
    if (welcome.type !== 'welcome') throw new Error('unexpected');
    expect(welcome.motd).toBe('');
    // emoji is optional (omitted here → undefined).
    expect(welcome.emoji).toBeUndefined();

    // A custom-emoji entry only accepts the shortcode charset in `name`.
    const withEmoji = parseServerMessage(
      JSON.stringify({
        type: 'welcome',
        self: { token: 1, name: 'a', color: '#ffffff' },
        sessionToken: 's',
        emoji: [{ name: 'blob_wave-2', url: '/emoji/blob.png' }],
      }),
    );
    if (withEmoji.type !== 'welcome') throw new Error('unexpected');
    expect(withEmoji.emoji?.[0]?.name).toBe('blob_wave-2');
    expect(() =>
      parseServerMessage(
        JSON.stringify({
          type: 'welcome',
          self: { token: 1, name: 'a', color: '#ffffff' },
          sessionToken: 's',
          emoji: [{ name: 'bad name!', url: '/emoji/x.png' }],
        }),
      ),
    ).toThrow();

    // channelJoined.history defaults to [] when omitted.
    const joined = parseServerMessage(
      JSON.stringify({ type: 'channelJoined', channelToken: 1, channel: 'x', users: [] }),
    );
    if (joined.type !== 'channelJoined') throw new Error('unexpected');
    expect(joined.history).toEqual([]);
  });
});
