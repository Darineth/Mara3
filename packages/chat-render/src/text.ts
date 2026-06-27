/**
 * Text → safe HTML pipeline (ports Mara 2's `MTextProcessors` / `MHtmlEscaper`).
 *
 * Order is deliberate:
 *  1. Lift code spans and URLs out of the RAW text into placeholders, escaping
 *     each one's contents as it is stashed (URLs must be matched pre-escape so a
 *     trailing `&` isn't split into a stranded `&amp;` `;`).
 *  2. HTML-escape everything that remains.
 *  3. Apply Discord-style markdown to the escaped text.
 *  4. Restore the placeholders in a SINGLE pass.
 *
 * The single-pass restore is load-bearing for safety: stashed HTML is already
 * escaped/trusted, and must never be re-scanned — a stashed tag carries its own
 * quotes (e.g. `class="…"`), so a recursive restore could let those break out of
 * an attribute. Do not make the restore recursive.
 */

/** Optional emoticon set: code → replacement. Off by default; opt in via options. */
export const DEFAULT_EMOTICONS: Record<string, string> = {
  ':)': '🙂',
  ':-)': '🙂',
  ':(': '🙁',
  ':-(': '🙁',
  ':D': '😀',
  ';)': '😉',
  ':P': '😛',
  ':p': '😛',
  ':o': '😮',
  ':O': '😮',
  '<3': '❤️',
  ':|': '😐',
};

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

