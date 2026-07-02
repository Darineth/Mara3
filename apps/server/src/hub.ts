import { existsSync, readFileSync } from 'node:fs';
import {
  MOTD_MAX_LEN,
  PROTOCOL_VERSION,
  safeParseClientMessage,
  type ClientMessage,
  type ServerInfo,
  type ServerMessage,
  type Token,
  type UserInfo,
} from '@mara/protocol';
import type { Connection } from './connection.js';
import type { ServerConfig } from './config.js';
import { HistoryStore } from './history.js';
import { IdentityStore } from './identity.js';
import type { Logger } from './logger.js';
import { ServerState, type Session } from './state.js';
import { makeSessionToken } from './tokens.js';
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
  /** Monotonic message-id counter; seeded from persisted history so ids keep increasing
   *  across restarts. Each chat/emote gets `++this.nextMessageId`. */
  private nextMessageId: number;
  /** Our version + the web build we serve; echoed in every `welcome`. */
  readonly serverInfo: ServerInfo;

  constructor(
    private readonly cfg: ServerConfig,
    private readonly log: Logger,
    // Clock is injectable so tests get deterministic message timestamps.
    private readonly now: () => number = Date.now,
  ) {
    this.history = new HistoryStore(cfg.historyFile, log);
    this.nextMessageId = this.history.maxId();
    this.identity = new IdentityStore(cfg.identityFile, log);
    this.state = new ServerState(this.identity);
    this.serverInfo = getServerInfo(cfg.webRoot, cfg.serverName);
  }

  /** Persist any pending history + identities synchronously (call on shutdown). */
  flush(): void {
    this.history.flush();
    this.identity.flush();
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
    const result = this.state.removeConnection(conn);
    if (result?.lastClosed) {
      this.log.info({ user: result.session.info.name }, 'disconnected');
      this.broadcastAll(
        { type: 'userDisconnect', token: result.session.info.token, at: this.now() },
        result.session.info.token,
      );
    } else if (result) {
      this.log.debug({ user: result.session.info.name }, 'window closed (still online elsewhere)');
    }
    conn.state = 'closed';
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
        return this.handleChannelText(session, conn, msg.channelToken, msg.text, 'chat');
      case 'emote':
        return this.handleChannelText(session, conn, msg.channelToken, msg.text, 'emote');
      case 'away':
        return this.handleAway(session, msg);
      case 'setProfile':
        return this.handleSetProfile(session, msg);
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

    const token = this.resolveToken(msg.identityKey);
    const sessionToken = makeSessionToken();
    conn.userToken = token;
    conn.sessionToken = sessionToken;
    conn.state = 'active';

    // Second window for an identity that is already online: multiplex this socket
    // onto the live user instead of spawning a duplicate. No new presence is
    // announced — they were already here — we just bring this window into sync.
    const live = this.state.sessions.get(token);
    if (live) {
      this.state.attachConnection(live, conn);
      this.log.info({ user: live.info.name, token }, 'additional window');
      conn.send({
        type: 'welcome',
        self: live.info,
        sessionToken,
        motd: this.currentMotd(),
        server: this.serverInfo,
        at: this.now(),
      });
      for (const channelToken of live.channels) {
        const channel = this.state.channelsByToken.get(channelToken);
        if (channel) this.sendChannelSnapshot(conn, channel);
      }
      return;
    }

    const name = this.uniqueName(msg.name);
    const info: UserInfo = { token, name, color: msg.color, away: '' };
    const session: Session = { info, connections: new Set([conn]), channels: new Set() };
    this.state.addSession(session);
    this.log.info({ user: name, token }, 'logged in');

    conn.send({
      type: 'welcome',
      self: info,
      sessionToken,
      motd: this.currentMotd(),
      server: this.serverInfo,
      at: this.now(),
    });
    this.broadcastAll({ type: 'userConnect', user: info }, token);

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
    // Only announce a genuinely new membership (idempotent on rejoin/resume).
    if (!alreadyMember) {
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

  /** Reply to a `requestHistory` with a page of older messages for a channel the session
   *  is in. Cursor is `before` (a message id); the server decides the page size. */
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
    const { entries, hasMore } = this.history.before(
      channel.name,
      msg.before,
      this.cfg.historyChunk,
    );
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
  ): void {
    const channel = this.state.channelsByToken.get(channelToken);
    if (!channel || !session.channels.has(channelToken)) {
      conn.send({ type: 'error', message: 'not in that channel' });
      return;
    }
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
    });
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
    if (changed) this.broadcastAll({ type: 'userProfile', user: session.info });
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
    // Delivered to every window of the recipient; the sender records its own
    // outgoing line locally (in the window that sent it).
    this.sendToUser(target, { type: 'privateMessage', from: session.info.token, text: msg.text });
  }

  // -- helpers --------------------------------------------------------------

  /**
   * Map an identity key to a stable user token: reuse the bound token if the
   * identity is known (whether or not it is currently online — a live one means a
   * second window that handleLogin multiplexes onto the same user); mint + bind on
   * first sight; and fall back to a fresh one-off token when no key was given.
   */
  private resolveToken(identityKey: string | undefined): Token {
    if (identityKey) {
      const known = this.identity.tokenFor(identityKey);
      if (known !== undefined) return known;
      const token = this.state.allocUserToken();
      this.identity.bind(identityKey, token);
      return token;
    }
    return this.state.allocUserToken();
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
