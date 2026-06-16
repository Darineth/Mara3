import type { Token, UserInfo, UserStyle } from '@mara/protocol';
import type { TextPipeline } from '@mara/plugin-api';

/** High-level connection lifecycle the UI binds to. */
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
  id: number;
  kind: 'chat' | 'emote' | 'system';
  /** Author token, or null for system lines. */
  from: Token | null;
  text: string;
  at: number;
}

/** Options for {@link MaraClient}. */
export interface ClientOptions {
  url: string;
  name: string;
  style: UserStyle;
  appVersion?: number;
  /** Inject a WebSocket implementation (browser uses the global by default). */
  webSocket?: WebSocketCtor;
  autoReconnect?: boolean;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  heartbeatIntervalMs?: number;
  /** Max retained lines per conversation. */
  historyLimit?: number;
  /** Plugin pipeline applied to outgoing and incoming chat/emote text. */
  plugins?: TextPipeline;
  now?: () => number;
}

/** Events emitted by {@link MaraClient} for code that prefers callbacks to stores. */
export interface ClientEvents {
  statusChanged: ConnectionState;
  connected: { token: Token; name: string };
  loginDenied: { reason: string; updateRequired: boolean };
  error: { code: number; message: string };
  userConnect: UserInfo;
  userDisconnect: { token: Token };
  userUpdate: UserInfo;
  channelJoined: ChannelState;
  channelLeft: { channelToken: Token };
  userJoinedChannel: { token: Token; channelToken: Token };
  userLeftChannel: { token: Token; channelToken: Token };
  chat: { from: Token; channelToken: Token; text: string };
  emote: { from: Token; channelToken: Token; text: string };
  away: { token: Token; text: string };
  privateMessage: { from: Token; text: string };
  serverMessage: { text: string };
  pong: { pingId: number; rtt: number };
  kicked: { reason: string };
}

// -- minimal cross-platform WebSocket shape ---------------------------------

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export type WebSocketCtor = new (url: string) => WebSocketLike;
