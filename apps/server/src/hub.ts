import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MOTD_MAX_LEN,
  PROTOCOL_VERSION,
  replyExcerpt,
  safeParseClientMessage,
  type ClientMessage,
  type EmojiEntry,
  type ReplyRef,
  type ServerInfo,
  type ServerMessage,
  type Token,
  type UserInfo,
} from '@mara/protocol';
import type { Connection } from './connection.js';
import type { ServerConfig } from './config.js';
import { EMOJI_ROUTE, EmojiStore } from './emoji.js';
import { HistoryStore } from './history.js';
import { IdentityStore, type IdentityProfile } from './identity.js';
import type { Logger } from './logger.js';
import { ServerState, type Session } from './state.js';
import { makeSessionToken } from './tokens.js';
import { UserEmojiStore } from './userEmoji.js';
import { deleteAvatar, deleteUserEmoji, userEmojiName } from './uploads.js';
import { getServerInfo } from './version.js';

/**
 * The message-handling core. One instance owns all shared state and processes
 * every client message synchronously on Node's event loop, so state mutations
 * never interleave — the modern equivalent of Mara 2's single-thread Qt server.
 */
export class Hub {
  readonly state: ServerState;
  private readonly history: HistoryStore;
  private readonly identity: IdentityStore;
  /** The operator's custom emoji set, sent to each client in `welcome`. */
  private readonly emoji: EmojiStore;
  /** User-contributed custom emoji: a durable, owner-tracked set clients add to at runtime. */
  private readonly userEmoji: UserEmojiStore;
  /** Monotonic message-id counter; seeded from persisted history so ids keep increasing
   *  across restarts. Each chat/emote gets `++this.nextMessageId`. */
  private nextMessageId: number;
  /** Our version + the web build we serve; echoed in every `welcome`. */
  readonly serverInfo: ServerInfo;
  /** Users whose last socket has closed but whose disconnect is being held back
   *  for the grace window (keyed by user token → its pending timer). A reconnect
   *  clears the entry silently; otherwise the timer announces the disconnect. */
  private readonly pendingDisconnects = new Map<Token, ReturnType<typeof setTimeout>>();
  /** Per-user flap history (keyed by user token, outliving individual sessions):
   *  timestamps of recent last-window closes, and whether the user is currently
   *  *damped* — flapping enough that we hold their session on the long settle
   *  window so the churn stays silent, until they participate or truly leave.
   *  See {@link scheduleDisconnect}. */
  private readonly flap = new Map<Token, { drops: number[]; damped: boolean }>();
  /** Last-window closes within `flapSettleMs` that flag a user as flapping. */
  private static readonly FLAP_THRESHOLD = 3;
  /** Interaction-based *unreliable* flag (keyed by user token, outliving sessions): how
   *  many consecutive sessions ended with no chat/emote, and whether the user is currently
   *  flagged unreliable — join/disconnect muted until they next interact. Catches slow
   *  join/leave churn that `flapSettleMs` (a time window) misses. See
   *  {@link finalizeDisconnect} / {@link revealIfUnreliable}. */
  private readonly quiet = new Map<Token, { drops: number; unreliable: boolean }>();

  constructor(
    private readonly cfg: ServerConfig,
    private readonly log: Logger,
    // Clock is injectable so tests get deterministic message timestamps.
    private readonly now: () => number = Date.now,
  ) {
    this.history = new HistoryStore(cfg.historyFile, log);
    this.nextMessageId = this.history.maxId();
    this.identity = new IdentityStore(cfg.identityFile, log);
    this.emoji = new EmojiStore(cfg.emojiDir, log);
    this.userEmoji = new UserEmojiStore(cfg.userEmojiFile, log);
    // Operator moderation: when the user-emoji file is edited on disk by hand (an entry
    // removed), reclaim the now-orphaned image and push the revised set to everyone live — so
    // taking down a bad emoji doesn't need a restart and leaves nothing served at its old URL.
    this.userEmoji.watchExternal((removed) => {
      for (const rec of removed) {
        void deleteUserEmoji(this.cfg, `${EMOJI_ROUTE}${rec.file}`, this.log);
      }
      this.log.info({ removed: removed.length }, 'user emoji reloaded after an external edit');
      this.broadcastEmoji();
    });
    this.state = new ServerState(this.identity);
    this.serverInfo = getServerInfo(cfg.webRoot, cfg.serverName);
  }

