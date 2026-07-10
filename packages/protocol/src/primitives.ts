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

/** Bounds shared by chat / emote / PM text. A server abuse guard with headroom over the
 *  composer's 10k character limit, not the UI limit itself. */
export const chatTextSchema = z.string().max(10240);
export type ChatText = z.infer<typeof chatTextSchema>;

/** A user as seen by others: identity, colour, and away status (`""` = present). */
export const userInfoSchema = z.object({
  token: tokenSchema,
  name: z.string().min(1).max(64),
  color: colorSchema,
  avatar: avatarSchema.default(''),
  away: z.string().max(512).default(''),
});
export type UserInfo = z.infer<typeof userInfoSchema>;
