/**
 * Text → safe HTML pipeline (ports Mara 2's `MTextProcessors` / `MHtmlEscaper`).
 *
 * Order is deliberate:
 *  1. Lift code spans, legacy `[img]…[/img]` tags, Markdown `![alt](url)` images,
 *     and URLs out of the RAW text into placeholders, escaping each one's contents
 *     as it is stashed (URLs must be matched pre-escape so a trailing `&` isn't
 *     split into a stranded `&amp;` `;`). Each placeholder is restored in place.
 *  2. HTML-escape everything that remains.
 *  3. Apply Discord-style markdown (and the legacy `[spoiler]…[/spoiler]` tag) to
 *     the escaped text.
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

// Legacy Mara 2 BBCode tags for backwards compatibility (see TODO.md §Features).
// `[img]URL[/img]` forces the wrapped URL inline as an image; `[spoiler]…[/spoiler]`
// maps to the same hidden-until-clicked treatment as `||…||`. Both are
// case-insensitive and non-greedy so multiple tags on one line stay separate.
const IMG_TAG_RE = /\[img\]([\s\S]+?)\[\/img\]/gi;
// A `[img]` payload is only honored if its trimmed contents are a clean http(s)
// or server-relative upload URL with no whitespace/`<` — same scheme allowlist as
// auto-detected links, so the tag can't smuggle a `javascript:`/`data:` src.
const IMG_URL_RE = /^(?:https?:\/\/|\/uploads\/)[^\s<]+$/i;
// Standard Markdown image syntax `![alt](url)`, in addition to the legacy `[img]`
// tag and the `!`/auto-detect forms. `alt` is optional; the URL (no spaces or `)`)
// is validated against IMG_URL_RE before it's honored.
const IMG_MD_RE = /!\[([^\]\n]*)\]\(([^)\s]+)\)/g;

function anchor(url: string): string {
  return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
}
// A server-relative upload path (`/uploads/<id>.ext`) is emitted WITHOUT its
// leading slash so the browser resolves it against the page's base URL. That makes
// uploaded images load whether the app is hosted at the domain root or under a
// subpath (e.g. https://host/mara/). Absolute http(s) URLs are returned unchanged.
// Detection elsewhere still keys on the leading-slash form; this only adjusts the
// rendered href/src (a subpath deployment must be served with a trailing slash).
function toRenderUrl(url: string): string {
  return url.startsWith('/uploads/') ? url.slice(1) : url;
}
function imageTag(url: string, alt = ''): string {
  // Wrapped in a box with hide/show controls the client wires up; the image can
  // be collapsed to the "Show image" chip and restored. `url` and `alt` are
  // pre-escaped (alt carries the Markdown `![alt](…)` text when present).
  return (
    `<span class="mara-img-box">` +
    `<a href="${url}" class="mara-img-link" target="_blank" rel="noopener noreferrer">` +
    `<img class="mara-img" src="${url}" alt="${alt}" loading="lazy" /></a>` +
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
  return (
    input
      .replace(/\*\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(?=\S)([\s\S]+?)(?<=\S)\*/g, '<em>$1</em>')
      .replace(/(?<!\w)__(?=\S)([\s\S]+?)(?<=\S)__(?!\w)/g, '<u>$1</u>')
      .replace(/(?<!\w)_(?=\S)([\s\S]+?)(?<=\S)_(?!\w)/g, '<em>$1</em>')
      .replace(/~~(?=\S)([\s\S]+?)(?<=\S)~~/g, '<s>$1</s>')
      .replace(/\|\|(?=\S)([\s\S]+?)(?<=\S)\|\|/g, '<span class="mara-spoiler">$1</span>')
      // Legacy Mara 2 BBCode tags (`[b]`/`[i]`/`[u]`/`[s]`/`[spoiler]`) — same output as
      // their markdown equivalents above. Run last so any inner markdown is already
      // applied; the literal brackets survive HTML-escaping untouched, so matching here on
      // the escaped text is safe. Case-insensitive and non-greedy. (Stopped at these; no
      // `[url]`/`[color]` etc.)
      .replace(/\[b\]([\s\S]+?)\[\/b\]/gi, '<strong>$1</strong>')
      .replace(/\[i\]([\s\S]+?)\[\/i\]/gi, '<em>$1</em>')
      .replace(/\[u\]([\s\S]+?)\[\/u\]/gi, '<u>$1</u>')
      .replace(/\[s\]([\s\S]+?)\[\/s\]/gi, '<s>$1</s>')
      .replace(/\[spoiler\]([\s\S]+?)\[\/spoiler\]/gi, '<span class="mara-spoiler">$1</span>')
  );
}