  /** Persist any pending history + identities synchronously (call on shutdown). */
  flush(): void {
    // Cancel any in-flight disconnect timers so a teardown doesn't fire a stray
    // broadcast (and the process isn't held open waiting on them).
    for (const timer of this.pendingDisconnects.values()) clearTimeout(timer);
    this.pendingDisconnects.clear();
    this.flap.clear();
    this.quiet.clear();
    this.history.flush();
    this.identity.flush();
    this.userEmoji.flush();
  }

  /**
   * The full custom-emoji set sent to clients: the operator's emoji plus every user
   * contribution, with operator emoji winning any shortcode clash (so they're stable and
   * can never be shadowed — or removed — by a user). Recomputed on demand; the sets are small.
   */
  private emojiManifest(): EmojiEntry[] {
    const operator = this.emoji.manifest();
    const reserved = new Set(operator.map((e) => e.name));
    const user = this.userEmoji.manifest().filter((e) => !reserved.has(e.name));
    return [...operator, ...user];
  }

  /**
   * The current MOTD, re-read from its file on each login so edits to `MOTD.md` take
   * effect without a server restart. Falls back to the configured `motd` (from
   * `MARA_MOTD`/the default) when no file is set, or it's missing/unreadable.
   */
  private currentMotd(): string {
    const file = this.cfg.motdFile;
    if (file) {
      try {
        if (existsSync(file)) return readFileSync(file, 'utf8').trim().slice(0, MOTD_MAX_LEN);
      } catch {
        /* unreadable → fall back to the configured value */
      }
    }
    return this.cfg.motd;
  }

  onConnect(conn: Connection): void {
    // The client speaks first (`login`); nothing to send on connect.
    this.log.debug({ conn: conn.id }, 'connected');
  }

  onMessage(conn: Connection, raw: string): void {
    // Flood control: a token bucket per connection. Over-limit frames are dropped
    // (so one client can't make every other client re-render a flood), the user is
    // notified once per throttled run, and a persistent flooder is disconnected.
    // `msgRate <= 0` disables it (trusted-LAN escape hatch).
    if (this.cfg.msgRate > 0 && !conn.rateAllow(this.now(), this.cfg.msgRate, this.cfg.msgBurst)) {
      if (conn.dropStreak === 1) {
        conn.send({ type: 'error', message: 'You are sending messages too quickly.' });
      }
      if (conn.dropStreak >= this.cfg.msgFloodKick) {
        this.log.warn({ conn: conn.id }, 'rate limit: closing flooding connection');
        conn.close(1008, 'rate limit exceeded'); // 1008 = policy violation
      }
      return;
    }

    const parsed = safeParseClientMessage(raw);
    if (!parsed.success) {
      conn.send({ type: 'error', message: parsed.error.message });
      return;
    }
    try {
      this.dispatch(conn, parsed.data);
    } catch (err) {
      this.log.error({ err, conn: conn.id }, 'handler threw');
      conn.send({ type: 'error', message: 'internal error' });
    }
  }

  onClose(conn: Connection): void {
    // Detach this socket. A pre-login drop (userToken null) leaves nothing to do.
    // For a multiplexed user we only announce a disconnect once their *last*
    // window closes — other windows keep them present.
    const result = this.state.detachConnection(conn);
    if (result?.lastClosed) {
      // Hold the disconnect for the grace window: a reconnect within it (common on
      // mobile, where the socket drops on backgrounding/network switches) cancels
      // this quietly, so other users never see leave/join churn.
      this.scheduleDisconnect(result.session);
    } else if (result) {
      this.log.debug({ user: result.session.info.name }, 'window closed (still online elsewhere)');
    }
    conn.state = 'closed';
  }

