/**
 * @mara/client-core — transport-agnostic Mara client: WebSocket session,
 * handshake + reconnect + heartbeat, typed events, and live Svelte stores.
 */
export { MaraClient } from './client.js';
export { Emitter } from './events.js';
export type {
  ChannelState,
  ChatLine,
  ClientEvents,
  ClientOptions,
  ConnectionState,
  WebSocketCtor,
  WebSocketLike,
} from './types.js';

// Re-export protocol types most consumers need alongside the client.
export type { Token, UserInfo, Color } from '@mara/protocol';
