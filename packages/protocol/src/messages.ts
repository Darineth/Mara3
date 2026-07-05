import { z } from 'zod';
import {
  avatarSchema,
  chatTextSchema,
  colorSchema,
  tokenSchema,
  userInfoSchema,
} from './primitives.js';

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
  /**
   * Stable client-chosen identity secret (persisted by the client). The server
   * maps it to a stable user token, so reconnecting — even across a server
   * restart — keeps the same token. Omit it to get a fresh one-off token.
   */
  identityKey: z.string().min(1).max(128).optional(),
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

const clientSetProfile = z.object({
  type: z.literal('setProfile'),
  /** New display name (deduped server-side on a clash). Omit to leave unchanged. */
  name: z.string().min(1).max(64).optional(),
  /** New display colour. Omit to leave unchanged. */
  color: colorSchema.optional(),
  /** New avatar path (`''` clears it). Omit to leave unchanged. */
  avatar: avatarSchema.optional(),
});

const ping = z.object({
  type: z.literal('ping'),
  /** Client-chosen id echoed back in `pong`, for liveness + RTT. */
  id: z.number().int().nonnegative(),
});

/** Ask for older channel history: up to a server-decided page of messages with an id
 *  BELOW `before` (the oldest message id the client currently holds). */
const requestHistory = z.object({
  type: z.literal('requestHistory'),
  channelToken: tokenSchema,
  before: z.number().int().nonnegative(),
});

export const clientMessageSchema = z.discriminatedUnion('type', [
  login,
  joinChannel,
  leaveChannel,
  clientChat,
  clientEmote,
  clientPrivateMessage,
  clientAway,
  clientSetProfile,
  ping,
  requestHistory,
]);
/** Any validated client→server message. */
export type ClientMessage = z.infer<typeof clientMessageSchema>;
/** The discriminator literals of every client→server message. */
export type ClientMessageType = ClientMessage['type'];

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------

/** Server/build identity, sent in `welcome` so a client can show versions and
 *  detect when it is itself running a stale web build (see `webBuild`). */
export const serverInfoSchema = z.object({
  /** Operator-set display name for this server (MARA_SERVER_NAME). */
  name: z.string().min(1).max(64),
  /** The server package version (semver). */
  version: z.string().max(64),
  /** Wire protocol version the server speaks (matches PROTOCOL_VERSION). */
  protocol: z.number().int().nonnegative(),
  /** Build id of the web assets the server is serving; absent in dev/headless.
   *  A client compares it to its own build id to detect a stale (un-refreshed) page. */
  webBuild: z.string().max(128).optional(),
});
export type ServerInfo = z.infer<typeof serverInfoSchema>;

/** Max MOTD length (chars). Generous so a `MOTD.md` file can hold a sizable
 *  markdown message; `welcome` is infrequent, so the extra payload is negligible. */
export const MOTD_MAX_LEN = 65536;

/** A custom (server-hosted) emoji: a shortcode `name` and the URL of its image.
 *  Typing `:name:` renders the image inline. `name` is the shortcode charset only. */
export const emojiEntrySchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_+-]+$/),
  url: z.string().max(512),
});
export type EmojiEntry = z.infer<typeof emojiEntrySchema>;

const welcome = z.object({
  type: z.literal('welcome'),
  /** The logged-in user's own info (token, the possibly-deduped name, colour). */
  self: userInfoSchema,
  /** Per-session secret for authenticated HTTP calls (e.g. image upload). */
  sessionToken: z.string().max(128),
  motd: z.string().max(MOTD_MAX_LEN).default(''),
  /** Server + build identity. Optional so a newer client tolerates an older server. */
  server: serverInfoSchema.optional(),
  /** The server's custom emoji set (shortcode → image URL). Absent on servers with none
   *  configured, or older servers; a newer client just renders no custom emoji then. */
  emoji: z.array(emojiEntrySchema).max(2000).optional(),
  /** Server clock at login (epoch ms). The client anchors a server-time estimate to it
   *  so session/connect notices order consistently with chat. Optional (older servers). */
  at: z.number().int().nonnegative().optional(),
});

