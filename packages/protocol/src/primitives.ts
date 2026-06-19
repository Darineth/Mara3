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

/** Bounds shared by chat / emote / PM text. A server abuse guard, not a UI limit. */
export const chatTextSchema = z.string().max(8192);
export type ChatText = z.infer<typeof chatTextSchema>;

/** A user as seen by others: identity, colour, and away status (`""` = present). */
export const userInfoSchema = z.object({
  token: tokenSchema,
  name: z.string().min(1).max(64),
  color: colorSchema,
  away: z.string().max(512).default(''),
});
export type UserInfo = z.infer<typeof userInfoSchema>;
