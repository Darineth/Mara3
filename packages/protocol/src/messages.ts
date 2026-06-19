import { z } from 'zod';
import { chatTextSchema, tokenSchema, userInfoSchema, userStyleSchema } from './primitives.js';

/**
 * The Mara message set — a clean JSON redesign of the original 18 `MPacket`
 * types. Messages are split by direction into two discriminated unions so each
 * side validates only what it can legitimately receive, and so a `chat` the
 * client *sends* (no author yet) and a `chat` the server *broadcasts* (with an
 * author token) can have direction-appropriate shapes without colliding.
 *
 * Wire shape is flat: `{ type: 'chat', channelToken, text }`.
 */

// ---------------------------------------------------------------------------
// Client → Server
// ---------------------------------------------------------------------------

const clientVersion = z.object({
  type: z.literal('clientVersion'),
  maraVersion: z.number().int().nonnegative(),
  clientVersion: z.number().int().nonnegative(),
  appVersion: z.number().int().nonnegative(),
});

const login = z.object({
  type: z.literal('login'),
  name: z.string().min(1).max(64),
  /** Opaque token from a prior session, enabling reconnect/resume. */
  resumeToken: z.string().max(128).optional(),
  style: userStyleSchema,
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

const clientAway = z.object({
  type: z.literal('away'),
  text: z.string().max(512),
});

const clientPrivateMessage = z.object({
  type: z.literal('privateMessage'),
  toUserToken: tokenSchema,
  text: chatTextSchema,
});

// Client states its desired name/style; the server stamps the authoritative
// `token` when it re-broadcasts as `serverUserUpdate` (same `type` literal).
const clientUserUpdate = z.object({
  type: z.literal('userUpdate'),
  name: z.string().min(1).max(64),
  style: userStyleSchema,
});

// `sentAt` is the client's own clock at send; echoed back in `pong` alongside
// the server's `serverTime` so the client can compute RTT and clock skew.
const clientPing = z.object({
  type: z.literal('ping'),
  pingId: z.number().int().nonnegative(),
  sentAt: z.number().int().nonnegative(),
});

const serverCommand = z.object({
  type: z.literal('serverCommand'),
  command: z.string().min(1).max(64),
  args: z.string().max(2048).default(''),
});

const queryUser = z.object({
  type: z.literal('queryUser'),
  token: tokenSchema,
});

const clientDisconnect = z.object({
  type: z.literal('disconnect'),
  reason: z.string().max(512).default(''),
});

// Escape hatch for plugin-to-plugin traffic the core protocol need not
// understand: addressed to a channel or a single user, with an opaque payload
// the server relays verbatim (see `serverPluginData` for the inbound mirror).
const clientPluginData = z.object({
  type: z.literal('pluginData'),
  channel: z.string().max(64).optional(),
  toUserToken: tokenSchema.optional(),
  /** Opaque, plugin-defined JSON payload. */
  data: z.unknown(),
});

/** Validator for every client→server frame; what the server accepts inbound. */
export const clientMessageSchema = z.discriminatedUnion('type', [
  clientVersion,
  login,
  joinChannel,
  leaveChannel,
  clientChat,
  clientEmote,
  clientAway,
  clientPrivateMessage,
  clientUserUpdate,
  clientPing,
  serverCommand,
  queryUser,
  clientDisconnect,
  clientPluginData,
]);
/** Any validated client→server message. */
export type ClientMessage = z.infer<typeof clientMessageSchema>;
/** The discriminator literals of every client→server message. */
export type ClientMessageType = ClientMessage['type'];

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------

const serverHello = z.object({
  type: z.literal('serverHello'),
  maraVersion: z.number().int().nonnegative(),
  serverName: z.string().max(128),
});

/** Generic acknowledgement for an action the client requested. */
const response = z.object({
  type: z.literal('response'),
  /** What this is a response to, e.g. 'joinChannel', 'serverCommand'. */
  ref: z.string().max(64),
  ok: z.boolean(),
  code: z.number().int().default(0),
  message: z.string().max(1024).default(''),
});

const loginAccepted = z.object({
  type: z.literal('loginAccepted'),
  /** The server token now identifying this user. */
  token: tokenSchema,
  /** The (possibly de-duplicated) name the server assigned. */
  name: z.string().min(1).max(64),
  /** Resume token to present on reconnect. */
  resumeToken: z.string().max(128),
  motd: z.string().max(8192).default(''),
});

const loginDenied = z.object({
  type: z.literal('loginDenied'),
  reason: z.string().max(512),
  /** True when the client must update before it can connect. */
  updateRequired: z.boolean().default(false),
});

const userConnect = z.object({
  type: z.literal('userConnect'),
  user: userInfoSchema,
  reconnect: z.boolean().default(false),
});

const userDisconnect = z.object({
  type: z.literal('userDisconnect'),
  token: tokenSchema,
  reason: z.string().max(512).default(''),
});

// Broadcast counterpart of `clientUserUpdate`: shares the `userUpdate` literal
// but adds `token` so peers know *which* user changed. The direction-split
// unions keep these two shapes from colliding under one discriminator.
const serverUserUpdate = z.object({
  type: z.literal('userUpdate'),
  token: tokenSchema,
  name: z.string().min(1).max(64),
  style: userStyleSchema,
});

const channelJoined = z.object({
  type: z.literal('channelJoined'),
  channelToken: tokenSchema,
  channel: z.string().min(1).max(64),
  /** Current roster at the moment of joining. */
  users: z.array(userInfoSchema),
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
});

const serverEmote = z.object({
  type: z.literal('emote'),
  from: tokenSchema,
  channelToken: tokenSchema,
  text: chatTextSchema,
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

// Echoes the client's `pingId`/`sentAt` for correlation and RTT; `serverTime`
// lets the client estimate clock offset against the server.
const pong = z.object({
  type: z.literal('pong'),
  pingId: z.number().int().nonnegative(),
  sentAt: z.number().int().nonnegative(),
  serverTime: z.number().int().nonnegative(),
});

const kicked = z.object({
  type: z.literal('kicked'),
  reason: z.string().max(512).default(''),
});

const serverMessage = z.object({
  type: z.literal('serverMessage'),
  text: z.string().max(8192),
});

const userInfo = z.object({
  type: z.literal('userInfo'),
  user: userInfoSchema,
});

const serverPluginData = z.object({
  type: z.literal('pluginData'),
  from: tokenSchema.optional(),
  channelToken: tokenSchema.optional(),
  data: z.unknown(),
});

const errorMessage = z.object({
  type: z.literal('error'),
  code: z.number().int(),
  message: z.string().max(1024),
});

/** Validator for every server→client frame; what a client accepts inbound. */
export const serverMessageSchema = z.discriminatedUnion('type', [
  serverHello,
  response,
  loginAccepted,
  loginDenied,
  userConnect,
  userDisconnect,
  serverUserUpdate,
  channelJoined,
  channelLeft,
  userJoinedChannel,
  userLeftChannel,
  serverChat,
  serverEmote,
  serverAway,
  serverPrivateMessage,
  pong,
  kicked,
  serverMessage,
  userInfo,
  serverPluginData,
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