  /**
   * Arm (or immediately fire) the pending-disconnect for a user whose last socket
   * just closed. Each such drop is recorded; once a user racks up
   * {@link FLAP_THRESHOLD} of them inside the `flapSettleMs` window they're flagged
   * as *flapping* and switched from the ordinary `disconnectGraceMs` to the much
   * longer `flapSettleMs` window. The session is *held* for that whole window, so
   * every reconnect inside it is a silent multiplex (no connect/join/disconnect
   * lines) — which is what tames a backgrounded mobile tab that drops and reconnects
   * for minutes on end. With the chosen window `<= 0` we announce synchronously
   * (pre-grace behaviour).
   */
  private scheduleDisconnect(session: Session): void {
    const token = session.info.token;
    // A prior timer shouldn't exist (the reconnect path clears it), but be safe.
    const existing = this.pendingDisconnects.get(token);
    if (existing) clearTimeout(existing);

    let graceMs = this.cfg.disconnectGraceMs;
    if (this.cfg.flapSettleMs > 0) {
      const now = this.now();
      const rec = this.flap.get(token);
      const drops = (rec?.drops ?? []).filter((t) => now - t < this.cfg.flapSettleMs);
      drops.push(now);
      const damped = (rec?.damped ?? false) || drops.length >= Hub.FLAP_THRESHOLD;
      this.flap.set(token, { drops, damped });
      if (damped) {
        graceMs = this.cfg.flapSettleMs;
        this.log.debug({ user: session.info.name }, 'flapping — holding presence (long window)');
      }
    }

    if (graceMs <= 0) {
      this.finalizeDisconnect(token);
      return;
    }
    this.log.debug({ user: session.info.name, graceMs }, 'last window closed (holding for grace)');
    const timer = setTimeout(() => this.finalizeDisconnect(token), graceMs);
    // Don't let a pending disconnect keep the process alive on its own.
    timer.unref?.();
    this.pendingDisconnects.set(token, timer);
  }

  /** Clear a held disconnect because the user reconnected within the grace window. */
  private cancelPendingDisconnect(token: Token): void {
    const timer = this.pendingDisconnects.get(token);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.pendingDisconnects.delete(token);
  }

  /** Forget a user's flap history — they've stabilised (participated, or gone for good). */
  private clearFlap(token: Token): void {
    this.flap.delete(token);
  }

  /** Whether a token is currently flagged unreliable (join/disconnect muted). */
  private isUnreliable(token: Token): boolean {
    return this.quiet.get(token)?.unreliable ?? false;
  }

  /**
   * A user just interacted for the first time this session: clear their churn count, and if
   * they were muted as unreliable, announce the presence that was suppressed — their
   * connect, and a join for each channel they're in — so everyone sees them now. No-op when
   * they weren't muted (the common case).
   */
  private revealIfUnreliable(session: Session): void {
    const token = session.info.token;
    const wasUnreliable = this.isUnreliable(token);
    this.quiet.delete(token);
    if (!wasUnreliable) return;
    this.broadcastAll({ type: 'userConnect', user: session.info }, token);
    for (const channelToken of session.channels) {
      this.broadcastChannel(
        channelToken,
        { type: 'userJoinedChannel', token, channelToken, at: this.now() },
        token,
      );
    }
  }

