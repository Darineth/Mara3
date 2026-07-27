/**
 * Composer syntax highlighting — the same text a message is written in, marked up so the
 * formatting it will get is visible AS IT IS TYPED (Discord's composer, rather than a plain
 * box). `**bold**` shows the asterisks dimmed and the word emboldened, a `:shortcode:` and an
 * `@name` light up once they're known, a code span gets its tint, and so on.
 *
 * Two rules govern everything here, and both are load-bearing:
 *
 *  1. **The text is never changed.** Markers stay where they were typed; nothing is inserted,
 *     removed, or reordered. The output's textContent is character-for-character the input.
 *     The client paints this behind a transparent textarea, so any drift would slide the
 *     highlighting out from under the caret. The tests assert the invariant directly.
 *
 *  2. **It recognises exactly what {@link renderText} acts on** — same patterns, same order,
 *     same precedence (code spans win over markdown, a `:name:` only lights up when the server
 *     actually has that emoji, an unknown `[img]` payload stays plain text). The token patterns
 *     are imported from `text.ts` rather than restated, so the two cannot drift apart.
 *
 * What the CLIENT then does with the classes is deliberately constrained: the styling must not
 * change any glyph's advance width, or the mirrored text would stop lining up with the textarea
 * under it. Colour, background, and decoration are free; font-family and font-size are not.
 * See the `.mara-hl` rules in ChatInput for how bold and italic are drawn within that limit.
 */
import {
  EMOJI_RE,
  EMOJI_URL_RE,
  IMG_MD_RE,
  IMG_TAG_RE,
  IMG_URL_RE,
  MARKED_URL_RE,
  escapeHtml,
  escapeRegExp,
} from './text.js';

// Same placeholder scheme as renderText: a null char cannot appear in chat text, so it marks
// a stashed span safely. Stashed HTML is restored in a SINGLE non-recursive pass at the end,
// so a stashed token must never itself contain a placeholder (see markHtml vs mark below).
const SENTINEL = String.fromCharCode(0);
const RESTORE_RE = new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, 'g');

export interface HighlightOptions {
  /** The server's custom emoji (shortcode → URL). A `:name:` is only highlighted when the
   *  name is in here — matching the renderer, which leaves an unknown one as literal text. */
  emoji?: Record<string, string>;
  /** Known display names. An `@name` of one is highlighted as a mention. */
  mentions?: string[];
}

/**
 * Mark up `raw` (a composer draft) as HTML that reads identically but shows its formatting.
 * The result is safe to inject: every character of the input is HTML-escaped, and the only
 * markup around it is this module's own fixed spans and tags.
 */