/**
 * Apply Discord block-level markdown to already-escaped text, line by line: headers
 * (`# `/`## `/`### `), subtext (`-# `), block quotes (`> ` and the multi-line `>>> `),
 * and bullet (`-`/`*`) / numbered (`1.`) lists. Inline markdown ({@link applyMarkdown})
 * is applied to each line's content — never across line breaks, matching Discord. The
 * line markers are checked on the ESCAPED text, so `>` arrives as `&gt;`.
 *
 * Output joins plain lines with `\n` (the view renders them via `white-space: pre-wrap`),
 * but emits block elements with no surrounding `\n` so they don't gain an extra blank
 * line on top of their own block break.
 */
export function applyBlocks(input: string): string {
  const lines = input.split('\n');
  const pieces: { block: boolean; html: string }[] = [];
  const isQuote = (l: string) => l === '&gt;' || l.startsWith('&gt; ');
  const isBullet = (l: string) => /^ *[-*] /.test(l);
  const isNumber = (l: string) => /^ *\d+\. /.test(l);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';

    // `>>> ` quotes the rest of the message (every remaining line).
    if (line === '&gt;&gt;&gt;' || line.startsWith('&gt;&gt;&gt; ')) {
      const body = [line.replace(/^&gt;&gt;&gt; ?/, ''), ...lines.slice(i + 1)]
        .map((l) => applyMarkdown(l))
        .join('\n');
      pieces.push({ block: true, html: `<blockquote class="mara-quote">${body}</blockquote>` });
      break;
    }
    // `> ` — consecutive lines fold into one quote.
    if (isQuote(line)) {
      const q: string[] = [];
      while (i < lines.length && isQuote(lines[i] ?? '')) {
        q.push(applyMarkdown((lines[i] ?? '').replace(/^&gt; ?/, '')));
        i++;
      }
      pieces.push({
        block: true,
        html: `<blockquote class="mara-quote">${q.join('\n')}</blockquote>`,
      });
      continue;
    }
    // Headers (1–3 `#`) and subtext (`-# `). Both need text after the marker.
    let m: RegExpExecArray | null;
    if ((m = /^(#{1,3}) (.+)$/.exec(line))) {
      const level = (m[1] ?? '#').length;
      pieces.push({
        block: true,
        html: `<div class="mara-h${level}">${applyMarkdown(m[2] ?? '')}</div>`,
      });
      i++;
      continue;
    }
    if ((m = /^-# (.+)$/.exec(line))) {
      pieces.push({
        block: true,
        html: `<div class="mara-subtext">${applyMarkdown(m[1] ?? '')}</div>`,
      });
      i++;
      continue;
    }
    // Bullet / numbered lists — consecutive matching lines fold into one list.
    if (isBullet(line)) {
      const items: string[] = [];
      while (i < lines.length && isBullet(lines[i] ?? '')) {
        items.push(`<li>${applyMarkdown((lines[i] ?? '').replace(/^ *[-*] +/, ''))}</li>`);
        i++;
      }
      pieces.push({ block: true, html: `<ul class="mara-list">${items.join('')}</ul>` });
      continue;
    }
    if (isNumber(line)) {
      const items: string[] = [];
      while (i < lines.length && isNumber(lines[i] ?? '')) {
        items.push(`<li>${applyMarkdown((lines[i] ?? '').replace(/^ *\d+\. +/, ''))}</li>`);
        i++;
      }
      pieces.push({ block: true, html: `<ol class="mara-list">${items.join('')}</ol>` });
      continue;
    }
    // Plain line: inline markdown only.
    pieces.push({ block: false, html: applyMarkdown(line) });
    i++;
  }

  let out = '';
  for (let k = 0; k < pieces.length; k++) {
    const piece = pieces[k];
    if (!piece) continue;
    const prev = pieces[k - 1];
    if (k > 0 && prev) {
      const prevBlank = !prev.block && prev.html === '';
      const pieceBlank = !piece.block && piece.html === '';
      // A newline between two plain lines, or whenever a blank source line is involved
      // (so explicit blank lines show as a gap even beside block elements). Two adjacent
      // non-blank block elements rely on their CSS margins and get no extra newline.
      if ((!piece.block && !prev.block) || prevBlank || pieceBlank) out += '\n';
    }
    out += piece.html;
  }
  return out;
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
  /** Set false to skip block-level markdown (headers/subtext/quotes/lists) and apply only
   *  inline formatting — for single-line contexts like emotes and away lines. */
  blocks?: boolean;
}

/** Turn a raw message body into safe, display-ready HTML. */
export function renderText(raw: string, options: RenderTextOptions = {}): string {
  const tokens: string[] = [];
  const stash = (html: string): string => {
    tokens.push(html);
    return `${SENTINEL}${tokens.length - 1}${SENTINEL}`;
  };

  // Drop any stray null chars so they cannot collide with the placeholder marker.
  const cleaned = raw.split(SENTINEL).join('');
  let s = options.emoticons ? applyEmoticons(cleaned, options.emoticons) : cleaned;

  // Work on the *raw* text for code spans and URLs, escaping their contents as we
  // stash them. URLs in particular must be matched before escaping: a URL ending
  // in '&' would otherwise become '&amp;', and the regex's trailing-punctuation
  // trim would strand the ';' as literal text after the link.
  // Fenced code block, with an optional Discord-style language hint on the opening line
  // (```js\n…```). We don't syntax-highlight, but we strip the hint so it isn't shown.
  s = s.replace(/```(?:([a-zA-Z0-9+#.-]*)\n)?([\s\S]*?)```/g, (_m, _lang: string, code: string) =>
    stash(`<code class="mara-codeblock">${escapeHtml(code)}</code>`),
  );
  s = s.replace(/`([^`\n]+?)`/g, (_m, code: string) =>
    stash(`<code class="mara-code">${escapeHtml(code)}</code>`),
  );

  // Legacy [img]URL[/img] (Mara 2 compat): force the wrapped URL inline as an
  // image regardless of its extension/format — composes with the `!` marker and
  // the auto-detect below. Only a clean http(s)/upload URL is honored; anything
  // else is left as literal text (and may still auto-detect as a link later).
  // Runs before the URL pass so the inner URL isn't also linkified.
  s = s.replace(IMG_TAG_RE, (literal, inner: string) => {
    const url = inner.trim();
    if (!IMG_URL_RE.test(url)) return literal; // not a clean URL → leave as text
    if (options.images === false) {
      // Images disabled: degrade to a link, honoring the links toggle.
      if (options.links === false) return literal;
      return stash(anchor(escapeHtml(toRenderUrl(url))));
    }
    return stash(imageTag(escapeHtml(toRenderUrl(url))));
  });

  // Markdown image syntax ![alt](url): force the URL inline as an image regardless
  // of extension — like [img] but standard Markdown and carrying alt text. Same
  // clean http(s)/upload scheme allowlist; honors the images/links toggles. Runs
  // before the URL pass so the inner URL isn't separately linkified.
  s = s.replace(IMG_MD_RE, (literal, alt: string, rawUrl: string) => {
    const url = rawUrl.trim();
    if (!IMG_URL_RE.test(url)) return literal; // not a clean URL → leave as text
    const safe = escapeHtml(toRenderUrl(url));
    if (options.images === false) {
      if (options.links === false) return literal;
      return stash(anchor(safe));
    }
    return stash(imageTag(safe, escapeHtml(alt)));
  });

  // Image URLs become inline thumbnails; everything else a link. Both render in
  // place, where the URL appeared in the message.
  if (options.links !== false) {
    s = s.replace(MARKED_URL_RE, (_m, bang: string, url: string) => {
      // Detection uses the raw url; the rendered href/src uses the base-relative form.
      const safe = escapeHtml(toRenderUrl(url));
      // A leading `!` forces inline; otherwise auto-detect by extension/format.
      const forced = bang === '!';
      const isImg = options.images !== false && (forced || isImageUrl(url));
      return stash(isImg ? imageTag(safe) : anchor(safe));
    });
  }

  // Escape the remaining plain text. Placeholders are null chars + digits, which
  // escapeHtml leaves untouched, so the stashed (already-escaped) HTML is safe.
  s = escapeHtml(s);

  if (options.markdown !== false) {
    // Block markdown (headers/quotes/lists) for multi-line contexts; inline-only when
    // `blocks` is off (emotes, away lines).
    s = options.blocks === false ? applyMarkdown(s) : applyBlocks(s);
  }

  // Restore every placeholder in a SINGLE non-recursive pass (see the file header).
  // Images restore in place — where their URL/tag/Markdown appeared in the message —
  // rather than being lifted to a block at the end.
  return s.replace(RESTORE_RE, (_m, i: string) => tokens[Number(i)] ?? '');
}
