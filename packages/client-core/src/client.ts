import { get, writable, type Readable, type Writable } from 'svelte/store';
import {
  MARA_VERSION,
  safeParseServerMessage,
  type ClientMessage,
  type ServerMessage,
  type Token,
  type UserInfo,
} from '@mara/protocol';
import { Emitter } from './events.js';
import type {
  ChannelState,
  ChatLine,
  ClientEvents,
  ClientOptions,
  ConnectionState,
  WebSocketCtor,
  WebSocketLike,
} from './types.js';

interface SelfState {
  token: Token;
  name: string;
}

/**
 * The Mara client: owns the WebSocket, drives the login handshake, keeps live
 * Svelte stores of users / channels / messages, and emits typed events. Runs
 * unchanged in the browser (global WebSocket) and in Node tests (inject `ws`).
 */
export class MaraClient {
  readonly events = new Emitter<ClientEvents>();

  // Public read-only stores (UI subscribes directly).
  readonly connection: Readable<ConnectionState>;
  readonly self: Readable<SelfState | null>;
  readonly users: Readable<Map<Token, UserInfo>>;
  readonly channels: Readable<Map<Token, ChannelState>>;
  readonly channelMessages: Readable<Map<Token, ChatLine[]>>;
  readonly privateMessages: Readable<Map<Token, ChatLine[]>>;

  private readonly _connection = writable<ConnectionState>('idle');
  private readonly _self = writable<SelfState | null>(null);
  private readonly _users = writable<Map<Token, UserInfo>>(new Map());
  private readonly _channels = writable<Map<Token, ChannelState>>(new Map());
  private readonly _channelMessages = writable<Map<Token, ChatLine[]>>(new Map());
  private readonly _privateMessages = writable<Map<Token, ChatLine[]>>(new Map());

  private socket: WebSocketLike | null = null;
  private intentionalClose = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private resumeToken: string | null = null;
  private lineSeq = 0;
  private pingSeq = 0;
  private readonly pendingPings = new Map<number, number>();
  /** Channel names we intend to be in (so we can rejoin after a reconnect). */
  private readonly intendedChannels = new Set<string>();

  private readonly now: () => number;
  private readonly appVersion: number;
  private readonly autoReconnect: boolean;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly historyLimit: number;

  constructor(private readonly opts: ClientOptions) {
    this.connection = { subscribe: this._connection.subscribe };
    this.self = { subscribe: this._self.subscribe };
    this.users = { subscribe: this._users.subscribe };
    this.channels = { subscribe: this._channels.subscribe };
    this.channelMessages = { subscribe: this._channelMessages.subscribe };
    this.privateMessages = { subscribe: this._privateMessages.subscribe };

    this.now = opts.now ?? Date.now;
    this.appVersion = opts.appVersion ?? 1;
    this.autoReconnect = opts.autoReconnect ?? true;
    this.reconnectBaseDelayMs = opts.reconnectBaseDelayMs ?? 500;
    this.reconnectMaxDelayMs = opts.reconnectMaxDelayMs ?? 10_000;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 25_000;
    this.historyLimit = opts.historyLimit ?? 500;
  }

  // -- lifecycle ------------------------------------------------------------

  connect(): void {
    this.intentionalClose = false;
    this.openSocket();
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.clearTimers();
    if (get(this._connection) === 'active') this.send({ type: 'disconnect', reason: '' });
    this.socket?.close(1000, 'client disconnect');
    this.socket = null;
    this.setStatus('closed');
  }

  /** Current connection status without subscribing. */
  get status(): ConnectionState {
    return get(this._connection);
  }

  // -- senders --------------------------------------------------------------

  joinChannel(name: string): void {
    this.intendedChannels.add(name);
    this.send({ type: 'joinChannel', channel: name });
  }

  leaveChannel(channelToken: Token): void {
    const channel = get(this._channels).get(channelToken);
    if (channel) this.intendedChannels.delete(channel.name);
    this.send({ type: 'leaveChannel', channelToken });
  }

  sendChat(channelToken: Token, text: string): void {
    this.send({ type: 'chat', channelToken, text });
  }

  sendEmote(channelToken: Token, text: string): void {
    this.send({ type: 'emote', channelToken, text });
  }

  sendAway(text: string): void {
    this.send({ type: 'away', text });
  }

  sendPrivateMessage(toUserToken: Token, text: string): void {
    this.send({ type: 'privateMessage', toUserToken, text });
    // The server only echoes PMs to the recipient, so record our own outgoing line.
    const me = get(this._self);
    if (me)
      this.pushLine(this._privateMessages, toUserToken, { kind: 'chat', from: me.token, text });
  }

  updateUser(name: string, style: UserInfo['style']): void {
    this.send({ type: 'userUpdate', name, style });
  }

  queryUser(token: Token): void {
    this.send({ type: 'queryUser', token });
  }