  /**
   * The grace window elapsed with no reconnect: retire the session and announce the
   * departure. `dropSession` is a no-op if the user came back (has sockets again),
   * so a late timer can't evict a live user. A flapping user reaching here has
   * finally stayed away past the long window — announce once and forget them, so a
   * later return starts clean.
   */
  private finalizeDisconnect(token: Token): void {
    this.pendingDisconnects.delete(token);
    const session = this.state.dropSession(token);
    if (!session) return; // reconnected in the meantime, or already gone
    const wasFlapping = this.flap.get(token)?.damped ?? false;
    if (wasFlapping) this.clearFlap(token);

    // Whether this token was ALREADY flagged unreliable coming into this disconnect decides
    // if we announce it. Then update the count: a session that ended without a single
    // chat/emote is another quiet cycle (flag once it reaches the threshold); one that
    // interacted was a real presence, so forget the count and announce normally.
    const muted = this.isUnreliable(token);
    if (session.interacted) {
      this.quiet.delete(token);
    } else if (this.cfg.unreliableDrops > 0) {
      const rec = this.quiet.get(token) ?? { drops: 0, unreliable: false };
      rec.drops += 1;
      rec.unreliable = rec.unreliable || rec.drops >= this.cfg.unreliableDrops;
      this.quiet.set(token, rec);
    }
    if (muted) {
      this.log.debug({ user: session.info.name }, 'disconnected (muted — unreliable)');
      return;
    }
    this.log.info({ user: session.info.name, flapping: wasFlapping }, 'disconnected');
    this.broadcastAll({ type: 'userDisconnect', token, at: this.now() }, token);
  }

  // -- dispatch -------------------------------------------------------------

  private dispatch(conn: Connection, msg: ClientMessage): void {
    // `login` is the only message valid before the connection is active — it is
    // what makes it active. Its handler enforces the awaitingLogin state.
    if (msg.type === 'login') return this.handleLogin(conn, msg);

    // Everything else requires a logged-in session.
    if (conn.state !== 'active' || conn.userToken === null) {
      conn.send({ type: 'error', message: 'not logged in' });
      return;
    }
    const session = this.state.sessions.get(conn.userToken);
    if (!session) return;

    switch (msg.type) {
      case 'joinChannel':
        return this.handleJoinChannel(session, msg);
      case 'leaveChannel':
        return this.handleLeaveChannel(session, msg);
      case 'chat':
        return this.handleChannelText(
          session,
          conn,
          msg.channelToken,
          msg.text,
          'chat',
          msg.replyTo,
        );
      case 'emote':
        return this.handleChannelText(
          session,
          conn,
          msg.channelToken,
          msg.text,
          'emote',
          msg.replyTo,
        );
      case 'away':
        return this.handleAway(session, msg);
      case 'setProfile':
        return this.handleSetProfile(session, msg);
      case 'addEmoji':
        return this.handleAddEmoji(session, conn, msg);
      case 'removeEmoji':
        return this.handleRemoveEmoji(session, conn, msg);
      case 'privateMessage':
        return this.handlePrivateMessage(session, conn, msg);
      case 'ping':
        return conn.send({ type: 'pong', id: msg.id });
      case 'requestHistory':
        return this.handleRequestHistory(session, conn, msg);
    }
  }

  // -- login ----------------------------------------------------------------

