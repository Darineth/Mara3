/**
 * Text → safe HTML pipeline (ports Mara 2's `MTextProcessors` / `MHtmlEscaper`).
 *
 * Order is deliberate: escape first (so user input can never inject HTML), then
 * lift code spans and URLs out into placeholders so formatting can't run inside
 * them, then apply Discord-style markdown, then restore the placeholders.
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
    s = s.replace(URL_RE, (url) => {
      const safe = escapeHtml(url);
      const isImg = options.images !== false && IMAGE_RE.test(url);
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
