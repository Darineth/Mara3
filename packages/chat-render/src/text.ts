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
// The URL body stops at two things beyond whitespace/`<`, so a URL wrapped in
// formatting doesn't swallow the closing delimiter into its href:
//   - `|` — not a legal unencoded URL char; stopping there (like Discord) lets a
//     spoiler-wrapped link work, else `||https://x.com||` eats the closing `||`.
//   - `[/` — a legacy BBCode closing tag opener, so `[spoiler]https://x.com[/spoiler]`
//     (and `[b]…[/b]`, etc.) don't lose their closing tag into the link.
// Both only ever make a matched URL SHORTER, never longer.
const URL_RE = /(?:https?:\/\/|(?<![^\s])\/uploads\/)(?:(?!\[\/)[^\s<|])+(?!\[\/)[^\s<|.,!?;:)]/g;
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

// Custom emoji shortcode `:name:` (shortcode charset only, so `12:30:45` and `:)` never
// match). Only substituted when `name` is in the supplied emoji map — an unknown name is
// left as literal text. The manifest URL is re-validated against this allowlist (the
// server's own `/emoji/` route, or an absolute http(s) URL) before it's trusted.
const EMOJI_RE = /:([a-zA-Z0-9_+-]+):/g;
const EMOJI_URL_RE = /^(?:https?:\/\/|\/emoji\/)[^\s<]+$/i;

// A native (unicode) emoji cluster: a pictographic base plus any trailing variation selector,
// skin-tone modifier, or ZWJ-joined pictographs — or a two-char regional-indicator flag. Used
// only to recognise an "emoji-only" message for jumbo sizing (see emojiOnlyCount), never to
// alter the text. (Unicode property escapes are already relied on elsewhere in this package.)
const NATIVE_EMOJI_RE =
  /\p{Extended_Pictographic}(?:\u{FE0F}|[\u{1F3FB}-\u{1F3FF}]|\u{200D}\p{Extended_Pictographic}(?:\u{FE0F}|[\u{1F3FB}-\u{1F3FF}])?)*|[\u{1F1E6}-\u{1F1FF}]{2}/gu;

/**
 * If `text` is composed solely of emoji — known custom `:shortcode:` emoji and/or native
 * unicode emoji — plus whitespace, returns how many there are; otherwise 0. Lets a caller
 * render an emoji-only message larger, à la Discord's "jumbo" emoji.
 */
export function emojiOnlyCount(text: string, emoji?: Record<string, string>): number {
  let count = 0;
  let rest = text;
  if (emoji) {
    rest = rest.replace(EMOJI_RE, (literal, name: string) => {
      const url = emoji[name];
      if (url !== undefined && EMOJI_URL_RE.test(url)) {
        count++;
        return '';
      }
      return literal;
    });
  }
  rest = rest.replace(NATIVE_EMOJI_RE, () => {
    count++;
    return '';
  });
  if (count === 0) return 0;
  // Ignore leftover whitespace and stray joiners/variation selectors; any real character left
  // over means the message wasn't emoji-only.
  return /\S/.test(rest.replace(/[\u{FE0E}\u{FE0F}\u{200D}]/gu, '')) ? 0 : count;
}

// Links carry NO target="_blank". The app intercepts a plain click and opens the URL
// itself — via the native opener in the desktop shells, or window.open in a browser — so
// a bare anchor suffices. _blank actively hurts the desktop clients: the Tauri 2 shell
// blocks _blank new windows outright (links did nothing), and the Tauri 1 legacy client
// opens them natively (which would double up with the app's own handler).
function anchor(url: string): string {
  return `<a href="${url}" rel="noopener noreferrer">${url}</a>`;
}
// A server-hosted path (`/uploads/<id>.ext`, `/emoji/<id>`, `/avatars/<id>`) is emitted
// WITHOUT its leading slash so the browser resolves it against the page's base URL. That makes
// the image load whether the app is hosted at the domain root or under a subpath (e.g.
// https://host/mara/). Absolute http(s) URLs (and anything not one of our roots) are returned
// unchanged. Detection elsewhere still keys on the leading-slash form; this only adjusts the
// rendered href/src (a subpath deployment must be served with a trailing slash).
export function toRenderUrl(url: string): string {
  return /^\/(?:uploads|emoji|avatars)\//.test(url) ? url.slice(1) : url;
}
// Inline custom-emoji image. `name` is the shortcode (charset-limited by EMOJI_RE) and
// `safeUrl` is already validated + escaped. Sized to the line via `.mara-emoji`; the
// `:name:` alt keeps it copy/paste- and screen-reader-friendly and is the fallback text.
function emojiTag(name: string, safeUrl: string): string {
  const code = escapeHtml(`:${name}:`);
  return `<img class="mara-emoji" src="${safeUrl}" alt="${code}" title="${code}" loading="lazy" />`;
}
function imageTag(url: string, alt = ''): string {
  // Wrapped in a box with a single corner show/hide toggle the client wires up — the same
  // eye/× control and cover-in-place behaviour as a spoiler: hiding blanks the image where it
  // sits (no reflow) rather than collapsing it, and a click anywhere on the covered image
  // reveals it again. `url` and `alt` are pre-escaped (alt carries the Markdown `![alt](…)`
  // text when present).
  //
  // The link deliberately has NO target="_blank": a plain click is handled in JS (it
  // opens the lightbox and prevents navigation), while modifier/middle clicks open a
  // new tab regardless of target. Dropping _blank stops the desktop WebView from ALSO
  // opening the image in the system browser on a plain click (a Win7 WebView2 quirk
  // where the _blank new-window request fires despite the click's preventDefault).
  return (
    `<span class="mara-img-box">` +
    `<a href="${url}" class="mara-img-link" rel="noopener noreferrer">` +
    `<img class="mara-img" src="${url}" alt="${alt}" loading="lazy" /></a>` +
    `<span class="mara-img-toggle" aria-hidden="true"></span>` +
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
    (url) => `<a href="${url}" rel="noopener noreferrer">${url}</a>`, // no _blank; see anchor()
  );
}

/**
 * Apply Discord-style markdown to already-escaped text. Inline content may not
 * start or end with whitespace (matches Discord), and underscore rules require
 * word boundaries so `snake_case` and URLs are left alone.
 */
// Trailing handle inside a spoiler: a PERSISTENT show/hide toggle, visible in both
// the covered and revealed states (the client labels it "show"/"hide" via CSS). It
// lets a revealed spoiler be collapsed again WITHOUT a click on its contents, so a
// link or image inside stays independently clickable. The client styles
// `.mara-spoiler-hide` and drives it (see ChatView): it's kept out of the cover that
// blanks the rest of the spoiler.
const SPOILER_HANDLE = '<span class="mara-spoiler-hide" aria-hidden="true"></span>';

export function applyMarkdown(input: string): string {
  return (
    input
      .replace(/\*\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(?=\S)([\s\S]+?)(?<=\S)\*/g, '<em>$1</em>')
      .replace(/(?<!\w)__(?=\S)([\s\S]+?)(?<=\S)__(?!\w)/g, '<u>$1</u>')
      .replace(/(?<!\w)_(?=\S)([\s\S]+?)(?<=\S)_(?!\w)/g, '<em>$1</em>')
      .replace(/~~(?=\S)([\s\S]+?)(?<=\S)~~/g, '<s>$1</s>')
      // Spoiler `||…||`. Unlike bold/italic, the content MAY start/end with whitespace
      // (`|| hidden ||` works, matching Discord) — a spoiler is a container, and a link
      // or image inside is often spaced off. Lazy so the first closing `||` ends it.
      .replace(/\|\|([\s\S]+?)\|\|/g, `<span class="mara-spoiler">$1${SPOILER_HANDLE}</span>`)
      // Legacy Mara 2 BBCode tags (`[b]`/`[i]`/`[u]`/`[s]`/`[spoiler]`) — same output as
      // their markdown equivalents above. Run last so any inner markdown is already
      // applied; the literal brackets survive HTML-escaping untouched, so matching here on
      // the escaped text is safe. Case-insensitive and non-greedy. (Stopped at these; no
      // `[url]`/`[color]` etc.)
      .replace(/\[b\]([\s\S]+?)\[\/b\]/gi, '<strong>$1</strong>')
      .replace(/\[i\]([\s\S]+?)\[\/i\]/gi, '<em>$1</em>')
      .replace(/\[u\]([\s\S]+?)\[\/u\]/gi, '<u>$1</u>')
      .replace(/\[s\]([\s\S]+?)\[\/s\]/gi, '<s>$1</s>')
      .replace(
        /\[spoiler\]([\s\S]+?)\[\/spoiler\]/gi,
        `<span class="mara-spoiler">$1${SPOILER_HANDLE}</span>`,
      )
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
 * but emits block elements with no surrounding `\n` so they don't gain an extra blank line
 * on top of their own block break. Blank source lines become a paragraph gap between plain
 * text, but are absorbed next to a block element (whose own margin already separates it) —
 * so a blank line after a heading is largely ignored rather than doubling the space.
 */
export function applyBlocks(input: string): string {
  const lines = input.split('\n');
  const pieces: { block: boolean; html: string }[] = [];
  const isQuote = (l: string) => l === '&gt;' || l.startsWith('&gt; ');
  const isBullet = (l: string) => /^ *[-*] /.test(l);
  const isNumber = (l: string) => /^ *\d+\. /.test(l);
  // A soft-wrapped continuation of the current list item: an indented, non-empty line
  // that isn't itself a new marker. Folded into the item so a wrapped bullet stays a
  // single <li> instead of splitting the list at each wrap.
  const isContinuation = (l: string) => /^\s+\S/.test(l) && !isBullet(l) && !isNumber(l);

  let i = 0;
  // Collect one list's items, starting at `i`. Each item is its marker line plus any
  // following continuation lines (folded with a space, like a Markdown soft wrap).
  // Advances `i` past the whole list.
  const collectItems = (match: (l: string) => boolean, strip: RegExp): string => {
    const items: string[] = [];
    while (i < lines.length && match(lines[i] ?? '')) {
      let text = (lines[i] ?? '').replace(strip, '');
      i++;
      while (i < lines.length && isContinuation(lines[i] ?? '')) {
        text += ' ' + (lines[i] ?? '').trim();
        i++;
      }
      items.push(`<li>${applyMarkdown(text)}</li>`);
    }
    return items.join('');
  };
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
    // Bullet / numbered lists — consecutive markers fold into one list, and each item's
    // soft-wrapped continuation lines fold into that item (see collectItems).
    if (isBullet(line)) {
      pieces.push({
        block: true,
        html: `<ul class="mara-list">${collectItems(isBullet, /^ *[-*] +/)}</ul>`,
      });
      continue;
    }
    if (isNumber(line)) {
      pieces.push({
        block: true,
        html: `<ol class="mara-list">${collectItems(isNumber, /^ *\d+\. +/)}</ol>`,
      });
      continue;
    }
    // Plain line: inline markdown only.
    pieces.push({ block: false, html: applyMarkdown(line) });
    i++;
  }

  // Absorb blank source lines that sit against a block element. A maximal run of blank
  // lines is dropped when the piece just before OR just after it is a block (heading, list,
  // quote, subtext): that block already carries its own top/bottom margin, so an extra blank
  // line on top of it just doubles the gap. Blank runs BETWEEN plain text are kept — that's
  // how a message shows a paragraph break.
  const isBlank = (p: { block: boolean; html: string } | undefined): boolean =>
    !!p && !p.block && p.html === '';
  const drop = new Array<boolean>(pieces.length).fill(false);
  for (let a = 0; a < pieces.length; ) {
    if (!isBlank(pieces[a])) {
      a++;
      continue;
    }
    let b = a;
    while (b < pieces.length && isBlank(pieces[b])) b++;
    if (pieces[a - 1]?.block || pieces[b]?.block) for (let x = a; x < b; x++) drop[x] = true;
    a = b;
  }
  const kept = pieces.filter((_, idx) => !drop[idx]);

  // Join with a newline only between two plain (non-block) pieces — consecutive text lines,
  // or a text line and a kept blank line (which is what renders the paragraph gap under
  // `white-space: pre-wrap`). Block elements need no separating newline on either side; their
  // CSS margins do the spacing, and an added newline would stack an extra blank line on top.
  let out = '';
  for (let k = 0; k < kept.length; k++) {
    const piece = kept[k];
    if (!piece) continue;
    const prev = kept[k - 1];
    if (k > 0 && prev && !prev.block && !piece.block) out += '\n';
    out += piece.html;
  }
  return out;
}

export interface RenderTextOptions {
  /** Provide an emoticon map to enable emoticon substitution (default: off). */
  emoticons?: Record<string, string>;
  /** Custom emoji map (shortcode `name` → image URL). Enables `:name:` → inline `<img>`
   *  for known names (default: off). */
  emoji?: Record<string, string>;
  /** Set false to skip URL linkification. */
  links?: boolean;
  /** Set false to render image URLs as plain links instead of inline images. */
  images?: boolean;
  /** Set false to skip markdown formatting. */
  markdown?: boolean;
  /** Set false to skip block-level markdown (headers/subtext/quotes/lists) and apply only
   *  inline formatting — for single-line contexts like emotes and away lines. */
  blocks?: boolean;
  /** Known users: an `@Name` mention of one renders bold in that user's colour with a
   *  matching glow (default: off). `color` is `#rrggbb`; an invalid one renders unstyled. */
  mentions?: { name: string; color: string }[];
}

/** Turn a raw message body into safe, display-ready HTML. */
export function renderText(raw: string, options: RenderTextOptions = {}): string {
  const tokens: string[] = [];
  const stash = (html: string): string => {
    tokens.push(html);
    return `${SENTINEL}${tokens.length - 1}${SENTINEL}`;
  };

  // Normalize CRLF/CR to LF so line-anchored block markdown (headers `# `, subtext
  // `-# `, whose regexes end in `$`) matches regardless of the source's line endings —
  // e.g. a Windows-authored MOTD.md, or pasted text — not just LF input. Also drop any
  // stray null chars so they cannot collide with the placeholder marker.
  const cleaned = raw.replace(/\r\n?/g, '\n').split(SENTINEL).join('');
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
  // Inline code: a double-backtick span first (so a single backtick can appear inside,
  // ``a`b``), then the single-backtick form.
  s = s.replace(/``([\s\S]+?)``/g, (_m, code: string) =>
    stash(`<code class="mara-code">${escapeHtml(code)}</code>`),
  );
  s = s.replace(/`([^`\n]+?)`/g, (_m, code: string) =>
    stash(`<code class="mara-code">${escapeHtml(code)}</code>`),
  );

  // Backslash escapes: `\` before a character we treat specially renders it literally,
  // dropping the backslash — so `\*not italic\*`, `\|\|x\|\|`, and a leading `\#` / `\-`
  // show as typed. Runs AFTER code spans are stashed (backslashes stay literal inside
  // code) and before markdown / image detection, stashing the escaped char so nothing
  // downstream can re-interpret it.
  s = s.replace(/\\([\\*_~|#>![\]-])/g, (_m, ch: string) => stash(escapeHtml(ch)));

  // Custom emoji `:name:` → inline image, for names in the supplied manifest only.
  // Runs after code spans are stashed (so `:x:` inside `code` is left alone) and before
  // markdown/image detection. The manifest URL is re-validated against the emoji/​http(s)
  // allowlist and escaped, then stashed as trusted HTML like the image tags above.
  if (options.emoji) {
    const emoji = options.emoji;
    s = s.replace(EMOJI_RE, (literal, name: string) => {
      const url = emoji[name];
      if (url === undefined || !EMOJI_URL_RE.test(url)) return literal;
      return stash(emojiTag(name, escapeHtml(toRenderUrl(url))));
    });
  }

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

  // @Mentions of known display names render bold. Matched on the remaining raw text —
  // AFTER code/URL/image stashing, so a mention inside a code span or an image's alt
  // text stays literal — case-insensitively, longest name first (so `@Rosa` never
  // half-bolds a known `@Rosalind`), with the same standing-alone boundaries as the
  // notification matcher: not glued to a preceding word (`mail@host` is never a
  // mention) and not a prefix of a longer word. The name is escaped and stashed, so
  // markdown can't re-parse a name that happens to contain marker characters.
  if (options.mentions && options.mentions.length > 0) {
    const colorOf = new Map<string, string>();
    const names: string[] = [];
    for (const user of options.mentions) {
      const name = user.name.split(SENTINEL).join(''); // a control char in a name must never match a placeholder
      if (name.length === 0) continue;
      names.push(name);
      colorOf.set(name.toLowerCase(), user.color);
    }
    if (names.length > 0) {
      names.sort((a, b) => b.length - a.length);
      const re = new RegExp(`(?<![\\w-])@(?:${names.map(escapeRegExp).join('|')})(?![\\w-])`, 'gi');
      s = s.replace(re, (match) => {
        // The colour is the one mention-controlled value placed in a style attribute —
        // validate it like renderLine does the author colour; invalid → unstyled bold.
        const color = colorOf.get(match.slice(1).toLowerCase()) ?? '';
        const style = /^#[0-9a-fA-F]{6}$/.test(color)
          ? ` style="color:${color};text-shadow:0 0 6px ${color}"`
          : '';
        return stash(`<strong class="mara-mention"${style}>${escapeHtml(match)}</strong>`);
      });
    }
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