  private handleLogin(conn: Connection, msg: Extract<ClientMessage, { type: 'login' }>): void {
    if (conn.state !== 'awaitingLogin') {
      conn.send({ type: 'error', message: 'already logged in' });
      return;
    }
    if (msg.protocol !== PROTOCOL_VERSION) {
      conn.send({
        type: 'loginDenied',
        reason: 'protocol version mismatch — please update',
        code: 'protocol',
      });
      // 4001: app-defined WS close code (4000–4999) meaning "must update".
      conn.close(4001, 'protocol mismatch');
      return;
    }

    const { token, profile } = this.resolveIdentity(msg.identityKey);
    const sessionToken = makeSessionToken();
    conn.userToken = token;
    conn.sessionToken = sessionToken;
    conn.state = 'active';

    // An identity that is still live: either a genuine second window, or the same
    // user reconnecting inside the grace window after their last socket dropped.
    // Either way we multiplex this socket onto the existing session instead of
    // spawning a duplicate — no new presence is announced (they never left as far
    // as anyone else is concerned) — we just bring this window into sync.
    const live = this.state.sessions.get(token);
    if (live) {
      // If a disconnect was being held for this user, they're back: cancel it.
      this.cancelPendingDisconnect(token);
      this.state.attachConnection(live, conn);
      this.log.info({ user: live.info.name, token }, 'additional window');
      conn.send({
        type: 'welcome',
        self: live.info,
        sessionToken,
        motd: this.currentMotd(),
        server: this.serverInfo,
        emoji: this.emojiManifest(),
        at: this.now(),
      });
      for (const channelToken of live.channels) {
        const channel = this.state.channelsByToken.get(channelToken);
        if (channel) this.sendChannelSnapshot(conn, channel);
      }
      return;
    }

    // Others-visible presence (name + colour) belongs to the identity, so a stored
    // profile wins over whatever this client sent at login — that's what lets the same
    // identity look identical across clients. `uniqueName` still runs, to sidestep a
    // live clash with a *different* user (that dedupe isn't persisted below).
    const name = this.uniqueName(profile?.name ?? msg.name);
    const color = profile?.color ?? msg.color;
    // Avatar is others-visible → identity-owned; login carries none, so it comes only from
    // the stored profile (set in-session via setProfile).
    const info: UserInfo = { token, name, color, avatar: profile?.avatar ?? '', away: '' };
    const session: Session = {
      info,
      connections: new Set([conn]),
      channels: new Set(),
      interacted: false,
    };
    this.state.addSession(session);
    // Seed the identity's profile on first sight (no-op for an anonymous, unbound token),
    // so this name/colour follows it to its next client. No avatar at login.
    if (!profile) this.identity.setProfile(token, { name, color, avatar: '' });
    this.log.info({ user: name, token }, 'logged in');

    conn.send({
      type: 'welcome',
      self: info,
      sessionToken,
      motd: this.currentMotd(),
      server: this.serverInfo,
      emoji: this.emojiManifest(),
      at: this.now(),
    });
    // A client already flagged unreliable (flap-y, never interacts) reconnects silently —
    // no connect/join churn — until it actually says something (see revealIfUnreliable).
    if (!this.isUnreliable(token)) this.broadcastAll({ type: 'userConnect', user: info }, token);

    // Drop everyone into the shared default channel automatically.
    if (this.cfg.defaultChannel) this.joinChannelByName(session, this.cfg.defaultChannel);
  }

  // -- channel + chat -------------------------------------------------------

  private handleJoinChannel(
    session: Session,
    msg: Extract<ClientMessage, { type: 'joinChannel' }>,
  ): void {
    this.joinChannelByName(session, msg.channel);
  }

  private joinChannelByName(session: Session, name: string): void {
    const channel = this.state.getOrCreateChannel(name);
    const alreadyMember = session.channels.has(channel.token);
    channel.members.add(session.info.token);
    session.channels.add(channel.token);

    // Membership is per-user, so every window of this user reflects the join.
    for (const conn of session.connections) this.sendChannelSnapshot(conn, channel);
    // Only announce a genuinely new membership (idempotent on rejoin/resume), and stay
    // silent for an unreliable client until it interacts (revealIfUnreliable announces then).
    if (!alreadyMember && !this.isUnreliable(session.info.token)) {
      this.broadcastChannel(
        channel.token,
        {
          type: 'userJoinedChannel',
          token: session.info.token,
          channelToken: channel.token,
          at: this.now(),
        },
        session.info.token,
      );
    }
  }

  /** Send a single channel's roster + backlog to one socket (join or window-sync). */
  private sendChannelSnapshot(
    conn: Connection,
    channel: { token: Token; name: string; members: Set<Token> },
  ): void {
    const users: UserInfo[] = [];
    for (const token of channel.members) {
      const member = this.state.sessions.get(token);
      if (member) users.push(member.info);
    }
    // Send only the most recent chunk; the client pages older messages on scroll-up.
    const { entries, hasMore } = this.history.recent(channel.name, this.cfg.historyChunk);
    conn.send({
      type: 'channelJoined',
      channelToken: channel.token,
      channel: channel.name,
      users,
      history: entries,
      historyHasMore: hasMore,
      at: this.now(),
    });
  }

