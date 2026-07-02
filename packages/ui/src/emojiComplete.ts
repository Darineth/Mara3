/**
 * Matching for the composer's inline `:shortcode` emoji autocomplete, kept separate from
 * the component so the trigger + ranking rules can be unit-tested.
 */

/** Emoji as `[name, url]` pairs (the shape of `Object.entries(map)`). */
export type EmojiPair = [name: string, url: string];

/**
 * Resolve an emoji manifest URL into an `<img src>` that survives a subpath deployment.
 *
 * NOTE — keep emoji image `src`s RELATIVE. The manifest uses server-absolute paths
 * (`/emoji/x.png`) — that's the canonical form the chat renderer validates — but a
 * leading-slash `src` resolves against the ORIGIN, so it 404s when the app is hosted under a
 * subdirectory (e.g. `https://host/mara/` would look for `https://host/emoji/x.png`).
 * Dropping the leading slash makes it resolve against the page's base URL instead. Always
 * route an emoji `src` through this (never the raw manifest URL); absolute http(s) URLs pass
 * through untouched. Mirrors chat-render's `toRenderUrl`, which does the same for messages.
 */
export function emojiSrc(url: string): string {
  return url.startsWith('/emoji/') ? url.slice(1) : url;
}

export interface EmojiMatch {
  /** Ranked matches (prefix hits first, then alphabetical), capped at `limit`. */
  items: EmojiPair[];
  /** Index in the source text of the triggering `:`, so a caller can replace from there. */
  start: number;
}

/**
 * Find an in-progress `:shortcode` at the end of `before` (the message text up to the
 * caret) and return the emoji that match it. Returns null when there's no active token.
 *
 * The `:` must open a token — at the start of the line, after whitespace, or directly after
 * another `:` (so a second emoji typed flush against a completed one, `:tada::par`, still
 * triggers). A clock (`12:30`) or a namespaced word (`note:foo`) never triggers it, since
 * those colons follow a non-colon character. At least TWO shortcode characters must follow
 * the `:`, so a text emoticon like `:D` or `:P` (and a bare `:`) doesn't open the menu.
 */
export function matchEmojiShortcode(
  before: string,
  emoji: EmojiPair[],
  limit = 50,
): EmojiMatch | null {
  const m = /(?:^|[\s:])(:[a-zA-Z0-9_+-]{2,})$/.exec(before);
  if (!m || m[1] === undefined) return null;
  const token = m[1]; // ":que"
  const query = token.slice(1).toLowerCase();
  const items = emoji
    .filter(([name]) => name.toLowerCase().includes(query))
    .sort((a, b) => {
      const rank =
        Number(b[0].toLowerCase().startsWith(query)) - Number(a[0].toLowerCase().startsWith(query));
      return rank || a[0].localeCompare(b[0]);
    })
    .slice(0, limit);
  return items.length ? { items, start: before.length - token.length } : null;
}