const loginDenied = z.object({
  type: z.literal('loginDenied'),
  reason: z.string().max(512),
  /** Machine-readable cause so the client can react beyond showing `reason`.
   *  Known value: 'protocol' — the client is too old for this server's wire format,
   *  so reloading to fetch a newer web build resolves it. A free-form string (not an
   *  enum) so an older client tolerates future codes instead of failing to parse. */
  code: z.string().max(32).optional(),
});

const userConnect = z.object({
  type: z.literal('userConnect'),
  user: userInfoSchema,
});

/** Server send time (epoch ms) for the system line a client derives from this event, so
 *  join/leave notices order and display on the same clock as chat. Optional (older servers). */
const serverEventAt = z.number().int().nonnegative().optional();

const userDisconnect = z.object({
  type: z.literal('userDisconnect'),
  token: tokenSchema,
  at: serverEventAt,
});

/** A past channel message replayed as backlog when joining. */
export const channelHistoryEntrySchema = z.object({
  /** Monotonic server-assigned message id (stable identity; used to dedupe and, later,
   *  to page older history). Unique and increasing within the server's lifetime. */
  id: z.number().int().nonnegative(),
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
  /** The most recent chunk of messages (oldest first) so the joiner sees backlog. */
  history: z.array(channelHistoryEntrySchema).default([]),
  /** True when older messages exist before `history` (the client may page them in). */
  historyHasMore: z.boolean().default(false),
  at: serverEventAt,
});

const channelLeft = z.object({
  type: z.literal('channelLeft'),
  channelToken: tokenSchema,
});

const userJoinedChannel = z.object({
  type: z.literal('userJoinedChannel'),
  token: tokenSchema,
  channelToken: tokenSchema,
  at: serverEventAt,
});

const userLeftChannel = z.object({
  type: z.literal('userLeftChannel'),
  token: tokenSchema,
  channelToken: tokenSchema,
  at: serverEventAt,
});

const serverChat = z.object({
  type: z.literal('chat'),
  /** Monotonic server message id (matches the backlog entry when replayed). */
  id: z.number().int().nonnegative(),
  from: tokenSchema,
  channelToken: tokenSchema,
  text: chatTextSchema,
  /** Server send time (epoch ms); clients use it so timestamps are consistent. */
  at: z.number().int().nonnegative(),
});

const serverEmote = z.object({
  type: z.literal('emote'),
  /** Monotonic server message id (matches the backlog entry when replayed). */
  id: z.number().int().nonnegative(),
  from: tokenSchema,
  channelToken: tokenSchema,
  text: chatTextSchema,
  at: z.number().int().nonnegative(),
});

const serverAway = z.object({
  type: z.literal('away'),
  token: tokenSchema,
  text: z.string().max(512),
  at: serverEventAt,
});

/** Broadcast when a user changes their display name and/or colour mid-session. */
const serverUserProfile = z.object({
  type: z.literal('userProfile'),
  user: userInfoSchema,
});

const serverPrivateMessage = z.object({
  type: z.literal('privateMessage'),
  from: tokenSchema,
  // The other party of the conversation from the *recipient's* view this is the
  // sender; on the copy mirrored to a sender's own other windows it is the target.
  // Every window keys the PM thread by the partner token that isn't itself.
  to: tokenSchema,
  text: chatTextSchema,
});

/** A page of older messages (oldest first) in reply to `requestHistory`. */
const historyChunk = z.object({
  type: z.literal('historyChunk'),
  channelToken: tokenSchema,
  messages: z.array(channelHistoryEntrySchema),
  /** True when still-older messages exist before this page. */
  hasMore: z.boolean(),
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
  serverUserProfile,
  serverPrivateMessage,
  historyChunk,
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