  /** Reply to a `requestHistory` for a channel the session is in. With `before` (a message id)
   *  it returns the page just older than that cursor; without it, the most recent page — the
   *  same backlog chunk sent on join, used to re-fetch after a client cleared its local view.
   *  The server decides the page size either way. */
  private handleRequestHistory(
    session: Session,
    conn: Connection,
    msg: Extract<ClientMessage, { type: 'requestHistory' }>,
  ): void {
    const channel = this.state.channelsByToken.get(msg.channelToken);
    if (!channel || !session.channels.has(channel.token)) {
      conn.send({ type: 'error', message: 'not in that channel' });
      return;
    }
    const { entries, hasMore } =
      msg.before === undefined
        ? this.history.recent(channel.name, this.cfg.historyChunk)
        : this.history.before(channel.name, msg.before, this.cfg.historyChunk);
    conn.send({
      type: 'historyChunk',
      channelToken: channel.token,
      messages: entries,
      hasMore,
    });
  }

  private handleLeaveChannel(
    session: Session,
    msg: Extract<ClientMessage, { type: 'leaveChannel' }>,
  ): void {
    const channel = this.state.channelsByToken.get(msg.channelToken);
    if (!channel || !session.channels.has(channel.token)) return;
    channel.members.delete(session.info.token);
    session.channels.delete(channel.token);
    for (const conn of session.connections)
      conn.send({ type: 'channelLeft', channelToken: channel.token });
    this.broadcastChannel(channel.token, {
      type: 'userLeftChannel',
      token: session.info.token,
      channelToken: channel.token,
      at: this.now(),
    });
    this.state.pruneChannel(channel.token);
  }

  private handleChannelText(
    session: Session,
    conn: Connection,
    channelToken: Token,
    text: string,
    kind: 'chat' | 'emote',
    replyToId?: number,
  ): void {
    const channel = this.state.channelsByToken.get(channelToken);
    if (!channel || !session.channels.has(channelToken)) {
      conn.send({ type: 'error', message: 'not in that channel' });
      return;
    }
    // First words this session prove a real presence: reveal the user if they were muted as
    // unreliable (announce the connect + joins that were suppressed) and reset the churn
    // count, then forget any flap history so their next disconnect announces normally.
    if (!session.interacted) {
      session.interacted = true;
      this.revealIfUnreliable(session);
    }
    this.clearFlap(session.info.token);
    const replyTo =
      replyToId === undefined ? undefined : this.resolveReply(channel.name, replyToId);
    // Server-stamp the message, retain it as capped (persisted) backlog, then
    // broadcast it. The author's name/colour are snapshotted so backlog renders
    // even after a restart, when the author's token is gone.
    const at = this.now();
    const id = ++this.nextMessageId;
    this.history.append(
      channel.name,
      {
        id,
        from: session.info.token,
        name: session.info.name,
        color: session.info.color,
        kind,
        text,
        at,
        replyTo,
      },
      this.cfg.historyLimit,
    );
    this.broadcastChannel(channelToken, {
      type: kind,
      id,
      from: session.info.token,
      channelToken,
      text,
      at,
      replyTo,
    });
  }

  /**
   * Build the quoted snapshot for a reply, from the server's own copy of the parent — the
   * client sends only an id, so it can't fake who or what it is quoting. Resolution is scoped
   * to the replier's channel, which also means an id from a channel they aren't in resolves to
   * nothing. A parent that has aged out of retention likewise yields `undefined`: the reply
   * then posts as an ordinary message rather than being rejected, so the text is never lost.
   */
  private resolveReply(channelName: string, id: number): ReplyRef | undefined {
    const parent = this.history.byId(channelName, id);
    if (!parent) return undefined;
    return {
      id: parent.id,
      from: parent.from,
      name: parent.name,
      color: parent.color,
      kind: parent.kind,
      excerpt: replyExcerpt(parent.text),
    };
  }

  private handleAway(session: Session, msg: Extract<ClientMessage, { type: 'away' }>): void {
    session.info.away = msg.text;
    // Broadcast to everyone (incl. the sender, so their own roster + the channel
    // announcement update); clients turn it into an "is away/back" line per shared channel.
    this.broadcastAll({ type: 'away', token: session.info.token, text: msg.text, at: this.now() });
  }