// Absolute http(s) URLs, plus server-relative upload paths (`/uploads/…`).
// Uploads are referenced relatively so each client resolves them against the
// origin it connected to, rather than a host baked in by the uploader. The
// relative branch must start at a whitespace/line boundary so it doesn't match
// inside a larger token (and an http URL's own `/uploads/` stays part of it).
const URL_RE = /(?:https?:\/\/|(?<![^\s])\/uploads\/)[^\s<]+[^\s<.,!?;:)]/g;
const IMAGE_RE = /\.(?:png|jpe?g|gif|webp|svg|avif|bmp)(?:[?#]\S*)?$/i;
// Some hosts carry no file extension but *declare* the image format in the query
// string instead (`?format=jpg`, `&fm=png`, `?ext=webp`). Treat those as images
// too — purely a string check, no network fetch. This does not help genuinely
// opaque URLs (no extension, no declared format); the `!` sender marker covers
// those. See TODO.md §Features (inline images for extension-less URLs).
const IMAGE_QUERY_RE = /[?&](?:format|fm|ext)=(?:png|jpe?g|gif|webp|avif|bmp|svg)\b/i;

/** A URL whose path extension OR query-declared format says it's an image. */
function isImageUrl(url: string): boolean {
  return IMAGE_RE.test(url) || IMAGE_QUERY_RE.test(url);
}

// URL pattern with an optional leading `!` sender marker captured separately. A
// bang immediately before a URL forces it inline as an image regardless of
// extension/format (the per-URL opt-in escape hatch for opaque image URLs); the
// `!` itself is consumed so it never shows in the rendered text. Built from
// URL_RE so the two stay in lock-step.
const MARKED_URL_RE = new RegExp(`(!?)(${URL_RE.source})`, 'g');

function anchor(url: string): string {
  return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
}
function imageTag(url: string): string {
  // Wrapped in a box with hide/show controls the client wires up; the image can
  // be collapsed to the "Show image" chip and restored. `url` is pre-escaped.
  return (
    `<span class="mara-img-box">` +
    `<a href="${url}" class="mara-img-link" target="_blank" rel="noopener noreferrer">` +
    `<img class="mara-img" src="${url}" alt="" loading="lazy" /></a>` +
    `<button type="button" class="mara-img-hide" aria-label="Hide image">Hide</button>` +
    `<button type="button" class="mara-img-show" aria-label="Show image">🖼 Show image</button>` +
    `</span>`
  );
}
// A null character: cannot appear in normal escaped chat text, so it is a safe
// placeholder marker. Built at runtime to keep control chars out of the source.
const SENTINEL = String.fromCharCode(0);
const RESTORE_RE = new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, 'g');

export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Substitute emoticon codes with their replacements. Runs on RAW text (before
 * escaping) so codes containing `<`/`>` etc. match literally. Codes are tried
 * longest-first so e.g. `:-)` wins over `:)`.
 */
export function applyEmoticons(
  input: string,
  map: Record<string, string> = DEFAULT_EMOTICONS,
): string {
  const codes = Object.keys(map).sort((a, b) => b.length - a.length); // longest first
  if (codes.length === 0) return input;
  const pattern = new RegExp(codes.map(escapeRegExp).join('|'), 'g');
  return input.replace(pattern, (match) => map[match] ?? match);
}

/** Wrap bare http(s) URLs in anchors. Operates on already-escaped text. */
export function linkify(escaped: string): string {
  return escaped.replace(
    URL_RE,
    (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`,
  );
}

/**
 * Apply Discord-style markdown to already-escaped text. Inline content may not
 * start or end with whitespace (matches Discord), and underscore rules require
 * word boundaries so `snake_case` and URLs are left alone.
 */
export function applyMarkdown(input: string): string {
  return input
    .replace(/\*\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(?=\S)([\s\S]+?)(?<=\S)\*/g, '<em>$1</em>')
    .replace(/(?<!\w)__(?=\S)([\s\S]+?)(?<=\S)__(?!\w)/g, '<u>$1</u>')
    .replace(/(?<!\w)_(?=\S)([\s\S]+?)(?<=\S)_(?!\w)/g, '<em>$1</em>')
    .replace(/~~(?=\S)([\s\S]+?)(?<=\S)~~/g, '<s>$1</s>')
    .replace(/\|\|(?=\S)([\s\S]+?)(?<=\S)\|\|/g, '<span class="mara-spoiler">$1</span>');
}

export interface RenderTextOptions {
  /** Provide an emoticon map to enable emoticon substitution (default: off). */
  emoticons?: Record<string, string>;
  /** Set false to skip URL linkification. */
  links?: boolean;
  /** Set false to render image URLs as plain links instead of inline images. */
  images?: boolean;
  /** Set false to skip markdown formatting. */
  markdown?: boolean;
}

/** Turn a raw message body into safe, display-ready HTML. */
export function renderText(raw: string, options: RenderTextOptions = {}): string {
  const tokens: string[] = [];
  const imageTokens = new Set<number>();
  const stash = (html: string, isImage = false): string => {
    tokens.push(html);
    if (isImage) imageTokens.add(tokens.length - 1);
    return `${SENTINEL}${tokens.length - 1}${SENTINEL}`;
  };

  // Drop any stray null chars so they cannot collide with the placeholder marker.
  const cleaned = raw.split(SENTINEL).join('');
  let s = options.emoticons ? applyEmoticons(cleaned, options.emoticons) : cleaned;

  // Work on the *raw* text for code spans and URLs, escaping their contents as we
  // stash them. URLs in particular must be matched before escaping: a URL ending
  // in '&' would otherwise become '&amp;', and the regex's trailing-punctuation
  // trim would strand the ';' as literal text after the link.
  s = s.replace(/```([\s\S]+?)```/g, (_m, code: string) =>
    stash(`<code class="mara-codeblock">${escapeHtml(code)}</code>`),
  );
  s = s.replace(/`([^`\n]+?)`/g, (_m, code: string) =>
    stash(`<code class="mara-code">${escapeHtml(code)}</code>`),
  );

  // Image URLs become inline thumbnails; everything else a link. Images are
  // flagged so they can be lifted out of the text flow and shown below it.
  if (options.links !== false) {
    s = s.replace(MARKED_URL_RE, (_m, bang: string, url: string) => {
      const safe = escapeHtml(url);
      // A leading `!` forces inline; otherwise auto-detect by extension/format.
      const forced = bang === '!';
      const isImg = options.images !== false && (forced || isImageUrl(url));
      return stash(isImg ? imageTag(safe) : anchor(safe), isImg);
    });
  }

  // Escape the remaining plain text. Placeholders are null chars + digits, which
  // escapeHtml leaves untouched, so the stashed (already-escaped) HTML is safe.
  s = escapeHtml(s);

  if (options.markdown !== false) s = applyMarkdown(s);

  // Restore placeholders, but collect image tags separately so they render in a
  // block below the message text rather than inline within it.
  const images: string[] = [];
  let body = s.replace(RESTORE_RE, (_m, i: string) => {
    const idx = Number(i);
    if (imageTokens.has(idx)) {
      images.push(tokens[idx] ?? '');
      return '';
    }
    return tokens[idx] ?? '';
  });

  if (images.length === 0) return body;
  body = body.replace(/\s+$/, ''); // drop whitespace stranded where images were
  return `${body}<span class="mara-imgs">${images.join('')}</span>`;
}
