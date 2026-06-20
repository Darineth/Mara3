import { z } from 'zod';
import { chatTextSchema, colorSchema, tokenSchema, userInfoSchema } from './primitives.js';

/**
 * The Mara message set. Split by direction into two discriminated unions so each
 * side validates only what it can legitimately receive — and so a `chat` the
 * client *sends* (no author) and a `chat` the server *broadcasts* (with an
 * author token) can reuse the same `type` literal with direction-appropriate
 * shapes without colliding.
 *
 * Wire shape is flat JSON: `{ type: 'chat', channelToken, text }`.
 *
 * Lifecycle: the client opens the socket and sends `login` immediately; the
 * server replies `welcome` (success) or `loginDenied`. There is no separate
 * version/hello round-trip — the protocol version rides on `login`.
 */

// ---------------------------------------------------------------------------
// Client → Server
// ---------------------------------------------------------------------------

const login = z.object({
  type: z.literal('login'),
  /** Wire-protocol version the client speaks; the server denies a mismatch. */
  protocol: z.number().int().nonnegative(),
  name: z.string().min(1).max(64),
  color: colorSchema,
});

const joinChannel = z.object({
  type: z.literal('joinChannel'),
  channel: z.string().min(1).max(64),
});

const leaveChannel = z.object({
  type: z.literal('leaveChannel'),
  channelToken: tokenSchema,
});

const clientChat = z.object({
  type: z.literal('chat'),
  channelToken: tokenSchema,
  text: chatTextSchema,
});

const clientEmote = z.object({
  type: z.literal('emote'),
  channelToken: tokenSchema,
  text: chatTextSchema,
});

const clientPrivateMessage = z.object({
  type: z.literal('privateMessage'),
  to: tokenSchema,
  text: chatTextSchema,
});

const clientAway = z.object({
  type: z.literal('away'),
  /** Away note; empty string clears away status. */
  text: z.string().max(512),
});

const ping = z.object({
  type: z.literal('ping'),
  /** Client-chosen id echoed back in `pong`, for liveness + RTT. */
  id: z.number().int().nonnegative(),
});

export const clientMessageSchema = z.discriminatedUnion('type', [
  login,
  joinChannel,
  leaveChannel,
  clientChat,
  clientEmote,
  clientPrivateMessage,
  clientAway,
  ping,
]);
/** Any validated client→server message. */
export type ClientMessage = z.infer<typeof clientMessageSchema>;
/** The discriminator literals of every client→server message. */
export type ClientMessageType = ClientMessage['type'];

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------

const welcome = z.object({
  type: z.literal('welcome'),
  /** The logged-in user's own info (token, the possibly-deduped name, colour). */
  self: userInfoSchema,
  /** Per-session secret for authenticated HTTP calls (e.g. image upload). */
  sessionToken: z.string().max(128),
  motd: z.string().max(8192).default(''),
});

const loginDenied = z.object({
  type: z.literal('loginDenied'),
  reason: z.string().max(512),
});

const userConnect = z.object({
  type: z.literal('userConnect'),
  user: userInfoSchema,
});

const userDisconnect = z.object({
  type: z.literal('userDisconnect'),
  token: tokenSchema,
});

/** A past channel message replayed as backlog when joining. */
export const channelHistoryEntrySchema = z.object({
  from: tokenSchema,
  /** Author name + colour snapshot, so backlog still renders for authors no
   *  longer present (or from a prior session) who aren't in the current roster. */
  name: z.string().min(1).max(64),
  color: colorSchema,
  kind: z.enum(['chat', 'emote']),
  text: chatTextSchema,
  /** Server send time (epoch ms), so replayed lines keep their original order/time. */
  at: z.number().int().nonnegative(),
});
export type ChannelHistoryEntry = z.infer<typeof channelHistoryEntrySchema>;

const channelJoined = z.object({
  type: z.literal('channelJoined'),
  channelToken: tokenSchema,
  channel: z.string().min(1).max(64),
  /** Roster at the moment of joining. */
  users: z.array(userInfoSchema),
  /** Recent messages (oldest first) so the joiner sees backlog. */
  history: z.array(channelHistoryEntrySchema).default([]),
});

const channelLeft = z.object({
  type: z.literal('channelLeft'),
  channelToken: tokenSchema,
});

const userJoinedChannel = z.object({
  type: z.literal('userJoinedChannel'),
  token: tokenSchema,
  channelToken: tokenSchema,
});

const userLeftChannel = z.object({
  type: z.literal('userLeftChannel'),
  token: tokenSchema,
  channelToken: tokenSchema,
});

const serverChat = z.object({
  type: z.literal('chat'),
  from: tokenSchema,
  channelToken: tokenSchema,
  text: chatTextSchema,
  /** Server send time (epoch ms); clients use it so timestamps are consistent. */
  at: z.number().int().nonnegative(),
});

const serverEmote = z.object({
  type: z.literal('emote'),
  from: tokenSchema,
  channelToken: tokenSchema,
  text: chatTextSchema,
  at: z.number().int().nonnegative(),
});

const serverAway = z.object({
  type: z.literal('away'),
  token: tokenSchema,
  text: z.string().max(512),
});

const serverPrivateMessage = z.object({
  type: z.literal('privateMessage'),
  from: tokenSchema,
  text: chatTextSchema,
});

const pong = z.object({
  type: z.literal('pong'),
  id: z.number().int().nonnegative(),
});

const errorMessage = z.object({
  type: z.literal('error'),
  message: z.string().max(1024),
});

export const serverMessageSchema = z.discriminatedUnion('type', [
  welcome,
  loginDenied,
  userConnect,
  userDisconnect,
  channelJoined,
  channelLeft,
  userJoinedChannel,
  userLeftChannel,
  serverChat,
  serverEmote,
  serverAway,
  serverPrivateMessage,
  pong,
  errorMessage,
]);
/** Any validated server→client message. */
export type ServerMessage = z.infer<typeof serverMessageSchema>;
/** The discriminator literals of every server→client message. */
export type ServerMessageType = ServerMessage['type'];

// ---------------------------------------------------------------------------
// Per-message type helpers (handy for switch handlers and test factories)
// ---------------------------------------------------------------------------

/** Narrow a ClientMessage by its `type`. */
export type ClientMessageOf<T extends ClientMessageType> = Extract<ClientMessage, { type: T }>;

/** Narrow a ServerMessage by its `type`. */
export type ServerMessageOf<T extends ServerMessageType> = Extract<ServerMessage, { type: T }>;