  // Change a user's display name and/or colour mid-session and broadcast the result
  // to everyone (the user included, so their own client picks up a deduped name).
  private handleSetProfile(
    session: Session,
    msg: Extract<ClientMessage, { type: 'setProfile' }>,
  ): void {
    let changed = false;
    if (msg.color !== undefined && msg.color !== session.info.color) {
      session.info.color = msg.color;
      changed = true;
    }
    if (msg.name !== undefined) {
      const requested = msg.name.trim();
      // Dedupe against *other* users (excluding ourselves, or our own name would
      // always "clash"); a no-op rename leaves the name untouched.
      const unique = requested && this.uniqueName(requested, session.info.token);
      if (unique && unique !== session.info.name) {
        session.info.name = unique;
        changed = true;
      }
    }
    // Avatar (already schema-validated to a hosted path or ''). Replacing or clearing it
    // frees the previous avatar file so the durable store keeps ~one per user.
    if (msg.avatar !== undefined && msg.avatar !== session.info.avatar) {
      const previous = session.info.avatar;
      session.info.avatar = msg.avatar;
      changed = true;
      if (previous) void deleteAvatar(this.cfg, previous, this.log);
    }
    if (changed) {
      this.broadcastAll({ type: 'userProfile', user: session.info });
      // Persist the new profile to the identity so it sticks across restarts and follows
      // the user to other clients (no-op for an anonymous token).
      this.identity.setProfile(session.info.token, {
        name: session.info.name,
        color: session.info.color,
        avatar: session.info.avatar,
      });
    }
  }

  /**
   * Add — or, for its owner, replace — a user-contributed emoji. `msg.url` must be an image
   * this server just stored (an `/emoji/<hex>` upload that still exists on disk), so a client
   * can't bind a shortcode to an arbitrary or operator path. A name already taken by an
   * operator emoji is reserved; one taken by *another* user belongs to them. On success the
   * (possibly replaced) old image is freed and the new set is broadcast to everyone.
   */
  private handleAddEmoji(
    session: Session,
    conn: Connection,
    msg: Extract<ClientMessage, { type: 'addEmoji' }>,
  ): void {
    const file = userEmojiName(msg.url);
    if (!file || !existsSync(join(this.cfg.userEmojiDir, file))) {
      conn.send({ type: 'error', message: 'That emoji image could not be found — re-upload it.' });
      return;
    }
    // Operator emoji are protected: their shortcodes can't be taken over.
    if (this.emoji.manifest().some((e) => e.name === msg.name)) {
      conn.send({
        type: 'error',
        message: `:${msg.name}: is a built-in emoji and can't be changed.`,
      });
      return;
    }
    const existing = this.userEmoji.get(msg.name);
    if (existing && existing.owner !== session.info.token) {
      conn.send({ type: 'error', message: `:${msg.name}: was added by someone else.` });
      return;
    }
    if (!existing && this.userEmoji.count() >= this.cfg.maxEmojiCount) {
      conn.send({
        type: 'error',
        message: `The emoji library is full (${this.cfg.maxEmojiCount}). Remove one first.`,
      });
      return;
    }
    // Owner replacing their own emoji: free the previous image so the store keeps one file
    // per shortcode.
    if (existing && existing.file !== file) {
      void deleteUserEmoji(this.cfg, `${EMOJI_ROUTE}${existing.file}`, this.log);
    }
    this.userEmoji.set(msg.name, {
      file,
      owner: session.info.token,
      by: session.info.name,
      at: this.now(),
    });
    this.log.info({ name: msg.name, by: session.info.name, replaced: !!existing }, 'emoji added');
    this.broadcastEmoji();
  }

  /** Remove a user-contributed emoji. Honored only from its owner (idempotent otherwise). */
  private handleRemoveEmoji(
    session: Session,
    conn: Connection,
    msg: Extract<ClientMessage, { type: 'removeEmoji' }>,
  ): void {
    const existing = this.userEmoji.get(msg.name);
    if (!existing) return; // already gone — nothing to do
    if (existing.owner !== session.info.token) {
      conn.send({ type: 'error', message: `:${msg.name}: was added by someone else.` });
      return;
    }
    this.userEmoji.delete(msg.name);
    void deleteUserEmoji(this.cfg, `${EMOJI_ROUTE}${existing.file}`, this.log);
    this.log.info({ name: msg.name, by: session.info.name }, 'emoji removed');
    this.broadcastEmoji();
  }

