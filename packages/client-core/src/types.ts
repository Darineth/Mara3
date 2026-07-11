/**
 * @mara/client-core — public types for the client: connection lifecycle,
 * UI-facing view models (channels / chat lines), constructor options, the
 * event payload map, and the minimal cross-platform WebSocket interface.
 */
import type { Color, ReplyRef, Token, UserInfo } from '@mara/protocol';
import type { TextPipeline } from '@mara/plugin-api';

/**
 * High-level connection lifecycle the UI binds to. Distinct from the raw
 * WebSocket readyState: `authenticating` covers the post-open login round-trip
 * (client sends `login`, awaits `welcome`), `denied` is a terminal auth failure
 * (no auto-reconnect), and `reconnecting` is an automatic retry after a drop.
 */
export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'active'
  | 'reconnecting'
  | 'denied'
  | 'closed';

/** A channel as tracked on the client, with its current membership. */
export interface ChannelState {
  token: Token;
  name: string;
  members: Set<Token>;
}

/** One rendered line in a conversation (channel or private). */
export interface ChatLine {
  /** Client-assigned monotonic sequence; stable key for list rendering (not a server id). */
  id: number;
  /** Server-assigned message id for channel chat/emote lines (from the live frame or
   *  backlog). Used to dedupe backlog against lines we already hold. Absent on
   *  system/notice/away lines and private messages (the server doesn't id those). */
  serverId?: number;
  /** `notice` is a client-synthesized, prominently-styled server notice (the MOTD);
   *  `away` is an away/back status line shown in the author's colour (carries `from`);
   *  `cleared` is a client-only marker left where the user cleared their local backlog —
   *  clicking it re-fetches server history (see `MaraClient.clearChannel`/`restoreChannel`). */
  kind: 'chat' | 'emote' | 'system' | 'notice' | 'away' | 'cleared';
  /** Author token, or null for system/notice lines. */
  from: Token | null;
  text: string;
  /** Receipt timestamp (ms) from the client's clock, not the server's. */
  at: number;
  /** The message this one replies to, snapshotted by the server (author + a short excerpt),
   *  so the quote renders even when the parent isn't among the lines we hold. Channel
   *  chat/emote only — the server ids and stores nothing for PMs, so they can't be replied to. */
  replyTo?: ReplyRef;
}

/**
 * A device-locally persisted PM conversation, restored at client construction.
 * The server deliberately never stores or replays PMs, so restored lines can't
 * collide with live ones. The name/colour snapshot lets restored lines render
 * while the peer is offline; line ids are reassigned on restore.
 */
export interface RestoredPmConversation {
  peer: Token;
  name: string;
  color: Color;
  lines: Omit<ChatLine, 'id'>[];
}

/** Options for {@link MaraClient}. */
export interface ClientOptions {
  url: string;
  name: string;
  /** The user's display colour (`#rrggbb`); the only per-user styling. */
  color: Color;
  /**
   * Stable, client-persisted identity secret. Sent on every login so the server
   * hands back the same user token across reconnects and restarts. Omit for a
   * one-off (non-persistent) identity.
   */
  identityKey?: string;
  /** Inject a WebSocket implementation (browser uses the global by default). */
  webSocket?: WebSocketCtor;
  autoReconnect?: boolean;
  /** Base for exponential backoff (delay = base * 2^attempt), capped by max. */
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  /** Heartbeat ping cadence while active; <= 0 disables heartbeats. */
  heartbeatIntervalMs?: number;
  /** Max retained lines per conversation. */
  historyLimit?: number;
  /** Channel names to (re)join on connect — the persisted "channels you were in",
   *  so a fresh session restores them. Rejoining is idempotent server-side. */
  initialChannels?: string[];
  /** Device-local PM history to restore, symmetric with `initialChannels` (see
   *  {@link RestoredPmConversation}; the server never stores PMs). */
  initialPrivateMessages?: RestoredPmConversation[];
  /** Plugin pipeline applied to outgoing and incoming chat/emote text. */
  plugins?: TextPipeline;
  /** Clock injection point (defaults to Date.now); lets tests drive timestamps/RTT. */
  now?: () => number;
}

/** Events emitted by {@link MaraClient} for code that prefers callbacks to stores. */
export interface ClientEvents {
  statusChanged: ConnectionState;
  connected: { token: Token; name: string };
  loginDenied: { reason: string; code?: string };
  error: { message: string };
  userConnect: UserInfo;
  /** `channelTokens` are the channels the user was in at disconnect (captured before
   *  removal), so listeners can note the departure per channel. */
  userDisconnect: { token: Token; channelTokens: Token[] };
  channelJoined: ChannelState;
  /** `reason` is 'left' for a real departure (we left / were removed — log-worthy) vs
   *  'replaced' when the server reassigned the channel a new token (internal churn, not a
   *  user action). `name` is the channel name, captured before the token is dropped. */
  channelLeft: { channelToken: Token; name: string; reason: 'left' | 'replaced' };
  userJoinedChannel: { token: Token; channelToken: Token };
  userLeftChannel: { token: Token; channelToken: Token };
  /** A user changed their display name and/or colour mid-session. */
  userProfile: UserInfo;
  chat: { from: Token; channelToken: Token; text: string };
  emote: { from: Token; channelToken: Token; text: string };
  away: { token: Token; text: string };
  privateMessage: { from: Token; text: string };
  /** Our own outgoing PM. Fires in the window that sent it, and in the user's other
   *  windows/devices when the server mirrors the PM to them — so every window logs the
   *  sent line. `to` is the recipient token. */
  privateMessageSent: { to: Token; text: string };
  pong: { id: number; rtt: number };
}

// -- minimal cross-platform WebSocket shape ---------------------------------

/**
 * The subset of the WebSocket API the client relies on. Lets the same code run
 * against the browser global and Node's `ws` (injected in tests) without a hard
 * dependency on either's full type.
 */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

/** Constructor for a {@link WebSocketLike}; matches both the DOM `WebSocket` and `ws`. */
export type WebSocketCtor = new (url: string) => WebSocketLike;
