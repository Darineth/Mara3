import {
  PROTOCOL_VERSION,
  safeParseClientMessage,
  type ClientMessage,
  type ServerMessage,
  type Token,
  type UserInfo,
} from '@mara/protocol';
import type { Connection } from './connection.js';
import type { ServerConfig } from './config.js';
import type { Logger } from './logger.js';
import { ServerState, type Session } from './state.js';
import { makeSessionToken } from './tokens.js';

/**
 * The message-handling core. One instance owns all shared state and processes
 * every client message synchronously on Node's event loop, so state mutations
 * never interleave — the modern equivalent of Mara 2's single-thread Qt server.
 */
export class Hub {
  readonly state = new ServerState();

  constructor(
    private readonly cfg: ServerConfig,
    private readonly log: Logger,
    // Clock is injectable so tests get deterministic message timestamps.
    private readonly now: () => number = Date.now,
  ) {}

  onConnect(conn: Connection): void {
    // The client speaks first (`login`); nothing to send on connect.
    this.log.debug({ conn: conn.id }, 'connected');
  }

  onMessage(conn: Connection, raw: string): void {
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
    // Only logged-in connections have presence to tear down; a socket that dropped
    // before login (userToken still null) leaves no state to clean up.
    if (conn.userToken !== null) {
      const session = this.state.removeSession(conn.userToken);
      if (session) {
        this.log.info({ user: session.info.name }, 'disconnected');
        this.broadcastAll(
          { type: 'userDisconnect', token: session.info.token },
          session.info.token,
        );
      }
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
        return this.handleChannelText(session, msg.channelToken, msg.text, 'chat');
      case 'emote':
        return this.handleChannelText(session, msg.channelToken, msg.text, 'emote');
      case 'away':
        return this.handleAway(session, msg);
      case 'privateMessage':
        return this.handlePrivateMessage(session, msg);
      case 'ping':
        return session.connection.send({ type: 'pong', id: msg.id });
    }
  }

  // -- login ----------------------------------------------------------------

  private handleLogin(conn: Connection, msg: Extract<ClientMessage, { type: 'login' }>): void {
    if (conn.state !== 'awaitingLogin') {
      conn.send({ type: 'error', message: 'already logged in' });
      return;
    }
    if (msg.protocol !== PROTOCOL_VERSION) {
      conn.send({ type: 'loginDenied', reason: 'protocol version mismatch — please update' });
      // 4001: app-defined WS close code (4000–4999) meaning "must update".
      conn.close(4001, 'protocol mismatch');
      return;
    }

    const name = this.uniqueName(msg.name);
    const token = this.state.allocUserToken();
    const sessionToken = makeSessionToken();
    const info: UserInfo = { token, name, color: msg.color, away: '' };
    const session: Session = { info, sessionToken, connection: conn, channels: new Set() };
    this.state.addSession(session);

    conn.userToken = token;
    conn.state = 'active';
    this.log.info({ user: name, token }, 'logged in');

    conn.send({ type: 'welcome', self: info, sessionToken, motd: this.cfg.motd });
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

    const users: UserInfo[] = [];
    for (const token of channel.members) {
      const member = this.state.sessions.get(token);
      if (member) users.push(member.info);
    }
    session.connection.send({
      type: 'channelJoined',
      channelToken: channel.token,
      channel: channel.name,
      users,
      history: channel.history,
    });
    // Only announce a genuinely new membership (idempotent on rejoin/resume).
    if (!alreadyMember) {
      this.broadcastChannel(
        channel.token,
        { type: 'userJoinedChannel', token: session.info.token, channelToken: channel.token },
        session.info.token,
      );
    }
  }

  private handleLeaveChannel(
    session: Session,
    msg: Extract<ClientMessage, { type: 'leaveChannel' }>,
  ): void {
    const channel = this.state.channelsByToken.get(msg.channelToken);
    if (!channel || !session.channels.has(channel.token)) return;
    channel.members.delete(session.info.token);
    session.channels.delete(channel.token);
    session.connection.send({ type: 'channelLeft', channelToken: channel.token });
    this.broadcastChannel(channel.token, {
      type: 'userLeftChannel',
      token: session.info.token,
      channelToken: channel.token,
    });
    this.state.pruneChannel(channel.token);
  }

  private handleChannelText(
    session: Session,
    channelToken: Token,
    text: string,
    kind: 'chat' | 'emote',
  ): void {
    const channel = this.state.channelsByToken.get(channelToken);
    if (!channel || !session.channels.has(channelToken)) {
      session.connection.send({ type: 'error', message: 'not in that channel' });
      return;
    }
    // Server-stamp the message, retain it as capped backlog, then broadcast it.
    const at = this.now();
    channel.history.push({
      from: session.info.token,
      name: session.info.name,
      color: session.info.color,
      kind,
      text,
      at,
    });
    if (channel.history.length > this.cfg.historyLimit) {
      channel.history.splice(0, channel.history.length - this.cfg.historyLimit);
    }
    this.broadcastChannel(channelToken, {
      type: kind,
      from: session.info.token,
      channelToken,
      text,
      at,
    });
  }

  private handleAway(session: Session, msg: Extract<ClientMessage, { type: 'away' }>): void {
    session.info.away = msg.text;
    this.broadcastAll({ type: 'away', token: session.info.token, text: msg.text });
  }

  private handlePrivateMessage(
    session: Session,
    msg: Extract<ClientMessage, { type: 'privateMessage' }>,
  ): void {
    const target = this.state.sessions.get(msg.to);
    if (!target) {
      session.connection.send({ type: 'error', message: 'user is offline' });
      return;
    }
    // Delivered to the recipient only; the sender records its own line locally.
    target.connection.send({ type: 'privateMessage', from: session.info.token, text: msg.text });
  }

  // -- helpers --------------------------------------------------------------

  // Resolve a free display name, suffixing "2", "3"… on a case-insensitive clash.
  private uniqueName(requested: string): string {
    const base = requested.trim() || 'guest';
    let name = base;
    let suffix = 2;
    while (this.nameClashes(name)) name = `${base}${suffix++}`;
    return name;
  }

  private nameClashes(name: string): boolean {
    const lower = name.toLowerCase();
    for (const session of this.state.sessions.values()) {
      if (session.info.name.toLowerCase() === lower) return true;
    }
    return false;
  }

  // Fan out to every session; `exceptToken` omits the originator so a sender
  // doesn't receive an echo of their own event (connect, away, …).
  private broadcastAll(message: ServerMessage, exceptToken?: Token): void {
    for (const session of this.state.sessions.values()) {
      if (session.info.token !== exceptToken) session.connection.send(message);
    }
  }

  private broadcastChannel(channelToken: Token, message: ServerMessage, exceptToken?: Token): void {
    const channel = this.state.channelsByToken.get(channelToken);
    if (!channel) return;
    for (const token of channel.members) {
      if (token === exceptToken) continue;
      this.state.sessions.get(token)?.connection.send(message);
    }
  }
}
