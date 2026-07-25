import { z } from 'zod';

/**
 * Shared value objects for the Mara wire protocol — small, explicit JSON shapes
 * the server and every client validate identically.
 */

/** Server-assigned identifier for a user or channel (allocated non-zero). */
export const tokenSchema = z.number().int().positive();
export type Token = z.infer<typeof tokenSchema>;

/** A user's display colour, `#rrggbb`. The only per-user styling Mara carries. */
export const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected #rrggbb hex color');
export type Color = z.infer<typeof colorSchema>;

/** A user's avatar: empty (none — clients show a monogram fallback) or a RELATIVE path to a
 *  hosted image under `/avatars/` (durable) or `/uploads/`. Kept relative so each client
 *  resolves it against its own origin. Pattern-restricted because clients render it into an
 *  `<img src>` and it is author-controlled — this bars `javascript:`, `data:`, absolute/remote
 *  URLs, and any attribute-breaking characters at the wire boundary (validated identically on
 *  both ends). An optional `?v=<hash>` cache-buster is allowed. */
export const avatarSchema = z
  .string()
  .max(512)
  .regex(
    /^(?:\/(?:avatars|uploads)\/[A-Za-z0-9._-]+(?:\?v=[A-Za-z0-9]+)?)?$/,
    'avatar must be empty or a hosted /avatars/ or /uploads/ path',
  );
export type Avatar = z.infer<typeof avatarSchema>;

/**
 * Absolute wire ceiling for chat / emote / PM text (characters). This is the *protocol's*
 * hard bound — a frame over it is malformed and rejected at parse — not the effective
 * limit users see: that one is per-server (`MARA_MAX_MESSAGE_CHARS`), enforced by the hub
 * and advertised in `welcome.limits` so composers can size themselves to it. Chosen so
 * even a worst-case JSON-escaped message stays well inside the socket's 256 KB frame cap.
 */
export const CHAT_TEXT_MAX = 32768;

/** Effective message limit a server uses when the operator sets none, and what a client
 *  assumes when talking to a server too old to advertise one. */
export const DEFAULT_MAX_MESSAGE_CHARS = 10000;

/** Bounds shared by chat / emote / PM text. A server abuse guard with headroom over the
 *  configured per-server limit, not that limit itself (see {@link CHAT_TEXT_MAX}). */
export const chatTextSchema = z.string().max(CHAT_TEXT_MAX);
export type ChatText = z.infer<typeof chatTextSchema>;

/**
 * What may be reacted with: either a custom emoji's bare `shortcode` (the same charset the
 * emoji manifest uses, no colons) or a literal emoji cluster.
 *
 * The second branch admits nothing containing letters, digits, or whitespace, which is what
 * stops a reaction being used to staple arbitrary text under someone's message — emoji,
 * ZWJ sequences, variation selectors and regional-indicator flags are all symbols, not
 * letters. A shortcode is checked against the server's actual emoji set when it arrives,
 * so the letters that branch does allow can't be arbitrary either.
 */
export const reactionEmojiSchema = z
  .string()
  .min(1)
  .max(32)
  .refine((v) => /^[a-zA-Z0-9_+-]+$/.test(v) || !/[\s\p{L}\p{N}]/u.test(v), {
    message: 'expected an emoji or a custom emoji shortcode',
  });
export type ReactionEmoji = z.infer<typeof reactionEmojiSchema>;

/** Who reacted to a message with one emoji. `by` is the full set, never a delta, so a
 *  client that missed a frame still converges on the truth. */
export const reactionSchema = z.object({
  emoji: reactionEmojiSchema,
  by: z.array(tokenSchema).max(1000),
});
export type Reaction = z.infer<typeof reactionSchema>;

/** Cap on how many DISTINCT emoji one message may carry, so a message's reactions can't
 *  grow without bound in history. Reacting past it is refused; existing ones still toggle. */
export const MAX_REACTIONS_PER_MESSAGE = 20;

/** A user as seen by others: identity, colour, and away status (`""` = present). */
export const userInfoSchema = z.object({
  token: tokenSchema,
  name: z.string().min(1).max(64),
  color: colorSchema,
  avatar: avatarSchema.default(''),
  away: z.string().max(512).default(''),
});
export type UserInfo = z.infer<typeof userInfoSchema>;
