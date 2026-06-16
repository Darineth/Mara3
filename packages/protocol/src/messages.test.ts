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
import type { UserInfo, UserStyle } from './primitives.js';

const style: UserStyle = {
  font: { family: 'Verdana', pointSize: 10, bold: false, italic: false, underline: false },
  color: '#3366cc',
};

const user: UserInfo = { token: 678, name: 'alice', style, away: '' };

// One fully-specified (defaults included) sample per client message type.
const clientSamples: Record<ClientMessage['type'], ClientMessage> = {
  clientVersion: { type: 'clientVersion', maraVersion: 3, clientVersion: 5, appVersion: 1 },
  login: { type: 'login', name: 'alice', resumeToken: 'abc', style },
  joinChannel: { type: 'joinChannel', channel: 'lobby' },
  leaveChannel: { type: 'leaveChannel', channelToken: 12345 },
  chat: { type: 'chat', channelToken: 12345, text: 'hello' },
  emote: { type: 'emote', channelToken: 12345, text: 'waves' },
  away: { type: 'away', text: 'brb' },
  privateMessage: { type: 'privateMessage', toUserToken: 999, text: 'psst' },
  userUpdate: { type: 'userUpdate', name: 'alice2', style },
  ping: { type: 'ping', pingId: 1, sentAt: 1700000000 },
  serverCommand: { type: 'serverCommand', command: 'kick', args: 'bob' },
  queryUser: { type: 'queryUser', token: 42 },
  disconnect: { type: 'disconnect', reason: 'bye' },
  pluginData: { type: 'pluginData', channel: 'lobby', data: { foo: 1 } },
};

const serverSamples: Record<ServerMessage['type'], ServerMessage> = {
  serverHello: { type: 'serverHello', maraVersion: 3, serverName: 'Mara 3 Server' },
  response: { type: 'response', ref: 'joinChannel', ok: true, code: 0, message: '' },
  loginAccepted: {
    type: 'loginAccepted',
    token: 678,
    name: 'alice',
    resumeToken: 'xyz',
    motd: 'Welcome',
  },
  loginDenied: { type: 'loginDenied', reason: 'name taken', updateRequired: false },
  userConnect: { type: 'userConnect', user, reconnect: false },
  userDisconnect: { type: 'userDisconnect', token: 678, reason: 'quit' },
  userUpdate: { type: 'userUpdate', token: 678, name: 'alice', style },
  channelJoined: { type: 'channelJoined', channelToken: 12345, channel: 'lobby', users: [user] },
  channelLeft: { type: 'channelLeft', channelToken: 12345 },
  userJoinedChannel: { type: 'userJoinedChannel', token: 678, channelToken: 12345 },
  userLeftChannel: { type: 'userLeftChannel', token: 678, channelToken: 12345 },
  chat: { type: 'chat', from: 678, channelToken: 12345, text: 'hello' },
  emote: { type: 'emote', from: 678, channelToken: 12345, text: 'waves' },
  away: { type: 'away', token: 678, text: 'brb' },
  privateMessage: { type: 'privateMessage', from: 678, text: 'psst' },
  pong: { type: 'pong', pingId: 1, sentAt: 1700000000, serverTime: 1700000001 },
  kicked: { type: 'kicked', reason: 'spam' },
  serverMessage: { type: 'serverMessage', text: 'server restarting' },
  userInfo: { type: 'userInfo', user },
  pluginData: { type: 'pluginData', from: 678, channelToken: 12345, data: { foo: 1 } },
  error: { type: 'error', code: 400, message: 'bad' },
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

  it('rejects an out-of-range token', () => {
    const bad = JSON.stringify({ type: 'leaveChannel', channelToken: 0x1_0000_0000 });
    expect(() => parseClientMessage(bad)).toThrow(ProtocolError);
  });

  it('rejects a malformed color', () => {
    const bad = JSON.stringify({
      type: 'login',
      name: 'a',
      style: { font: { family: 'X', pointSize: 10 }, color: 'red' },
    });
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
  it('fills optional defaults (font flags, serverCommand args)', () => {
    const parsed = parseClientMessage(
      JSON.stringify({
        type: 'login',
        name: 'a',
        style: { font: { family: 'X', pointSize: 10 }, color: '#ffffff' },
      }),
    );
    if (parsed.type !== 'login') throw new Error('unexpected');
    expect(parsed.style.font.bold).toBe(false);
    expect(parsed.style.font.italic).toBe(false);
  });
});
