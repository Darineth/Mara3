import { get, writable, type Readable, type Writable } from 'svelte/store';
import {
  PROTOCOL_VERSION,
  safeParseServerMessage,
  type ChannelHistoryEntry,
  type ClientMessage,
  type Color,
  type EmojiEntry,
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

/** The predicate of an away/back status line (the renderer prepends the author name, as
 *  for an emote). A non-empty note means away. */
function awayPredicate(note: string): string {
  return note ? `is away (${note})` : 'is back.';
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
  /** Per-channel flag: true when older messages exist before the log's oldest line, so
   *  the UI can offer "load older" on scroll-up. Set from `channelJoined`/`historyChunk`. */
  readonly hasMoreHistory: Readable<Map<Token, boolean>>;
  readonly privateMessages: Readable<Map<Token, ChatLine[]>>;
  /** The server's reported version + served web build, from `welcome` (null until
   *  login, or if the server is too old to send it). */
  readonly serverInfo: Readable<ServerInfo | null>;
  /** The server's message of the day from `welcome` ('' when none is set). */
  readonly motd: Readable<string>;
  /** The server's custom emoji set (shortcode → image URL) from `welcome`; empty until
   *  login, or when the server has none configured. Drives `:name:` rendering + the picker.
   *  Updated live via `emojiUpdate` when anyone adds/removes a user-contributed emoji. */
  readonly emoji: Readable<Record<string, string>>;
  /** The same set as full entries (incl. `owner`/`by` for user-contributed ones), for the
   *  emoji-management UI to show who added each and which the local user may remove. */
  readonly emojiCatalog: Readable<EmojiEntry[]>;

  private readonly _connection = writable<ConnectionState>('idle');
  private readonly _self = writable<SelfState | null>(null);
  private readonly _users = writable<Map<Token, UserInfo>>(new Map());
  private readonly _directory = writable<Map<Token, UserInfo>>(new Map());
  private readonly _channels = writable<Map<Token, ChannelState>>(new Map());
  private readonly _channelMessages = writable<Map<Token, ChatLine[]>>(new Map());
  private readonly _hasMoreHistory = writable<Map<Token, boolean>>(new Map());
  private readonly _privateMessages = writable<Map<Token, ChatLine[]>>(new Map());
  private readonly _serverInfo = writable<ServerInfo | null>(null);
  private readonly _motd = writable('');
  private readonly _emoji = writable<Record<string, string>>({});
  private readonly _emojiCatalog = writable<EmojiEntry[]>([]);

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
  /** Server-minus-local clock offset (ms), anchored to `welcome.at` each connect, so
   *  `serverNow()` can estimate the server clock for locally-generated lines. */
  private serverClockOffset = 0;
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
    this.hasMoreHistory = { subscribe: this._hasMoreHistory.subscribe };
    this.privateMessages = { subscribe: this._privateMessages.subscribe };
    this.serverInfo = { subscribe: this._serverInfo.subscribe };
    this.motd = { subscribe: this._motd.subscribe };
    this.emoji = { subscribe: this._emoji.subscribe };
    this.emojiCatalog = { subscribe: this._emojiCatalog.subscribe };

    this.pipeline = opts.plugins;
    this.now = opts.now ?? Date.now;
    this.autoReconnect = opts.autoReconnect ?? true;
    this.reconnectBaseDelayMs = opts.reconnectBaseDelayMs ?? 500;
    this.reconnectMaxDelayMs = opts.reconnectMaxDelayMs ?? 10_000;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 25_000;
    // Generous per-conversation cap: it must comfortably exceed the server's retention
    // so paged-in older history isn't trimmed away by later live messages.
    this.historyLimit = opts.historyLimit ?? 2000;
    // Seed the intended set with the persisted "channels you were in" so the first
    // connect rejoins them (see the welcome handler).
    for (const name of opts.initialChannels ?? []) this.intendedChannels.add(name);
    // Restore device-local PM history. Ids are (re)assigned from this client's own
    // sequence so restored and live lines never collide as render keys, and each
    // peer's snapshot pre-fills the directory so their lines render while they're
    // offline (live roster data later overwrites these gap-fill entries).
    const restored = opts.initialPrivateMessages ?? [];
    if (restored.length > 0) {
      const pms = new Map<Token, ChatLine[]>();
      const dir = new Map<Token, UserInfo>();
      for (const convo of restored) {
        pms.set(
          convo.peer,
          convo.lines.slice(-this.historyLimit).map((l) => ({ ...l, id: ++this.lineSeq })),
        );
        dir.set(convo.peer, {
          token: convo.peer,
          name: convo.name,
          color: convo.color,
          avatar: '',
          away: '',
        });
      }
      this._privateMessages.set(pms);
      this._directory.set(dir);
    }
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

  /** `replyTo` is the server message id being replied to; the server resolves it into the
   *  quoted snapshot it broadcasts back (an id it no longer retains simply posts as a
   *  normal message). */
  sendChat(channelToken: Token, text: string, replyTo?: number): void {
    const out = this.pipeline ? this.pipeline.preprocessOutgoing(text, { channelToken }) : text;
    this.send({ type: 'chat', channelToken, text: out, replyTo });
  }

  sendEmote(channelToken: Token, text: string, replyTo?: number): void {
    const out = this.pipeline ? this.pipeline.preprocessOutgoing(text, { channelToken }) : text;
    this.send({ type: 'emote', channelToken, text: out, replyTo });
  }

  sendAway(text: string): void {
    this.send({ type: 'away', text });
  }

  /**
   * Change our display name and/or colour mid-session. The server dedupes the name
   * on a clash and broadcasts the result to everyone (including us) as `userProfile`,
   * so our own `self`/roster reflect the actual applied name. Pass only what changed.
   */
  setProfile(update: { name?: string; color?: Color; avatar?: string }): void {
    this.send({ type: 'setProfile', ...update });
  }

  /**
   * Add — or, as its owner, replace — a user-contributed custom emoji: bind `:name:` to an
   * image already uploaded via the emoji upload endpoint (whose returned URL is passed here).
   * The server validates ownership/dedupe and, on success, broadcasts the new set to everyone
   * (including us) as `emojiUpdate`; a rejection arrives as an `error` event. Fire-and-forget.
   */
  addEmoji(name: string, url: string): void {
    this.send({ type: 'addEmoji', name, url });
  }

  /** Remove a user-contributed emoji we added. The server broadcasts the new set on success. */
  removeEmoji(name: string): void {
    this.send({ type: 'removeEmoji', name });
  }

  /** Note: PM text is NOT run through the plugin pipeline (channel chat/emote only). */
  sendPrivateMessage(toUserToken: Token, text: string): void {
    this.send({ type: 'privateMessage', to: toUserToken, text });
    // Optimistically record our own outgoing line in this window: the server mirrors the
    // PM to our *other* windows but deliberately skips the sending one, so this local push
    // (and the matching `privateMessageSent` emit) is how the originating window shows it.
    const me = get(this._self);
    if (me)
      this.pushLine(this._privateMessages, toUserToken, { kind: 'chat', from: me.token, text });
    this.events.emit('privateMessageSent', { to: toUserToken, text });
  }

  /** Sends a heartbeat ping; the matching pong (by id) yields RTT. */
  ping(): void {
    const id = ++this.pingSeq;
    this.pendingPings.set(id, this.now());
    this.send({ type: 'ping', id });
  }

  /**
   * Estimated server clock (epoch ms): local time shifted by the offset anchored to the
   * last `welcome.at`. Use it for client-generated lines that have no server timestamp of
   * their own (connect/drop/reconnect notices) so they order on the same clock as chat.
   * Falls back to local time against an older server that doesn't send `welcome.at`.
   */
  serverNow(): number {
    return this.now() + this.serverClockOffset;
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
        this._sessionToken = msg.sessionToken; // HTTP bearer (see `sessionToken`)
        this._serverInfo.set(msg.server ?? null);
        this._motd.set(msg.motd ?? '');
        this.applyEmoji(msg.emoji);
        // Anchor the server-clock estimate to login time (0 = older server with no `at`,
        // so serverNow() == now()), keeping client-stamped notices on the server's clock.
        this.serverClockOffset = typeof msg.at === 'number' ? msg.at - this.now() : 0;
        this.reconnectAttempts = 0;
        this._self.set({ token: msg.self.token, name: msg.self.name });
        // Seed our own roster/directory entry (colour, away) from `self`.
        this.upsertUser(msg.self);
        this.setStatus('active');
        this.startHeartbeat();
        this.events.emit('connected', { token: msg.self.token, name: msg.self.name });
        // (Re)join every channel we intend to be in. On a fresh session that's the
        // persisted "channels you were in" (seeded via opts.initialChannels); on a
        // reconnect it's whatever we accumulated, since the server doesn't restore
        // membership. The server also auto-joins its default channel — a duplicate
        // join is idempotent (it just re-snapshots; channelJoined below reconciles any
        // reassigned tokens, and the joinAnnounced guard avoids a repeated join line).
        for (const name of this.intendedChannels) this.send({ type: 'joinChannel', channel: name });
        return;
      }

      case 'loginDenied':
        // Terminal: mark intentional so onClose won't auto-reconnect into the
        // same rejection (e.g. protocol mismatch).
        this.setStatus('denied');
        this.intentionalClose = true;
        this.events.emit('loginDenied', { reason: msg.reason, code: msg.code });
        this.socket?.close(1000, 'denied');
        return;

      case 'userConnect':
        this.upsertUser(msg.user);
        this.events.emit('userConnect', msg.user);
        return;

      case 'userDisconnect': {
        // Note the disconnect in each channel the user was in (capture the name and the
        // channel set before removing them, then drop them from every channel/roster).
        const name = this.nameOf(msg.token);
        const channelTokens: Token[] = [];
        for (const [channelToken, channel] of get(this._channels)) {
          if (channel.members.has(msg.token)) {
            channelTokens.push(channelToken);
            this.systemLine(channelToken, `${name} disconnected`, msg.at);
          }
        }
        // Also note it in any private conversation with them, so a PM clearly
        // shows the other party left.
        if (get(this._privateMessages).has(msg.token)) {
          this.pushLine(this._privateMessages, msg.token, {
            kind: 'system',
            from: null,
            text: `${name} disconnected`,
            at: msg.at,
          });
        }
        this.removeUser(msg.token);
        this.events.emit('userDisconnect', { token: msg.token, channelTokens });
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
          // Token churn, not a user action — `replaced` so listeners (e.g. logging) skip it.
          this.events.emit('channelLeft', {
            channelToken: staleToken,
            name: channel.name,
            reason: 'replaced',
          });
        }
        this.ensureLog(this._channelMessages, channel.token);
        this.mergeHistory(channel.token, msg.history, true);
        this.setHasMore(channel.token, msg.historyHasMore);
        // Mark where we joined — after any backlog, before live messages — so the
        // start of our interaction in the channel is clear. Once per session per
        // channel name (a reconnect/token-churn rejoin keeps the original line via
        // migrateLog rather than adding a fresh one).
        const firstJoin = !this.joinAnnounced.has(channel.name);
        if (firstJoin) {
          this.joinAnnounced.add(channel.name);
          this.systemLine(channel.token, `You joined #${channel.name}`, msg.at);
        }
        this.events.emit('channelJoined', channel);
        // Echo the outstanding away notices of members already away (others only), so the
        // joiner sees who's away. Done AFTER the event — so any MOTD/connect notice a
        // listener adds during it lands first — and stamped just past serverNow() (now
        // >= those notices) so they sort at the very end of the join sequence, in order.
        if (firstJoin) {
          const selfToken = get(this._self)?.token;
          let bump = 1;
          for (const u of msg.users) {
            if (u.away && u.token !== selfToken) {
              this.pushLine(this._channelMessages, channel.token, {
                kind: 'away',
                from: u.token,
                text: awayPredicate(u.away),
                at: this.serverNow() + bump++,
              });
            }
          }
        }
        return;
      }

      case 'channelLeft': {
        const name = get(this._channels).get(msg.channelToken)?.name ?? '';
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
        // A real departure (we left, or were removed) — log-worthy.
        this.events.emit('channelLeft', { channelToken: msg.channelToken, name, reason: 'left' });
        return;
      }

      case 'userJoinedChannel':
        this.mutateMembers(msg.channelToken, (m) => m.add(msg.token));
        this.systemLine(msg.channelToken, `${this.nameOf(msg.token)} joined`, msg.at);
        this.events.emit('userJoinedChannel', { token: msg.token, channelToken: msg.channelToken });
        return;

      case 'userLeftChannel':
        // Emit the system line before removing the member so nameOf still resolves.
        this.systemLine(msg.channelToken, `${this.nameOf(msg.token)} left`, msg.at);
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
          serverId: msg.id,
          replyTo: msg.replyTo,
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
          serverId: msg.id,
          replyTo: msg.replyTo,
        });
        this.events.emit('emote', { from: msg.from, channelToken: msg.channelToken, text });
        return;
      }

      case 'historyChunk': {
        // Paged-older messages, or a post-clear restore: drop any "cleared" marker, merge
        // without trimming (so paged pages aren't dropped), then update the "more?" flag.
        this.dropClearedMarker(msg.channelToken);
        this.mergeHistory(msg.channelToken, msg.messages, false);
        this.setHasMore(msg.channelToken, msg.hasMore);
        return;
      }

      case 'away': {
        const user = get(this._users).get(msg.token);
        if (user) this.upsertUser({ ...user, away: msg.text });
        // Announce the away/back transition in every channel the user shares — a channel
        // line everyone there sees, in the user's own colour (kind 'away' carries `from`,
        // and the renderer prepends the name, so the text is just the predicate).
        const text = awayPredicate(msg.text);
        for (const [channelToken, channel] of get(this._channels)) {
          if (channel.members.has(msg.token)) {
            this.pushLine(this._channelMessages, channelToken, {
              kind: 'away',
              from: msg.token,
              text,
              at: msg.at,
            });
          }
        }
        this.events.emit('away', { token: msg.token, text: msg.text });
        return;
      }

      case 'userProfile': {
        // A name/colour change. Update the roster + directory; if it's us, reflect
        // the (possibly server-deduped) name in `self`, and persist the applied
        // name/colour as our login identity so an auto-reconnect (e.g. after the
        // server restarts) re-logs in as the new name — not the one we first
        // connected with, which the server no longer remembers.
        this.upsertUser(msg.user);
        const me = get(this._self);
        if (me && msg.user.token === me.token) {
          this._self.set({ token: me.token, name: msg.user.name });
          this.opts.name = msg.user.name;
          this.opts.color = msg.user.color;
        }
        this.events.emit('userProfile', msg.user);
        return;
      }

      case 'privateMessage': {
        // The server sends `from`/`to`; the conversation partner is whichever token
        // isn't us. A message whose `from` is us is the mirror of our own outgoing PM
        // to another window/device — thread it under the recipient and report it as a
        // sent line, so every window converges (the sending window already did this
        // locally in `sendPrivateMessage`, and the server excludes it from the mirror).
        const me = get(this._self);
        const outgoing = me !== null && msg.from === me.token;
        const partner = outgoing ? msg.to : msg.from;
        this.pushLine(this._privateMessages, partner, {
          kind: 'chat',
          from: msg.from,
          text: msg.text,
        });
        if (outgoing) this.events.emit('privateMessageSent', { to: partner, text: msg.text });
        else this.events.emit('privateMessage', { from: msg.from, text: msg.text });
        return;
      }

      case 'pong': {
        // Match against the recorded send time to derive RTT; unknown/duplicate
        // pongs (no pending entry) report rtt 0 rather than throwing.
        const sentAt = this.pendingPings.get(msg.id);
        this.pendingPings.delete(msg.id);
        this.events.emit('pong', { id: msg.id, rtt: sentAt ? this.now() - sentAt : 0 });
        return;
      }

      case 'emojiUpdate':
        // A user added/replaced/removed a custom emoji: refresh the live set so `:name:`
        // rendering and the picker update everywhere without a reconnect.
        this.applyEmoji(msg.emoji);
        return;

      case 'error':
        this.events.emit('error', { message: msg.message });
        return;
    }
  }

  /** Apply a custom-emoji set (from `welcome` or a live `emojiUpdate`) to both stores: the
   *  shortcode→URL map that drives rendering + the picker, and the full catalog for the
   *  management UI. */
  private applyEmoji(entries: EmojiEntry[] | undefined): void {
    const list = entries ?? [];
    this._emoji.set(Object.fromEntries(list.map((e) => [e.name, e.url])));
    this._emojiCatalog.set(list);
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

  private systemLine(channelToken: Token, text: string, at?: number): void {
    this.pushLine(this._channelMessages, channelToken, { kind: 'system', from: null, text, at });
  }

  /**
   * Merge channel history (join backlog or a paged-older chunk) into a channel's log.
   * Deduped by server message id (falling back to a (from, at, kind, text) composite for
   * any id-less line) so replayed history doesn't double messages we still hold, then
   * ordered by server timestamp. System lines (from === null, no id) never collide with
   * backlog, so local join/leave notices are preserved. `trim` caps to the newest
   * `historyLimit` (join); paged-older chunks pass `false` so they aren't dropped.
   */
  private mergeHistory(channelToken: Token, history: ChannelHistoryEntry[], trim: boolean): void {
    if (history.length === 0) return;

    // Record backlog authors' name/colour so their lines render even if they
    // aren't in the roster (left, or from a prior session). Fill gaps only —
    // never clobber a live directory entry with the historical snapshot.
    this._directory.update((map) => {
      let next: Map<Token, UserInfo> | null = null;
      for (const e of history) {
        if (map.has(e.from) || next?.has(e.from)) continue;
        next ??= new Map(map);
        next.set(e.from, { token: e.from, name: e.name, color: e.color, avatar: '', away: '' });
      }
      return next ?? map;
    });

    const keyOf = (l: Pick<ChatLine, 'serverId' | 'from' | 'at' | 'kind' | 'text'>) =>
      l.serverId != null ? `#${l.serverId}` : `${l.from}|${l.at}|${l.kind}|${l.text}`;
    this._channelMessages.update((map) => {
      const existing = map.get(channelToken) ?? [];
      const seen = new Set(existing.map(keyOf));
      const added: ChatLine[] = [];
      for (const e of history) {
        const text = this.applyIncoming(e.text, channelToken, e.from);
        const line = {
          serverId: e.id,
          kind: e.kind,
          from: e.from,
          text,
          at: e.at,
          replyTo: e.replyTo,
        };
        if (seen.has(keyOf(line))) continue;
        seen.add(keyOf(line));
        added.push({ id: ++this.lineSeq, ...line });
      }
      if (added.length === 0) return map;
      // Order by server time, breaking ties on the server id (true message order) so
      // same-millisecond messages sort chronologically regardless of when we fetched
      // them; id-less lines fall back to their client sequence.
      const merged = [...existing, ...added].sort((a, b) => {
        if (a.at !== b.at) return a.at - b.at;
        if (a.serverId != null && b.serverId != null) return a.serverId - b.serverId;
        return a.id - b.id;
      });
      return new Map(map).set(channelToken, trim ? merged.slice(-this.historyLimit) : merged);
    });
  }

  /** Record whether a channel has older messages beyond its oldest held line. */
  private setHasMore(channelToken: Token, hasMore: boolean): void {
    this._hasMoreHistory.update((m) => new Map(m).set(channelToken, hasMore));
  }

  /**
   * Ask the server for the page of messages just older than what we hold in `channelToken`
   * (cursor = our oldest server-id'd line). No-op if we hold nothing with a server id yet.
   * The reply arrives as `historyChunk` and is prepended via {@link mergeHistory}.
   */
  requestOlderHistory(channelToken: Token): void {
    const lines = get(this._channelMessages).get(channelToken) ?? [];
    const oldest = lines.find((l) => l.serverId != null);
    if (!oldest || oldest.serverId == null) return;
    this.send({ type: 'requestHistory', channelToken, before: oldest.serverId });
  }

  /**
   * Clear this client's local backlog for a channel, replacing it with a single "cleared"
   * marker line the user can click to restore. Purely client-side — the server's stored
   * history is untouched; {@link restoreChannel} re-fetches it. Live messages that arrive
   * afterwards still append below the marker.
   */
  clearChannel(channelToken: Token): void {
    this._channelMessages.update((map) =>
      new Map(map).set(channelToken, [
        // Stamp on the server clock (like chat lines and the connection/MOTD notices) so the
        // marker sorts correctly against them — the UI hides notices older than it.
        { id: ++this.lineSeq, kind: 'cleared', from: null, text: '', at: this.serverNow() },
      ]),
    );
    // Nothing sits above the marker to page in until a restore, so silence the scroll loader.
    this.setHasMore(channelToken, false);
  }

  /**
   * Re-fetch a channel's latest backlog after {@link clearChannel}. Sends a cursor-less
   * history request; the server replies with the most recent page as a `historyChunk`, whose
   * handler drops the cleared marker and merges the messages back in.
   */
  restoreChannel(channelToken: Token): void {
    this.send({ type: 'requestHistory', channelToken });
  }

  /** Drop the synthetic "cleared" marker from a channel's log (on restore / incoming history). */
  private dropClearedMarker(channelToken: Token): void {
    this._channelMessages.update((map) => {
      const lines = map.get(channelToken);
      if (!lines?.some((l) => l.kind === 'cleared')) return map;
      return new Map(map).set(
        channelToken,
        lines.filter((l) => l.kind !== 'cleared'),
      );
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
