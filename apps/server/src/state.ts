// In-memory registry of live sessions and channels — the hub's single source of truth.
import type { Token, UserInfo } from '@mara/protocol';
import type { Connection } from './connection.js';
import type { IdentityStore } from './identity.js';
import { nextToken } from './tokens.js';

/**
 * A logged-in user and every live socket backing them. The same identity opened
 * in a second window multiplexes onto one Session: presence, channel membership
 * and message fan-out are per-user, while each socket keeps its own upload bearer.
 */
export interface Session {
  info: UserInfo;
  /** All live sockets for this user (more than one = same identity in >1 window). */
  connections: Set<Connection>;
  channels: Set<Token>;
}

/** A chat channel and its current membership (by user token). Message backlog
 *  lives in the HistoryStore (keyed by name), not here, so it can outlive an
 *  empty/pruned channel and persist across restarts. */
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
  // Secondary indexes kept in lockstep with the primaries above so name/session
  // lookups stay O(1); every add/remove must update both sides.
  private readonly channelTokenByName = new Map<string, Token>();
  private readonly sessionTokens = new Map<string, Token>();

  constructor(private readonly identity: IdentityStore) {}

  /**
   * Mint a user token free among live sessions AND not reserved by an offline
   * identity, so a new user can't be handed a token a returning client owns.
   */
  allocUserToken(): Token {
    return nextToken((t) => this.sessions.has(t) || this.identity.reserves(t));
  }

  /** Mint a channel token unique among existing channels. */
  allocChannelToken(): Token {
    return nextToken((t) => this.channelsByToken.has(t));
  }

  /** Register a brand-new user from its first connection. */
  addSession(session: Session): void {
    this.sessions.set(session.info.token, session);
    for (const conn of session.connections) {
      if (conn.sessionToken) this.sessionTokens.set(conn.sessionToken, session.info.token);
    }
  }

  /** Attach an additional socket (a second window) to an already-online user. */
  attachConnection(session: Session, conn: Connection): void {
    session.connections.add(conn);
    if (conn.sessionToken) this.sessionTokens.set(conn.sessionToken, session.info.token);
  }

  /**
   * Detach a closing socket from its user. Returns the session and whether this
   * was the user's *last* connection — only then is the user truly offline, so
   * only then should the caller scrub channels and announce a disconnect.
   */
  removeConnection(conn: Connection): { session: Session; lastClosed: boolean } | undefined {
    if (conn.userToken === null) return undefined;
    const session = this.sessions.get(conn.userToken);
    if (!session) return undefined;
    session.connections.delete(conn);
    if (conn.sessionToken) this.sessionTokens.delete(conn.sessionToken);
    if (session.connections.size > 0) return { session, lastClosed: false };
    // Last socket gone: scrub stale membership so broadcasts never target a gone
    // user. Empty channels are left behind here; pruneChannel handles explicit leave.
    for (const channelToken of session.channels) {
      this.channelsByToken.get(channelToken)?.members.delete(session.info.token);
    }
    this.sessions.delete(session.info.token);
    return { session, lastClosed: true };
  }

  /** Resolve a session from its per-session secret (the upload bearer credential). */
  sessionBySessionToken(sessionToken: string): Session | undefined {
    const token = this.sessionTokens.get(sessionToken);
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
