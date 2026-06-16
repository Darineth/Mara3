import { z } from 'zod';

/**
 * Shared value objects for the Mara wire protocol.
 *
 * These replace Qt's binary `QDataStream` encodings of `QFont` / `QColor` /
 * `quint32` tokens with plain, explicit JSON shapes.
 */

/** Server-assigned identifier for a user or channel (was `quint32` in Mara 2). */
export const tokenSchema = z
  .number()
  .int()
  .min(0)
  .max(0xffffffff)
  .describe('uint32 user/channel token');
export type Token = z.infer<typeof tokenSchema>;

/** A `#rrggbb` color (replaces serialized `QColor`). */
export const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected #rrggbb hex color');
export type Color = z.infer<typeof colorSchema>;

/** A font description (replaces serialized `QFont`). */
export const fontSchema = z.object({
  family: z.string().min(1).max(128),
  /** Point size; Qt allowed fractional sizes. */
  pointSize: z.number().positive().max(512),
  bold: z.boolean().default(false),
  italic: z.boolean().default(false),
  underline: z.boolean().default(false),
});
export type Font = z.infer<typeof fontSchema>;

/** A user's visual style: their font + text color (was `MTextStyle`). */
export const userStyleSchema = z.object({
  font: fontSchema,
  color: colorSchema,
});
export type UserStyle = z.infer<typeof userStyleSchema>;

/** A user as seen on the wire (roster entries, broadcasts). */
export const userInfoSchema = z.object({
  token: tokenSchema,
  name: z.string().min(1).max(64),
  style: userStyleSchema,
  away: z.string().max(512).default(''),
});
export type UserInfo = z.infer<typeof userInfoSchema>;

/** Bounds shared by chat/emote/message text fields. */
export const chatTextSchema = z.string().max(8192);
export type ChatText = z.infer<typeof chatTextSchema>;
