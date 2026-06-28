import { get, writable, type Readable, type Writable } from 'svelte/store';
import {
  PROTOCOL_VERSION,
  safeParseServerMessage,
  type ChannelHistoryEntry,
  type ClientMessage,
  type ServerInfo,
  type ServerMessage,
  type Token,
  type UserInfo,
} from '@mara/protocol';
import type { TextPipeline } from '@mara/plugin-api';
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

/** Identity of the logged-in user; null until `welcome`. */
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
  /** Every user ever seen this session (never pruned) — for naming/colouring
   * historical messages and PM tabs even after the author disconnects. */
  readonly directory: Readable<Map<Token, UserInfo>>;
  readonly channels: Readable<Map<Token, ChannelState>>;
  readonly channelMessages: Readable<Map<Token, ChatLine[]>>;
  readonly privateMessages: Readable<Map<Token, ChatLine[]>>;
  /** The server's reported version + served web build, from `welcome` (null until
   *  login, or if the server is too old to send it). */
  readonly serverInfo: Readable<ServerInfo | null>;
  /** The server's message of the day from `welcome` ('' when none is set). */
  readonly motd: Readable<string>;

  private readonly _connection = writable<ConnectionState>('idle');
  private readonly _self = writable<SelfState | null>(null);
  private readonly _users = writable<Map<Token, UserInfo>>(new Map());
  private readonly _directory = writable<Map<Token, UserInfo>>(new Map());
  private readonly _channels = writable<Map<Token, ChannelState>>(new Map());
  private readonly _channelMessages = writable<Map<Token, ChatLine[]>>(new Map());
  private readonly _privateMessages = writable<Map<Token, ChatLine[]>>(new Map());
  private readonly _serverInfo = writable<ServerInfo | null>(null);
  private readonly _motd = writable('');

  private socket: WebSocketLike | null = null;
  /** Suppresses auto-reconnect when the close was caused by us (disconnect/denied). */
  private intentionalClose = false;
  /** Consecutive failed connect attempts; drives backoff and the "was this a reconnect" check. */
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Per-session secret from `welcome`; the HTTP bearer for uploads (see `sessionToken`). */
  private _sessionToken: string | null = null;
  /** Monotonic counter for ChatLine ids (stable list keys across re-renders). */
  private lineSeq = 0;
  private pingSeq = 0;
  /** pingId -> sentAt timestamp, so a matching pong can compute RTT. */
  private readonly pendingPings = new Map<number, number>();
  /** Channel names we intend to be in (so we can rejoin after a reconnect). */
  private readonly intendedChannels = new Set<string>();
  /** Channel names we've already shown a "you joined" line for this session, so
   *  a reconnect/token-churn rejoin doesn't repeat it. Cleared when we leave. */
  private readonly joinAnnounced = new Set<string>();

  private readonly pipeline: TextPipeline | undefined;
  private readonly now: () => number;
  private readonly autoReconnect: boolean;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly historyLimit: number;

  constructor(private readonly opts: ClientOptions) {
    this.connection = { subscribe: this._connection.subscribe };
    this.self = { subscribe: this._self.subscribe };
    this.users = { subscribe: this._users.subscribe };
    this.directory = { subscribe: this._directory.subscribe };
    this.channels = { subscribe: this._channels.subscribe };
    this.channelMessages = { subscribe: this._channelMessages.subscribe };
    this.privateMessages = { subscribe: this._privateMessages.subscribe };
    this.serverInfo = { subscribe: this._serverInfo.subscribe };
    this.motd = { subscribe: this._motd.subscribe };

    this.pipeline = opts.plugins;
    this.now = opts.now ?? Date.now;
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
    // Mark intentional first so the resulting onClose won't schedule a reconnect.
    this.intentionalClose = true;
    this.clearTimers();
    // No explicit "disconnect" message: closing the socket is enough — the
    // server's close handler broadcasts our departure.
    this.socket?.close(1000, 'client disconnect');
    this.socket = null;
    this.setStatus('closed');
  }

  /** Current connection status without subscribing. */
  get status(): ConnectionState {
    return get(this._connection);
  }

  /**
   * Per-session bearer token for authenticated HTTP calls to the server (e.g.
   * image uploads). Null until login completes; rotates on each (re)login.
   */
  get sessionToken(): string | null {
    return this._sessionToken;
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
    const out = this.pipeline ? this.pipeline.preprocessOutgoing(text, { channelToken }) : text;
    this.send({ type: 'chat', channelToken, text: out });
  }

  sendEmote(channelToken: Token, text: string): void {
    const out = this.pipeline ? this.pipeline.preprocessOutgoing(text, { channelToken }) : text;
    this.send({ type: 'emote', channelToken, text: out });
  }

  sendAway(text: string): void {
    this.send({ type: 'away', text });
  }

  /** Note: PM text is NOT run through the plugin pipeline (channel chat/emote only). */
  sendPrivateMessage(toUserToken: Token, text: string): void {
    this.send({ type: 'privateMessage', to: toUserToken, text });
    // The server only echoes PMs to the recipient, so record our own outgoing line.
    const me = get(this._self);
    if (me)
      this.pushLine(this._privateMessages, toUserToken, { kind: 'chat', from: me.token, text });
  }

  /** Sends a heartbeat ping; the matching pong (by id) yields RTT. */
  ping(): void {
    const id = ++this.pingSeq;
    this.pendingPings.set(id, this.now());
    this.send({ type: 'ping', id });
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
    // The client speaks first: as soon as the transport is up, send `login` and
    // enter 'authenticating' until the server replies `welcome`/`loginDenied`.
    ws.onopen = () => {
      this.setStatus('authenticating');
      this.send({
        type: 'login',
        protocol: PROTOCOL_VERSION,
        name: this.opts.name,
        color: this.opts.color,
        ...(this.opts.identityKey ? { identityKey: this.opts.identityKey } : {}),
      });
    };
    ws.onmessage = (ev) => this.onRaw(String(ev.data));
    ws.onerror = () => this.events.emit('error', { message: 'socket error' });
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
    // Auth was rejected: leave status as 'denied' and do not retry (credentials
    // won't improve on a reconnect; the close here is the server hanging up).
    if (this.status === 'denied') return;
    if (this.autoReconnect) this.scheduleReconnect();
    else this.setStatus('closed');
  }

  private scheduleReconnect(): void {
    this.setStatus('reconnecting');
    // Exponential backoff: base * 2^attempts, clamped to max. attempts also
    // doubles as the "did we reconnect?" flag read on loginAccepted (for rejoin).
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
    // Idempotent: clear any prior timer first so a re-login can't stack intervals.
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
    // Zod-validate every frame at the trust boundary; malformed input surfaces
    // as an error event (code 400) instead of throwing deeper in a handler.
    const parsed = safeParseServerMessage(raw);
    if (!parsed.success) {
      this.events.emit('error', { message: parsed.error.message });
      return;
    }
    try {
      this.handle(parsed.data);
    } catch (err) {
      // A handler bug (e.g. a misbehaving plugin) must not kill the socket.
      this.events.emit('error', { message: err instanceof Error ? err.message : String(err) });
    }
  }

  private handle(msg: ServerMessage): void {
    switch (msg.type) {
      case 'welcome': {
        // Capture reconnect-ness before resetting attempts, so we know whether
        // to re-join channels below.
        const wasReconnect = this.reconnectAttempts > 0;
        this._sessionToken = msg.sessionToken; // HTTP bearer (see `sessionToken`)
        this._serverInfo.set(msg.server ?? null);
        this._motd.set(msg.motd ?? '');
        this.reconnectAttempts = 0;
        this._self.set({ token: msg.self.token, name: msg.self.name });
        // Seed our own roster/directory entry (colour, away) from `self`.
        this.upsertUser(msg.self);
        this.setStatus('active');
        this.startHeartbeat();
        this.events.emit('connected', { token: msg.self.token, name: msg.self.name });
        // On a reconnect the server doesn't restore our channel membership, so
        // re-join everything we intended to be in. channelJoined then reconciles
        // any reassigned tokens (see below).
        if (wasReconnect)
          for (const name of this.intendedChannels)
            this.send({ type: 'joinChannel', channel: name });
        return;
      }

      case 'loginDenied':
        // Terminal: mark intentional so onClose won't auto-reconnect into the
        // same rejection (e.g. protocol mismatch).
        this.setStatus('denied');
        this.intentionalClose = true;
        this.events.emit('loginDenied', { reason: msg.reason });
        this.socket?.close(1000, 'denied');
        return;

      case 'userConnect':
        this.upsertUser(msg.user);
        this.events.emit('userConnect', msg.user);
        return;

      case 'userDisconnect': {
        // Note the disconnect in each channel the user was in (capture the name
        // before removing them, then drop them from every channel/roster).
        const name = this.nameOf(msg.token);
        for (const [channelToken, channel] of get(this._channels)) {
          if (channel.members.has(msg.token)) this.systemLine(channelToken, `${name} disconnected`);
        }
        // Also note it in any private conversation with them, so a PM clearly
        // shows the other party left.
        if (get(this._privateMessages).has(msg.token)) {
          this.pushLine(this._privateMessages, msg.token, {
            kind: 'system',
            from: null,
            text: `${name} disconnected`,
          });
        }
        this.removeUser(msg.token);
        this.events.emit('userDisconnect', { token: msg.token });
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

        // The server may reassign a channel a new token (e.g. after a restart).
        // Replace any stale entry for the same name so it can't pile up in the
        // sidebar, carrying its message history over to the new token.
        let staleToken: Token | undefined;
        for (const [tok, ch] of get(this._channels)) {
          if (tok !== channel.token && ch.name === channel.name) {
            staleToken = tok;
            break;
          }
        }
        this._channels.update((map) => {
          const next = new Map(map);
          if (staleToken !== undefined) next.delete(staleToken);
          return next.set(channel.token, channel);
        });
        if (staleToken !== undefined) {
          this.migrateLog(this._channelMessages, staleToken, channel.token);
          this.events.emit('channelLeft', { channelToken: staleToken });
        }
        this.ensureLog(this._channelMessages, channel.token);
        this.seedHistory(channel.token, msg.history);
        // Mark where we joined — after any backlog, before live messages — so the
        // start of our interaction in the channel is clear. Once per session per
        // channel name (a reconnect/token-churn rejoin keeps the original line via
        // migrateLog rather than adding a fresh one).
        if (!this.joinAnnounced.has(channel.name)) {
          this.joinAnnounced.add(channel.name);
          this.systemLine(channel.token, `You joined #${channel.name}`);
        }
        this.events.emit('channelJoined', channel);
        return;
      }

      case 'channelLeft':
        this._channels.update((map) => {
          const next = new Map(map);
          const ch = next.get(msg.channelToken);
          if (ch) {
            this.intendedChannels.delete(ch.name);
            this.joinAnnounced.delete(ch.name); // re-announce on a later rejoin
          }
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
        // Emit the system line before removing the member so nameOf still resolves.
        this.systemLine(msg.channelToken, `${this.nameOf(msg.token)} left`);
        this.mutateMembers(msg.channelToken, (m) => m.delete(msg.token));
        this.events.emit('userLeftChannel', { token: msg.token, channelToken: msg.channelToken });
        return;

      case 'chat': {
        const text = this.applyIncoming(msg.text, msg.channelToken, msg.from);
        this.pushLine(this._channelMessages, msg.channelToken, {
          kind: 'chat',
          from: msg.from,
          text,
          at: msg.at,
        });
        this.events.emit('chat', { from: msg.from, channelToken: msg.channelToken, text });
        return;
      }

      case 'emote': {
        const text = this.applyIncoming(msg.text, msg.channelToken, msg.from);
        this.pushLine(this._channelMessages, msg.channelToken, {
          kind: 'emote',
          from: msg.from,
          text,
          at: msg.at,
        });
        this.events.emit('emote', { from: msg.from, channelToken: msg.channelToken, text });
        return;
      }

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

      case 'pong': {
        // Match against the recorded send time to derive RTT; unknown/duplicate
        // pongs (no pending entry) report rtt 0 rather than throwing.
        const sentAt = this.pendingPings.get(msg.id);
        this.pendingPings.delete(msg.id);
        this.events.emit('pong', { id: msg.id, rtt: sentAt ? this.now() - sentAt : 0 });
        return;
      }

      case 'error':
        this.events.emit('error', { message: msg.message });
        return;
    }
  }

  // -- store helpers --------------------------------------------------------

  private setStatus(state: ConnectionState): void {
    // De-dupe: skip the store write and statusChanged emit on no-op transitions.
    if (get(this._connection) === state) return;
    this._connection.set(state);
    this.events.emit('statusChanged', state);
  }

  // Store mutations always build a fresh Map (`new Map(map)`) rather than
  // mutating in place: Svelte stores fire only on reference change, so a new
  // identity is what makes subscribers re-render.
  private upsertUser(user: UserInfo): void {
    this._users.update((map) => new Map(map).set(user.token, user));
    // `users` = currently-connected roster (pruned on disconnect). `directory`
    // keeps a permanent record so names/colours survive a leave — needed to
    // render historical messages and PM tabs for users no longer online.
    this._directory.update((map) => new Map(map).set(user.token, user));
  }

  // Drops the user from the live roster and every channel's member set; the
  // directory entry is deliberately left intact (see upsertUser).
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

  /** Apply a mutation to one channel's member set, cloning both Set and Map for reactivity. */
  private mutateMembers(channelToken: Token, mutate: (members: Set<Token>) => void): void {
    this._channels.update((map) => {
      const channel = map.get(channelToken);
      // No-op (return the same map) if we don't track the channel — avoids a
      // spurious store notification.
      if (!channel) return map;
      const members = new Set(channel.members);
      mutate(members);
      return new Map(map).set(channelToken, { ...channel, members });
    });
  }

  /** Display name for a token, falling back to `#<token>` for unknown users. */
  private nameOf(token: Token): string {
    return get(this._users).get(token)?.name ?? `#${token}`;
  }

  /** Run incoming text through the plugin pipeline (pre- then post-process). */
  private applyIncoming(text: string, channelToken: Token, fromToken: Token): string {
    if (!this.pipeline) return text;
    const ctx = { channelToken, fromToken };
    return this.pipeline.postprocessText(this.pipeline.preprocessText(text, ctx), ctx);
  }

  /** Ensure an (empty) log array exists for a key so the UI can render the tab immediately. */
  private ensureLog(store: Writable<Map<Token, ChatLine[]>>, key: Token): void {
    // Leave an existing log untouched (same map ref = no notification).
    store.update((map) => (map.has(key) ? map : new Map(map).set(key, [])));
  }

  /**
   * Move a conversation's history from one key to another (token reassignment).
   * Old lines precede any already received under the new token, then trim to
   * historyLimit so a long-lived channel can't grow unbounded across rejoins.
   */
  private migrateLog(store: Writable<Map<Token, ChatLine[]>>, from: Token, to: Token): void {
    store.update((map) => {
      if (!map.has(from)) return map;
      const next = new Map(map);
      const merged = [...(next.get(from) ?? []), ...(next.get(to) ?? [])];
      next.set(to, merged.slice(-this.historyLimit));
      next.delete(from);
      return next;
    });
  }

  private systemLine(channelToken: Token, text: string): void {
    this.pushLine(this._channelMessages, channelToken, { kind: 'system', from: null, text });
  }

  /**
   * Merge a channel's join backlog into its log. Deduped by (from, at, kind,
   * text) so a reconnect's replayed history doesn't double messages we still
   * hold, then ordered by server timestamp. System lines (from === null) never
   * collide with backlog, so local join/leave notices are preserved.
   */
  private seedHistory(channelToken: Token, history: ChannelHistoryEntry[]): void {
    if (history.length === 0) return;

    // Record backlog authors' name/colour so their lines render even if they
    // aren't in the roster (left, or from a prior session). Fill gaps only —
    // never clobber a live directory entry with the historical snapshot.
    this._directory.update((map) => {
      let next: Map<Token, UserInfo> | null = null;
      for (const e of history) {
        if (map.has(e.from) || next?.has(e.from)) continue;
        next ??= new Map(map);
        next.set(e.from, { token: e.from, name: e.name, color: e.color, away: '' });
      }
      return next ?? map;
    });

    const key = (from: Token | null, at: number, kind: string, text: string) =>
      `${from}|${at}|${kind}|${text}`;
    this._channelMessages.update((map) => {
      const existing = map.get(channelToken) ?? [];
      const seen = new Set(existing.map((l) => key(l.from, l.at, l.kind, l.text)));
      const added: ChatLine[] = [];
      for (const e of history) {
        const text = this.applyIncoming(e.text, channelToken, e.from);
        const k = key(e.from, e.at, e.kind, text);
        if (seen.has(k)) continue;
        seen.add(k);
        added.push({ id: ++this.lineSeq, kind: e.kind, from: e.from, text, at: e.at });
      }
      if (added.length === 0) return map;
      const merged = [...existing, ...added].sort((a, b) => a.at - b.at || a.id - b.id);
      return new Map(map).set(channelToken, merged.slice(-this.historyLimit));
    });
  }

  private pushLine(
    store: Writable<Map<Token, ChatLine[]>>,
    key: Token,
    // `at` is optional: server-sent lines carry the authoritative timestamp;
    // locally-generated ones (system notices, own PMs) fall back to now().
    partial: Omit<ChatLine, 'id' | 'at'> & { at?: number },
  ): void {
    const { at, ...rest } = partial;
    store.update((map) => {
      const next = new Map(map);
      // Copy the array (slice) so we never mutate the previously-exposed snapshot.
      const arr = next.get(key)?.slice() ?? [];
      arr.push({ id: ++this.lineSeq, at: at ?? this.now(), ...rest });
      // Cap retained history per conversation, dropping the oldest lines.
      if (arr.length > this.historyLimit) arr.splice(0, arr.length - this.historyLimit);
      next.set(key, arr);
      return next;
    });
  }
}