export function highlightComposer(raw: string, options: HighlightOptions = {}): string {
  const tokens: string[] = [];
  const stash = (html: string): string => {
    tokens.push(html);
    return `${SENTINEL}${tokens.length - 1}${SENTINEL}`;
  };
  /** A syntax marker, kept visible but dimmed. Takes ALREADY-ESCAPED text. */
  const markHtml = (escaped: string): string => `<span class="mara-hl-mk">${escaped}</span>`;
  /** As {@link markHtml}, but stashed — markers we keep in the running text would otherwise be
   *  re-matched by a later markdown pass (the `***` we just kept would look like a `**`).
   *  Only for text that stays in the stream; markers built INSIDE a stashed token use
   *  markHtml, since a placeholder nested in a token would survive the single-pass restore. */
  const mark = (escaped: string): string => stash(markHtml(escaped));
  const link = (escaped: string): string => `<span class="mara-hl-link">${escaped}</span>`;

  // Null chars would collide with the placeholder marker; renderText drops them too.
  let s = raw.split(SENTINEL).join('');

  // ── Atomic tokens, matched on the RAW text and stashed, exactly as renderText does ──
  // Fenced code block, with its optional language hint.
  s = s.replace(
    /```(?:([a-zA-Z0-9+#.-]*)\n)?([\s\S]*?)```/g,
    (_m, lang: string | undefined, code: string) => {
      const open = '```' + (lang === undefined ? '' : `${lang}\n`);
      return stash(
        `<span class="mara-hl-code">${markHtml(escapeHtml(open))}${escapeHtml(code)}` +
          `${markHtml('```')}</span>`,
      );
    },
  );
  // Inline code: the double-backtick form first, then the single.
  s = s.replace(/``([\s\S]+?)``/g, (_m, code: string) =>
    stash(
      `<span class="mara-hl-code">${markHtml('``')}${escapeHtml(code)}${markHtml('``')}</span>`,
    ),
  );
  s = s.replace(/`([^`\n]+?)`/g, (_m, code: string) =>
    stash(`<span class="mara-hl-code">${markHtml('`')}${escapeHtml(code)}${markHtml('`')}</span>`),
  );
  // Backslash escapes: the backslash reads as a marker, the character it protects as plain
  // text — and stashing it keeps the markdown passes off a character that was escaped out.
  s = s.replace(/\\([\\*_~|#>![\]-])/g, (_m, ch: string) => stash(markHtml('\\') + escapeHtml(ch)));
  // Custom emoji, for names the server actually has.
  if (options.emoji) {
    const emoji = options.emoji;
    s = s.replace(EMOJI_RE, (literal: string, name: string) => {
      const url = emoji[name];
      if (url === undefined || !EMOJI_URL_RE.test(url)) return literal;
      return stash(`<span class="mara-hl-emoji">${escapeHtml(literal)}</span>`);
    });
  }
  // Legacy `[img]URL[/img]` and Markdown `![alt](url)`. A payload the renderer wouldn't honor
  // is left alone, so it stays plain (and may still light up as a bare URL below).
  s = s.replace(IMG_TAG_RE, (m: string, inner: string) => {
    if (!IMG_URL_RE.test(inner.trim())) return m;
    // The tags are matched case-insensitively but are a fixed length, so the original
    // spelling (`[IMG]`) is carried through from the match itself.
    return stash(
      markHtml(escapeHtml(m.slice(0, 5))) +
        link(escapeHtml(inner)) +
        markHtml(escapeHtml(m.slice(-6))),
    );
  });
  s = s.replace(IMG_MD_RE, (m: string, alt: string, url: string) => {
    if (!IMG_URL_RE.test(url.trim())) return m;
    return stash(
      markHtml('![') + escapeHtml(alt) + markHtml('](') + link(escapeHtml(url)) + markHtml(')'),
    );
  });
  // Bare URLs, with the optional `!` inline-image marker ahead of one.
  s = s.replace(MARKED_URL_RE, (_m, bang: string, url: string) =>
    stash((bang === '!' ? markHtml('!') : '') + link(escapeHtml(url))),
  );
  // @Mentions of known names — same longest-first, standing-alone matching as the renderer.
  const names = (options.mentions ?? [])
    .map((name) => name.split(SENTINEL).join(''))
    .filter((name) => name.length > 0)
    .sort((a, b) => b.length - a.length);
  if (names.length > 0) {
    const re = new RegExp(`(?<![\\w-])@(?:${names.map(escapeRegExp).join('|')})(?![\\w-])`, 'gi');
    s = s.replace(re, (m: string) =>
      stash(`<span class="mara-hl-mention">${escapeHtml(m)}</span>`),
    );
  }

  // Everything left is plain text; the placeholders survive escaping untouched.
  s = escapeHtml(s);

  // ── Markdown, on the escaped text ──
  // Inline markers are fixed strings, so their stashed spans are built once and reused.
  const MK = {
    b3: mark('***'),
    b2: mark('**'),
    b1: mark('*'),
    u2: mark('__'),
    u1: mark('_'),
    strike: mark('~~'),
    spoiler: mark('||'),
  };
  // Italic is the one style that can't simply be switched on: the italic FACE has its own
  // advance widths, so a slanted run drifts out from under the caret and can even wrap in a
  // different place than the textarea does (measured at roughly a quarter-pixel per character
  // in Segoe UI — a visible shift by the end of a phrase, and `font-synthesis-style:
  // oblique-only`, which would have forced a synthesised slant, isn't supported in Chromium).
  //
  // So the regular face is slanted instead, one word at a time: each word becomes its own
  // atomic box (see `.mara-hl-em` in ChatInput) whose width is the regular face's, and the
  // spaces between them stay ordinary text — so the line still breaks exactly where the
  // textarea breaks it. Emphasis carrying anything but plain text (a code span, a link,
  // nested bold) is left upright: the word boundaries inside it aren't ours to find, and an
  // approximate answer here is worse than none.
  const emphasis = (content: string): string => {
    if (content.includes('<') || content.includes(SENTINEL)) return `<em>${content}</em>`;
    const slanted = content
      .split(/( +)/)
      .map((part) => (part.startsWith(' ') ? part : `<span class="mara-hl-em">${part}</span>`))
      .join('');
    return `<em>${slanted}</em>`;
  };
  // Mirrors applyMarkdown's rules and ORDER; only the markers are kept rather than consumed.
  const inline = (line: string): string =>
    line
      .replace(
        /\*\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*\*/g,
        (_m, body: string) => `${MK.b3}<strong>${emphasis(body)}</strong>${MK.b3}`,
      )
      .replace(/\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/g, `${MK.b2}<strong>$1</strong>${MK.b2}`)
      .replace(
        /\*(?=\S)([\s\S]+?)(?<=\S)\*/g,
        (_m, body: string) => `${MK.b1}${emphasis(body)}${MK.b1}`,
      )
      .replace(/(?<!\w)__(?=\S)([\s\S]+?)(?<=\S)__(?!\w)/g, `${MK.u2}<u>$1</u>${MK.u2}`)
      .replace(
        /(?<!\w)_(?=\S)([\s\S]+?)(?<=\S)_(?!\w)/g,
        (_m, body: string) => `${MK.u1}${emphasis(body)}${MK.u1}`,
      )
      .replace(/~~(?=\S)([\s\S]+?)(?<=\S)~~/g, `${MK.strike}<s>$1</s>${MK.strike}`)
      .replace(
        /\|\|([\s\S]+?)\|\|/g,
        `${MK.spoiler}<span class="mara-hl-spoiler">$1</span>${MK.spoiler}`,
      )
      // Legacy BBCode. Matched case-insensitively, so each tag's own spelling is carried
      // through from the capture rather than rewritten to lowercase.
      .replace(/(\[b\])([\s\S]+?)(\[\/b\])/gi, (_m, o: string, body: string, c: string) =>
        [mark(o), '<strong>', body, '</strong>', mark(c)].join(''),
      )
      .replace(/(\[i\])([\s\S]+?)(\[\/i\])/gi, (_m, o: string, body: string, c: string) =>
        [mark(o), emphasis(body), mark(c)].join(''),
      )
      .replace(/(\[u\])([\s\S]+?)(\[\/u\])/gi, (_m, o: string, body: string, c: string) =>
        [mark(o), '<u>', body, '</u>', mark(c)].join(''),
      )
      .replace(/(\[s\])([\s\S]+?)(\[\/s\])/gi, (_m, o: string, body: string, c: string) =>
        [mark(o), '<s>', body, '</s>', mark(c)].join(''),
      )
      .replace(
        /(\[spoiler\])([\s\S]+?)(\[\/spoiler\])/gi,
        (_m, o: string, body: string, c: string) =>
          [mark(o), '<span class="mara-hl-spoiler">', body, '</span>', mark(c)].join(''),
      );

  // Block markers, line by line. applyBlocks folds runs of lines into one element and drops
  // blank lines around them; here every line keeps its own newline — the mirror has to stay
  // line-for-line with the textarea — so each line is simply classified on its own.
  const lines = s.split('\n');
  const out: string[] = [];
  const quote = (html: string) => `<span class="mara-hl-quote">${html}</span>`;
  // `>>> ` quotes the rest of the message, so once seen every later line is quoted too.
  let restQuoted = false;
  for (const line of lines) {
    if (restQuoted) {
      out.push(quote(inline(line)));
      continue;
    }
    if (line === '&gt;&gt;&gt;' || line.startsWith('&gt;&gt;&gt; ')) {
      restQuoted = true;
      const marker = line.startsWith('&gt;&gt;&gt; ') ? '&gt;&gt;&gt; ' : '&gt;&gt;&gt;';
      out.push(quote(markHtml(marker) + inline(line.slice(marker.length))));
      continue;
    }
    if (line === '&gt;' || line.startsWith('&gt; ')) {
      const marker = line.startsWith('&gt; ') ? '&gt; ' : '&gt;';
      out.push(quote(markHtml(marker) + inline(line.slice(marker.length))));
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^(#{1,3}) (.+)$/.exec(line))) {
      const level = (m[1] ?? '#').length;
      out.push(
        `<span class="mara-hl-h${level}">${markHtml(`${m[1]} `)}${inline(m[2] ?? '')}</span>`,
      );
      continue;
    }
    if ((m = /^-# (.+)$/.exec(line))) {
      out.push(`<span class="mara-hl-subtext">${markHtml('-# ')}${inline(m[1] ?? '')}</span>`);
      continue;
    }
    if ((m = /^( *[-*] )(.*)$/.exec(line)) || (m = /^( *\d+\. )(.*)$/.exec(line))) {
      out.push(markHtml(m[1] ?? '') + inline(m[2] ?? ''));
      continue;
    }
    out.push(inline(line));
  }
  s = out.join('\n');

  // Restore every placeholder in a single non-recursive pass (see the note on `mark`).
  return s.replace(RESTORE_RE, (_m, i: string) => tokens[Number(i)] ?? '');
}
