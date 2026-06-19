import {
  MARA_VERSION,
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
import { makeResumeToken } from './tokens.js';

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
    private readonly now: () => number = Date.now,
  ) {}

  onConnect(conn: Connection): void {
    this.log.debug({ conn: conn.id }, 'connected');
    conn.send({ type: 'serverHello', maraVersion: MARA_VERSION, serverName: this.cfg.serverName });
  }

  onMessage(conn: Connection, raw: string): void {
    const parsed = safeParseClientMessage(raw);
    if (!parsed.success) {
      conn.send({ type: 'error', code: 400, message: parsed.error.message });
      return;
    }
    try {
      this.dispatch(conn, parsed.data);
    } catch (err) {
      this.log.error({ err, conn: conn.id }, 'handler threw');
      conn.send({ type: 'error', code: 500, message: 'internal error' });
    }
  }

  onClose(conn: Connection): void {
    if (conn.userToken !== null) {
      const session = this.state.removeSession(conn.userToken);
      if (session) {
        this.log.info({ user: session.info.name }, 'disconnected');
        this.broadcastAll(
          { type: 'userDisconnect', token: session.info.token, reason: '' },
          session.info.token,
        );
      }
    }
    conn.state = 'closed';
  }

  // -- dispatch -------------------------------------------------------------

  private dispatch(conn: Connection, msg: ClientMessage): void {
    if (msg.type === 'clientVersion') return this.handleVersion(conn, msg);
    if (msg.type === 'login') return this.handleLogin(conn, msg);

    if (conn.state !== 'active' || conn.userToken === null) {
      conn.send({ type: 'error', code: 401, message: 'not logged in' });
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
      case 'userUpdate':
        return this.handleUserUpdate(session, msg);
      case 'ping':
        return this.handlePing(session, msg);
      case 'serverCommand':
        return this.handleServerCommand(session, msg);
      case 'queryUser':
        return this.handleQueryUser(session, msg);
      case 'pluginData':
        return this.handlePluginData(session, msg);
      case 'disconnect':
        return conn.close(1000, 'client disconnect');
    }
  }

  // -- handshake ------------------------------------------------------------

  private handleVersion(
    conn: Connection,
    msg: Extract<ClientMessage, { type: 'clientVersion' }>,
  ): void {
    if (conn.state !== 'awaitingVersion') return;
    if (msg.appVersion < this.cfg.minAppVersion) {
      conn.send({ type: 'loginDenied', reason: 'client out of date', updateRequired: true });
      conn.close(4001, 'update required');
      return;
    }
    conn.state = 'awaitingLogin';
    conn.send({ type: 'response', ref: 'clientVersion', ok: true, code: 0, message: '' });
  }

  private handleLogin(conn: Connection, msg: Extract<ClientMessage, { type: 'login' }>): void {
    if (conn.state !== 'awaitingLogin') {
      conn.send({ type: 'error', code: 409, message: 'unexpected login' });
      return;
    }
    const name = this.uniqueName(msg.name);
    const token = this.state.allocUserToken();
    const resumeToken = makeResumeToken();
    const info: UserInfo = { token, name, style: msg.style, away: '' };
    const session: Session = { info, resumeToken, connection: conn, channels: new Set() };
    this.state.addSession(session);

    conn.userToken = token;
    conn.state = 'active';
    this.log.info({ user: name, token }, 'logged in');

    conn.send({ type: 'loginAccepted', token, name, resumeToken, motd: this.cfg.motd });
    this.broadcastAll({ type: 'userConnect', user: info, reconnect: false }, token);

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
    if (!session.channels.has(channelToken)) {
      session.connection.send({
        type: 'response',
        ref: kind,
        ok: false,
        code: 403,
        message: 'not in channel',
      });
      return;
    }
    this.broadcastChannel(channelToken, {
      type: kind,
      from: session.info.token,
      channelToken,
      text,
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
    const target = this.state.sessions.get(msg.toUserToken);
    if (!target) {
      session.connection.send({
        type: 'response',
        ref: 'privateMessage',
        ok: false,
        code: 404,
        message: 'user offline',
      });
      return;
    }
    target.connection.send({ type: 'privateMessage', from: session.info.token, text: msg.text });
    session.connection.send({
      type: 'response',
      ref: 'privateMessage',
      ok: true,
      code: 0,
      message: '',
    });
  }

  private handleUserUpdate(
    session: Session,
    msg: Extract<ClientMessage, { type: 'userUpdate' }>,
  ): void {
    session.info.name = this.uniqueName(msg.name, session.info.token);
    session.info.style = msg.style;
    this.broadcastAll({
      type: 'userUpdate',
      token: session.info.token,
      name: session.info.name,
      style: session.info.style,
    });
  }

  private handlePing(session: Session, msg: Extract<ClientMessage, { type: 'ping' }>): void {
    session.connection.send({
      type: 'pong',
      pingId: msg.pingId,
      sentAt: msg.sentAt,
      serverTime: this.now(),
    });
  }

  private handleServerCommand(
    session: Session,
    msg: Extract<ClientMessage, { type: 'serverCommand' }>,
  ): void {
    if (msg.command === 'who') {
      const names = [...this.state.sessions.values()].map((s) => s.info.name).join(', ');
      session.connection.send({
        type: 'serverMessage',
        text: `Online (${this.state.sessions.size}): ${names}`,
      });
      return;
    }
    session.connection.send({
      type: 'response',
      ref: 'serverCommand',
      ok: false,
      code: 404,
      message: `unknown command: ${msg.command}`,
    });
  }

  private handleQueryUser(
    session: Session,
    msg: Extract<ClientMessage, { type: 'queryUser' }>,
  ): void {
    const target = this.state.sessions.get(msg.token);
    if (target) {
      session.connection.send({ type: 'userInfo', user: target.info });
    } else {
      session.connection.send({
        type: 'response',
        ref: 'queryUser',
        ok: false,
        code: 404,
        message: 'unknown user',
      });
    }
  }

  private handlePluginData(
    session: Session,
    msg: Extract<ClientMessage, { type: 'pluginData' }>,
  ): void {
    if (msg.toUserToken !== undefined) {
      this.state.sessions
        .get(msg.toUserToken)
        ?.connection.send({ type: 'pluginData', from: session.info.token, data: msg.data });
      return;
    }
    this.broadcastAll(
      { type: 'pluginData', from: session.info.token, data: msg.data },
      session.info.token,
    );
  }

  // -- helpers --------------------------------------------------------------

  private uniqueName(requested: string, ignore?: Token): string {
    let name = requested.trim() || 'guest';
    let suffix = 2;
    while (this.nameClashes(name, ignore)) {
      name = `${requested}${suffix++}`;
    }
    return name;
  }

  private nameClashes(name: string, ignore?: Token): boolean {
    const lower = name.toLowerCase();
    for (const session of this.state.sessions.values()) {
      if (session.info.token !== ignore && session.info.name.toLowerCase() === lower) return true;
    }
    return false;
  }

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