  /** Push the current merged emoji set to everyone so pickers + `:name:` rendering update live. */
  private broadcastEmoji(): void {
    this.broadcastAll({ type: 'emojiUpdate', emoji: this.emojiManifest() });
  }

  private handlePrivateMessage(
    session: Session,
    conn: Connection,
    msg: Extract<ClientMessage, { type: 'privateMessage' }>,
  ): void {
    const target = this.state.sessions.get(msg.to);
    if (!target) {
      conn.send({ type: 'error', message: 'user is offline' });
      return;
    }
    const pm: ServerMessage = {
      type: 'privateMessage',
      from: session.info.token,
      to: msg.to,
      text: msg.text,
    };
    // Delivered to every window of the recipient…
    this.sendToUser(target, pm);
    // …and mirrored to the sender's *other* windows so every window/device of the
    // sender converges on the same thread. The originating window renders its own
    // line optimistically, so we skip it here (and skip the whole mirror when a user
    // PMs themselves — the recipient fan-out above already reached all their windows).
    if (target !== session) this.sendToUserExcept(session, conn, pm);
  }

  // -- helpers --------------------------------------------------------------

  /**
   * Map an identity key to its stable user token and stored profile: reuse the bound
   * token if the identity is known (whether or not it is currently online — a live one
   * means a second window that handleLogin multiplexes onto the same user), carrying its
   * others-visible profile if one has been set; mint + bind on first sight; and fall back
   * to a fresh one-off token (no profile, never persisted) when no key was given.
   */
  private resolveIdentity(identityKey: string | undefined): {
    token: Token;
    profile?: IdentityProfile;
  } {
    if (identityKey) {
      const known = this.identity.tokenFor(identityKey);
      if (known !== undefined)
        return { token: known, profile: this.identity.profileFor(identityKey) };
      const token = this.state.allocUserToken();
      this.identity.bind(identityKey, token);
      return { token };
    }
    return { token: this.state.allocUserToken() };
  }

  // Resolve a free display name, suffixing "2", "3"… on a case-insensitive clash.
  // `exceptToken` skips that user (a rename must not clash with its own current name).
  private uniqueName(requested: string, exceptToken?: Token): string {
    const base = requested.trim() || 'guest';
    let name = base;
    let suffix = 2;
    while (this.nameClashes(name, exceptToken)) name = `${base}${suffix++}`;
    return name;
  }

  private nameClashes(name: string, exceptToken?: Token): boolean {
    const lower = name.toLowerCase();
    for (const session of this.state.sessions.values()) {
      if (session.info.token === exceptToken) continue;
      if (session.info.name.toLowerCase() === lower) return true;
    }
    return false;
  }

  /** Send to every window of one user. */
  private sendToUser(session: Session, message: ServerMessage): void {
    for (const conn of session.connections) conn.send(message);
  }

  /** Send to every window of one user except one connection (which handled it itself). */
  private sendToUserExcept(session: Session, except: Connection, message: ServerMessage): void {
    for (const conn of session.connections) if (conn !== except) conn.send(message);
  }

  // Fan out to every session; `exceptToken` omits the originator so a sender
  // doesn't receive an echo of their own event (connect, away, …).
  private broadcastAll(message: ServerMessage, exceptToken?: Token): void {
    for (const session of this.state.sessions.values()) {
      if (session.info.token !== exceptToken) this.sendToUser(session, message);
    }
  }

  private broadcastChannel(channelToken: Token, message: ServerMessage, exceptToken?: Token): void {
    const channel = this.state.channelsByToken.get(channelToken);
    if (!channel) return;
    for (const token of channel.members) {
      if (token === exceptToken) continue;
      const member = this.state.sessions.get(token);
      if (member) this.sendToUser(member, message);
    }
  }
}
