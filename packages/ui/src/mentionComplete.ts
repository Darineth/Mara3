/**
 * Matching for the composer's inline `@name` mention autocomplete, kept separate from
 * the component so the trigger + ranking rules can be unit-tested (mirrors
 * emojiComplete.ts).
 */

export interface MentionMatch {
  /** Ranked matching names (prefix hits first, then alphabetical), capped at `limit`. */
  items: string[];
  /** Index in the source text of the triggering `@`, so a caller can replace from there. */
  start: number;
}

/**
 * Find an in-progress `@name` at the end of `before` (the message text up to the caret)
 * and return the display names that match it. Returns null when there's no active token.
 *
 * The `@` must open a token — at the start of the line or after whitespace — so an email
 * address (`bob@host`) never triggers it. A bare `@` offers the whole roster; typing
 * narrows it. Display names may contain spaces, so the query runs to the caret (across
 * spaces): `@Bob S` still matches "Bob Smith" — and the menu closes on its own once the
 * typed text stops matching anyone (`@Bob said hi`).
 */
export function matchMention(before: string, names: string[], limit = 50): MentionMatch | null {
  const m = /(?:^|\s)(@[^@\n]*)$/.exec(before);
  if (!m || m[1] === undefined) return null;
  const token = m[1]; // "@bo"
  const query = token.slice(1).toLowerCase();
  const items = names
    .filter((n) => n.toLowerCase().includes(query))
    .sort((a, b) => {
      const rank =
        Number(b.toLowerCase().startsWith(query)) - Number(a.toLowerCase().startsWith(query));
      return rank || a.localeCompare(b);
    })
    .slice(0, limit);
  return items.length ? { items, start: before.length - token.length } : null;
}
