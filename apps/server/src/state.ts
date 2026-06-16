import type { Token, UserInfo } from '@mara/protocol';
import type { Connection } from './connection.js';
import { nextToken } from './tokens.js';

/** A logged-in user and the connection currently backing them. */
export interface Session {
  info: UserInfo;
  resumeToken: string;
  connection: Connection;
  channels: Set<Token>;
}

/** A chat channel and its current membership (by user token). */
export interface Channel {
  token: Token;
  name: string;
  members: Set<Token>;
}

/**
 * All shared server state. Because Node runs handlers on a single thread, every
 * mutation here is naturally serialized — no locks needed (this is what the
 * migration plan's "single dispatcher" buys us for free).
 */
export class ServerState {
  readonly sessions = new Map<Token, Session>();
  readonly channelsByToken = new Map<Token, Channel>();
  private readonly channelTokenByName = new Map<string, Token>();
  private readonly resumeTokens = new Map<string, Token>();

  allocUserToken(): Token {
    return nextToken((t) => this.sessions.has(t));
  }

  allocChannelToken(): Token {
    return nextToken((t) => this.channelsByToken.has(t));
  }

  addSession(session: Session): void {
    this.sessions.set(session.info.token, session);
    this.resumeTokens.set(session.resumeToken, session.info.token);
  }

  removeSession(token: Token): Session | undefined {
    const session = this.sessions.get(token);
    if (!session) return undefined;
    for (const channelToken of session.channels) {
      this.channelsByToken.get(channelToken)?.members.delete(token);
    }
    this.sessions.delete(token);
    this.resumeTokens.delete(session.resumeToken);
    return session;
  }

  sessionByResumeToken(resumeToken: string): Session | undefined {
    const token = this.resumeTokens.get(resumeToken);
    return token === undefined ? undefined : this.sessions.get(token);
  }

  /** Find or create a channel by name. */
  getOrCreateChannel(name: string): Channel {
    const existing = this.channelTokenByName.get(name);
    if (existing !== undefined) {
      const channel = this.channelsByToken.get(existing);
      if (channel) return channel;
    }
    const channel: Channel = { token: this.allocChannelToken(), name, members: new Set() };
    this.channelsByToken.set(channel.token, channel);
    this.channelTokenByName.set(name, channel.token);
    return channel;
  }

  /** Remove a channel once it has no members. */
  pruneChannel(token: Token): void {
    const channel = this.channelsByToken.get(token);
    if (channel && channel.members.size === 0) {
      this.channelsByToken.delete(token);
      this.channelTokenByName.delete(channel.name);
    }
  }

  /** Whether a (case-insensitive) display name is already in use. */
  isNameTaken(name: string): boolean {
    const lower = name.toLowerCase();
    for (const session of this.sessions.values()) {
      if (session.info.name.toLowerCase() === lower) return true;
    }
    return false;
  }
}