  sendServerCommand(command: string, args = ''): void {
    this.send({ type: 'serverCommand', command, args });
  }

  ping(): void {
    const pingId = ++this.pingSeq;
    const sentAt = this.now();
    this.pendingPings.set(pingId, sentAt);
    this.send({ type: 'ping', pingId, sentAt });
  }

  private send(message: ClientMessage): void {
    this.socket?.send(JSON.stringify(message));
  }

  // -- socket plumbing ------------------------------------------------------

  private openSocket(): void {
    const Ctor = this.resolveCtor();
    this.setStatus(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');
    const ws = new Ctor(this.opts.url);
    this.socket = ws;
    ws.onopen = () => this.setStatus('authenticating');
    ws.onmessage = (ev) => this.onRaw(String(ev.data));
    ws.onerror = () => this.events.emit('error', { code: 0, message: 'socket error' });
    ws.onclose = () => this.onClose();
  }

  private resolveCtor(): WebSocketCtor {
    if (this.opts.webSocket) return this.opts.webSocket;
    const g = globalThis as { WebSocket?: WebSocketCtor };
    if (g.WebSocket) return g.WebSocket;
    throw new Error('no WebSocket implementation available; pass options.webSocket');
  }

  private onClose(): void {
    this.stopHeartbeat();
    this.socket = null;
    if (this.intentionalClose) {
      this.setStatus('closed');
      return;
    }
    if (this.status === 'denied') return;
    if (this.autoReconnect) this.scheduleReconnect();
    else this.setStatus('closed');
  }

  private scheduleReconnect(): void {
    this.setStatus('reconnecting');
    const delay = Math.min(
      this.reconnectBaseDelayMs * 2 ** this.reconnectAttempts,
      this.reconnectMaxDelayMs,
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopHeartbeat();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    if (this.heartbeatIntervalMs <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.status === 'active') this.ping();
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  // -- inbound --------------------------------------------------------------

  private onRaw(raw: string): void {
    const parsed = safeParseServerMessage(raw);
    if (!parsed.success) {
      this.events.emit('error', { code: 400, message: parsed.error.message });
      return;
    }
    this.handle(parsed.data);
  }

  private handle(msg: ServerMessage): void {
    switch (msg.type) {
      case 'serverHello':
        this.send({
          type: 'clientVersion',
          maraVersion: MARA_VERSION,
          clientVersion: MARA_VERSION,
          appVersion: this.appVersion,
        });
        return;

      case 'response':
        if (msg.ref === 'clientVersion' && msg.ok) {
          this.send({
            type: 'login',
            name: this.opts.name,
            ...(this.resumeToken ? { resumeToken: this.resumeToken } : {}),
            style: this.opts.style,
          });
        } else if (!msg.ok) {
          this.events.emit('error', { code: msg.code, message: msg.message });
        }
        return;

      case 'loginAccepted': {
        const wasReconnect = this.reconnectAttempts > 0;
        this.resumeToken = msg.resumeToken;
        this.reconnectAttempts = 0;
        this._self.set({ token: msg.token, name: msg.name });
        this.setStatus('active');
        this.startHeartbeat();
        this.events.emit('connected', { token: msg.token, name: msg.name });
        if (wasReconnect)
          for (const name of this.intendedChannels)
            this.send({ type: 'joinChannel', channel: name });
        return;
      }

      case 'loginDenied':
        this.setStatus('denied');
        this.intentionalClose = true;
        this.events.emit('loginDenied', { reason: msg.reason, updateRequired: msg.updateRequired });
        this.socket?.close(1000, 'denied');
        return;

      case 'userConnect':
        this.upsertUser(msg.user);
        this.events.emit('userConnect', msg.user);
        return;

      case 'userDisconnect':
        this.removeUser(msg.token);
        this.events.emit('userDisconnect', { token: msg.token });
        return;

      case 'userUpdate': {
        const existing = get(this._users).get(msg.token);
        const updated: UserInfo = {
          token: msg.token,
          name: msg.name,
          style: msg.style,
          away: existing?.away ?? '',
        };
        this.upsertUser(updated);
        const me = get(this._self);
        if (me && me.token === msg.token) this._self.set({ token: me.token, name: msg.name });
        this.events.emit('userUpdate', updated);
        return;
      }

      case 'channelJoined': {
        for (const user of msg.users) this.upsertUser(user);
        const channel: ChannelState = {
          token: msg.channelToken,
          name: msg.channel,
          members: new Set(msg.users.map((u) => u.token)),
        };
        this.intendedChannels.add(msg.channel);
        this._channels.update((map) => new Map(map).set(channel.token, channel));
        this.ensureLog(this._channelMessages, channel.token);
        this.events.emit('channelJoined', channel);
        return;
      }

      case 'channelLeft':
        this._channels.update((map) => {
          const next = new Map(map);
          const ch = next.get(msg.channelToken);
          if (ch) this.intendedChannels.delete(ch.name);
          next.delete(msg.channelToken);
          return next;
        });
        this.events.emit('channelLeft', { channelToken: msg.channelToken });
        return;

      case 'userJoinedChannel':
        this.mutateMembers(msg.channelToken, (m) => m.add(msg.token));
        this.systemLine(msg.channelToken, `${this.nameOf(msg.token)} joined`);
        this.events.emit('userJoinedChannel', { token: msg.token, channelToken: msg.channelToken });
        return;

      case 'userLeftChannel':
        this.systemLine(msg.channelToken, `${this.nameOf(msg.token)} left`);
        this.mutateMembers(msg.channelToken, (m) => m.delete(msg.token));
        this.events.emit('userLeftChannel', { token: msg.token, channelToken: msg.channelToken });
        return;

      case 'chat':
        this.pushLine(this._channelMessages, msg.channelToken, {
          kind: 'chat',
          from: msg.from,
          text: msg.text,
        });
        this.events.emit('chat', {
          from: msg.from,
          channelToken: msg.channelToken,
          text: msg.text,
        });
        return;

      case 'emote':
        this.pushLine(this._channelMessages, msg.channelToken, {
          kind: 'emote',
          from: msg.from,
          text: msg.text,
        });
        this.events.emit('emote', {
          from: msg.from,
          channelToken: msg.channelToken,
          text: msg.text,
        });
        return;

      case 'away': {
        const user = get(this._users).get(msg.token);
        if (user) this.upsertUser({ ...user, away: msg.text });
        this.events.emit('away', { token: msg.token, text: msg.text });
        return;
      }

      case 'privateMessage':
        this.pushLine(this._privateMessages, msg.from, {
          kind: 'chat',
          from: msg.from,
          text: msg.text,
        });
        this.events.emit('privateMessage', { from: msg.from, text: msg.text });
        return;

      case 'userInfo':
        this.upsertUser(msg.user);
        return;

      case 'serverMessage':
        this.events.emit('serverMessage', { text: msg.text });
        return;

      case 'pong': {
        const sentAt = this.pendingPings.get(msg.pingId);
        this.pendingPings.delete(msg.pingId);
        this.events.emit('pong', { pingId: msg.pingId, rtt: sentAt ? this.now() - sentAt : 0 });
        return;
      }

      case 'kicked':
        this.intentionalClose = true;
        this.setStatus('closed');
        this.events.emit('kicked', { reason: msg.reason });
        this.socket?.close(1000, 'kicked');
        return;

      case 'error':
        this.events.emit('error', { code: msg.code, message: msg.message });
        return;

      case 'pluginData':
        // Reserved for the plugin pipeline (Phase 6).
        return;
    }
  }

  // -- store helpers --------------------------------------------------------

  private setStatus(state: ConnectionState): void {
    if (get(this._connection) === state) return;
    this._connection.set(state);
    this.events.emit('statusChanged', state);
  }

  private upsertUser(user: UserInfo): void {
    this._users.update((map) => new Map(map).set(user.token, user));
  }

  private removeUser(token: Token): void {
    this._users.update((map) => {
      const next = new Map(map);
      next.delete(token);
      return next;
    });
    this._channels.update((map) => {
      const next = new Map(map);
      for (const [key, channel] of next) {
        if (channel.members.has(token)) {
          const members = new Set(channel.members);
          members.delete(token);
          next.set(key, { ...channel, members });
        }
      }
      return next;
    });
  }

  private mutateMembers(channelToken: Token, mutate: (members: Set<Token>) => void): void {
    this._channels.update((map) => {
      const channel = map.get(channelToken);
      if (!channel) return map;
      const members = new Set(channel.members);
      mutate(members);
      return new Map(map).set(channelToken, { ...channel, members });
    });
  }

  private nameOf(token: Token): string {
    return get(this._users).get(token)?.name ?? `#${token}`;
  }

  private ensureLog(store: Writable<Map<Token, ChatLine[]>>, key: Token): void {
    store.update((map) => (map.has(key) ? map : new Map(map).set(key, [])));
  }

  private systemLine(channelToken: Token, text: string): void {
    this.pushLine(this._channelMessages, channelToken, { kind: 'system', from: null, text });
  }

  private pushLine(
    store: Writable<Map<Token, ChatLine[]>>,
    key: Token,
    partial: Omit<ChatLine, 'id' | 'at'>,
  ): void {
    store.update((map) => {
      const next = new Map(map);
      const arr = next.get(key)?.slice() ?? [];
      arr.push({ id: ++this.lineSeq, at: this.now(), ...partial });
      if (arr.length > this.historyLimit) arr.splice(0, arr.length - this.historyLimit);
      next.set(key, arr);
      return next;
    });
  }
}
