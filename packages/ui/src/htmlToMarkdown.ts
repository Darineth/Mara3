/**
 * Turn the `text/html` flavour of a clipboard paste into the markdown Mara's renderer
 * (@mara/chat-render) understands, so copying from a web page keeps its bold, links, lists,
 * tables and code instead of flattening them to bare text.
 *
 * Only syntax the renderer actually has is emitted. That shapes a few choices:
 *  - There are no `[text](url)` links, so a link whose text differs from its URL becomes
 *    `text (url)`; one whose text IS the URL is just the URL.
 *  - Lists are flat, so nested items are lifted to the same level as their parent.
 *  - A URL stops only at whitespace, `<` or `|`, so one at the end of a formatted run would
 *    swallow the closing `**`; trailing URLs are kept outside the markers (see `wrap`).
 *
 * Returns null when the HTML carries no formatting worth keeping (a paste from a code editor
 * is a pile of coloured spans; a plain paragraph is just text) — the caller then pastes the
 * plain-text flavour exactly as it would have anyway.
 */
export function htmlToMarkdown(html: string): string | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const st = newState();
  walk(doc.body, st);
  flush(st, 1);
  if (!st.rich) return null;
  const out = join(st.blocks).trim();
  return out === '' ? null : out;
}

/** Inline formatting in force at a point in the tree. */
interface Marks {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
}
const NONE: Marks = { bold: false, italic: false, underline: false, strike: false };

/** A finished block plus how far it sits from its neighbours: 1 = next line (a `<div>`, as
 *  chat logs and most app UIs are built), 2 = a blank line between (paragraphs and the
 *  structural blocks). The larger of two neighbours' gaps wins. */
interface Block {
  text: string;
  gap: 1 | 2;
}

interface State {
  blocks: Block[];
  /** Inline text of the block currently being gathered. */
  buf: string;
  /** Set once anything is emitted that plain text couldn't have said. */
  rich: boolean;
}

function newState(): State {
  return { blocks: [], buf: '', rich: false };
}

const BLOCK_TAGS = [
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'CAPTION',
  'CENTER',
  'DD',
  'DETAILS',
  'DIALOG',
  'DIV',
  'DL',
  'DT',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'FORM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HGROUP',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'SUMMARY',
  'TABLE',
  'TBODY',
  'TD',
  'TFOOT',
  'TH',
  'THEAD',
  'TR',
  'UL',
];
const BLOCK = new Set(BLOCK_TAGS);
const BLOCK_SELECTOR = BLOCK_TAGS.map((t) => t.toLowerCase()).join(',');

/** Never text the user meant to paste: page machinery, and controls (whose labels are noise
 *  — Mara's own log, for one, is full of reaction and copy buttons). */
const SKIP = new Set([
  'BUTTON',
  'CANVAS',
  'HEAD',
  'IFRAME',
  'INPUT',
  'LINK',
  'META',
  'NOSCRIPT',
  'OBJECT',
  'OPTION',
  'SCRIPT',
  'SELECT',
  'STYLE',
  'SVG',
  'TEMPLATE',
  'TEXTAREA',
  'TITLE',
]);

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

function isElement(node: Node): node is HTMLElement {
  return node.nodeType === ELEMENT_NODE;
}

function skipped(el: HTMLElement): boolean {
  if (SKIP.has(el.tagName)) return true;
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true;
  return /display\s*:\s*none/i.test(el.getAttribute('style') ?? '');
}

// ── Blocks ─────────────────────────────────────────────────────────────────────────────

function flush(st: State, gap: 1 | 2) {
  const text = tidy(st.buf);
  st.buf = '';
  if (text) st.blocks.push({ text, gap });
}

function push(st: State, text: string, gap: 1 | 2 = 2) {
  if (text) st.blocks.push({ text, gap });
}

function join(blocks: Block[]): string {
  let out = '';
  blocks.forEach((b, i) => {
    const prev = blocks[i - 1];
    if (prev) out += Math.max(prev.gap, b.gap) === 2 ? '\n\n' : '\n';
    out += b.text;
  });
  return out;
}

/** Tidy a gathered paragraph: trim each line, squeeze runs of spaces and blank lines, and
 *  escape a line that would otherwise start as a heading/quote/list by accident. Lines of a
 *  fenced code block (from a `<pre>` inside inline content) are left exactly as they are. */
function tidy(text: string): string {
  let inFence = false;
  return text
    .split('\n')
    .map((l) => {
      if (l.trimStart().startsWith('```')) {
        inFence = !inFence;
        return l.trim();
      }
      if (inFence) return l;
      return l
        .replace(/ {2,}/g, ' ')
        .trim()
        .replace(/^(#{1,3} |-# |>|[-*] )/, '\\$1');
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function walk(node: Node, st: State) {
  for (const child of node.childNodes) {
    if (child.nodeType === TEXT_NODE) {
      st.buf += inline(child, NONE, st);
      continue;
    }
    if (!isElement(child) || skipped(child)) continue;
    const tag = child.tagName;
    if (!BLOCK.has(tag)) {
      // An inline element wrapping whole blocks (Google Docs wraps every paste in one `<b>`)
      // is looked through rather than flattened into one line.
      if (child.querySelector(BLOCK_SELECTOR)) walk(child, st);
      else st.buf += inline(child, NONE, st);
      continue;
    }
    flush(st, 1);
    switch (tag) {
      case 'H1':
      case 'H2':
      case 'H3': {
        const text = oneLine(inlineChildren(child, { ...NONE, bold: true }, st));
        if (text) {
          push(st, `${'#'.repeat(Number(tag[1]))} ${text}`);
          st.rich = true;
        }
        break;
      }
      case 'H4':
      case 'H5':
      case 'H6': {
        const text = oneLine(inlineChildren(child, { ...NONE, bold: true }, st));
        if (text) {
          push(st, `**${text}**`);
          st.rich = true;
        }
        break;
      }
      case 'UL':
      case 'OL': {
        const lines = list(child, st);
        if (lines.length > 0) {
          push(st, lines.join('\n'));
          st.rich = true;
        }
        break;
      }
      case 'BLOCKQUOTE': {
        const sub = newState();
        walk(child, sub);
        flush(sub, 1);
        const body = join(sub.blocks);
        if (body) {
          push(
            st,
            body
              .split('\n')
              .map((l) => (l ? `> ${l}` : '>'))
              .join('\n'),
          );
          st.rich = true;
        }
        break;
      }
      case 'PRE':
        push(st, fence(child));
        st.rich = true;
        break;
      case 'TABLE': {
        const table = gridTable(child, st);
        if (table) {
          push(st, table);
          st.rich = true;
        } else {
          // A layout table (one row or one column): its contents, not a grid.
          walk(child, st);
          flush(st, 1);
        }
        break;
      }
      case 'HR':
        break;
      default:
        walk(child, st);
        flush(st, tag === 'P' ? 2 : 1);
    }
  }
}

/** A list's items as marker lines. Nested lists come out as items of their own right after
 *  their parent — the renderer's lists are flat. */
function list(el: HTMLElement, st: State): string[] {
  const lines: string[] = [];
  let n = Number(el.getAttribute('start')) || 1;
  for (const item of el.children) {
    if (!isElement(item) || skipped(item)) continue;
    if (item.tagName === 'UL' || item.tagName === 'OL') {
      lines.push(...list(item, st)); // a list nested directly in a list (invalid, but common)
      continue;
    }
    let text = '';
    const nested: string[] = [];
    for (const c of item.childNodes) {
      if (isElement(c) && (c.tagName === 'UL' || c.tagName === 'OL')) {
        if (!skipped(c)) nested.push(...list(c, st));
      } else {
        text += inline(c, NONE, st);
      }
    }
    text = oneLine(text);
    if (text) lines.push(`${el.tagName === 'OL' ? `${n++}.` : '-'} ${text}`);
    lines.push(...nested);
  }
  return lines;
}

/** A `<pre>` as a fenced code block, with the language hint GitHub-style pages carry. */
function fence(el: HTMLElement): string {
  const code = (el.textContent ?? '').replace(/\n$/, '');
  const cls = `${el.className} ${el.querySelector('code')?.className ?? ''}`;
  const lang = /(?:^|\s)(?:language|lang)-([a-zA-Z0-9+#.-]+)/.exec(cls)?.[1] ?? '';
  return `\`\`\`${lang}\n${code}\n\`\`\``;
}

/** A data table as a GitHub-style table (first row = header). Null for a table that is
 *  really layout — a single row or column — so its contents are pasted as text instead. */
function gridTable(el: HTMLElement, st: State): string | null {
  const rows: HTMLElement[] = [];
  for (const c of el.children) {
    if (!isElement(c)) continue;
    if (c.tagName === 'TR') rows.push(c);
    else if (/^(THEAD|TBODY|TFOOT)$/.test(c.tagName))
      for (const r of c.children) if (isElement(r) && r.tagName === 'TR') rows.push(r);
  }
  const grid = rows.map((r) =>
    [...r.children]
      .filter((c): c is HTMLElement => isElement(c) && /^(TD|TH)$/.test(c.tagName))
      // A lone `|` is a cell boundary (an escaped `\|\|` spoiler-guard is already safe).
      .map((c) => oneLine(inlineChildren(c, NONE, st)).replace(/(?<!\\)\|/g, '\\|')),
  );
  const cols = Math.max(0, ...grid.map((r) => r.length));
  if (grid.length < 2 || cols < 2) return null;
  const row = (cells: string[]) =>
    `| ${Array.from({ length: cols }, (_, i) => cells[i] ?? '').join(' | ')} |`;
  const [head = [], ...body] = grid;
  return [row(head), row(Array(cols).fill('---')), ...body.map(row)].join('\n');
}

// ── Inline ─────────────────────────────────────────────────────────────────────────────

function inlineChildren(el: Node, active: Marks, st: State): string {
  let out = '';
  for (const c of el.childNodes) out += inline(c, active, st);
  return out;
}

function inline(node: Node, active: Marks, st: State): string {
  if (node.nodeType === TEXT_NODE) {
    return escapeText((node.textContent ?? '').replace(/[\s ]+/g, ' '));
  }
  if (!isElement(node) || skipped(node)) return '';
  const el = node;
  switch (el.tagName) {
    case 'BR':
      return '\n';
    case 'IMG':
      return image(el, st);
    case 'A':
      return link(el, active, st);
    case 'CODE':
    case 'KBD':
    case 'SAMP':
    case 'TT':
      return code(el, st);
    case 'PRE':
      st.rich = true;
      return `\n${fence(el)}\n`;
  }
  // A block inside inline content (a `<p>` in a list item or table cell) runs on as a space.
  if (BLOCK.has(el.tagName)) return ` ${inlineChildren(el, active, st)} `;
  const own = marks(el);
  const add: Marks = {
    bold: own.bold && !active.bold,
    italic: own.italic && !active.italic,
    underline: own.underline && !active.underline,
    strike: own.strike && !active.strike,
  };
  const inner = inlineChildren(
    el,
    {
      bold: active.bold || add.bold,
      italic: active.italic || add.italic,
      underline: active.underline || add.underline,
      strike: active.strike || add.strike,
    },
    st,
  );
  let out = inner;
  if (add.strike) out = wrap(out, '~~', st);
  if (add.underline) out = wrap(out, '__', st);
  if (add.italic) out = wrap(out, '*', st);
  if (add.bold) out = wrap(out, '**', st);
  return out;
}

/** The formatting an element applies itself — by tag, or by inline style, which is how
 *  browsers put a copied selection on the clipboard (and how Google Docs marks everything).
 *  An explicit style wins over the tag: Docs wraps the whole paste in `<b style="font-weight:
 *  normal">`. */
function marks(el: HTMLElement): Marks {
  const style = el.style;
  const tag = el.tagName;
  const weight = style.fontWeight;
  const bold = weight
    ? weight === 'bold' || weight === 'bolder' || Number(weight) >= 600
    : tag === 'B' || tag === 'STRONG';
  const fontStyle = style.fontStyle;
  const italic = fontStyle
    ? fontStyle === 'italic' || fontStyle.startsWith('oblique')
    : /^(I|EM|CITE|VAR|DFN)$/.test(tag);
  const decoration = `${style.textDecoration} ${style.textDecorationLine}`;
  return {
    bold,
    italic,
    underline: tag === 'U' || tag === 'INS' || decoration.includes('underline'),
    strike: /^(S|DEL|STRIKE)$/.test(tag) || decoration.includes('line-through'),
  };
}

// A URL (or a `(url)` from a link) at the very end of a formatted run.
const TRAILING_URL_RE = /^([\s\S]*?)(\s*\(?https?:\/\/\S*)$/;

/**
 * Wrap `text` in a markdown marker, line by line (a marker can't span lines), with the
 * surrounding whitespace moved outside — the renderer, like Discord, won't format `** x **`.
 * A URL at the end stays outside the closing marker, since the renderer would read the marker
 * as part of the URL.
 */
function wrap(text: string, mk: string, st: State): string {
  return text
    .split('\n')
    .map((line) => {
      const [, lead = '', body = '', trail = ''] = /^(\s*)([\s\S]*?)(\s*)$/.exec(line) ?? [];
      if (!body) return line;
      const url = TRAILING_URL_RE.exec(body);
      if (url) {
        const before = url[1] ?? '';
        return before.trim() ? `${lead}${wrap(before, mk, st)}${url[2]}${trail}` : line;
      }
      st.rich = true;
      return `${lead}${mk}${body}${mk}${trail}`;
    })
    .join('\n');
}

/** A link: the URL alone when that's all the text says, else `text (url)`. Anything that
 *  isn't an absolute http(s) link (an in-page `#anchor`, `mailto:`, `javascript:`) keeps
 *  just its text. */
function link(el: HTMLElement, active: Marks, st: State): string {
  const text = inlineChildren(el, active, st);
  const href = (el.getAttribute('href') ?? '').trim();
  if (!/^https?:\/\/\S+$/i.test(href)) return text;
  const shown = text.trim();
  // The text is the URL itself, or a shortened display of one (`example.com/foo…`).
  const bare = (s: string) => s.replace(/^https?:\/\/(www\.)?/i, '').replace(/[/…]+$/, '');
  if (
    !shown ||
    bare(shown.replace(/\\/g, '')) === bare(href) ||
    /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(shown)
  ) {
    return href;
  }
  st.rich = true;
  const [, lead = '', trail = ''] = /^(\s*)[\s\S]*?(\s*)$/.exec(text) ?? [];
  return `${lead}${shown} (${href})${trail}`;
}

/** Inline code; one with a line break in it is really a code block. A backtick inside can't
 *  be written as code, so that falls back to plain (escaped) text. */
function code(el: HTMLElement, st: State): string {
  const raw = el.textContent ?? '';
  if (raw.includes('\n')) {
    st.rich = true;
    return `\n${fence(el)}\n`;
  }
  if (!raw.trim() || raw.includes('`')) return escapeText(raw);
  st.rich = true;
  return `\`${raw}\``;
}

/** An image: an emoji picture becomes its text (a custom emoji's `:name:`, or the Unicode
 *  emoji an image set like Twemoji draws), an absolute-URL picture becomes `![alt](url)`,
 *  and icons (sized under 48px) and anything unreachable (relative, `data:`) are dropped. */
function image(el: HTMLElement, st: State): string {
  const alt = (el.getAttribute('alt') ?? '').trim();
  if (/^:[\w+-]+:$/.test(alt)) return alt;
  if (alt && alt.length <= 8 && !/[\x00-\x7f]/.test(alt)) return alt;
  const src = (el.getAttribute('src') ?? '').trim();
  if (!/^https?:\/\/[^\s)]+$/i.test(src)) return '';
  const w = Number(el.getAttribute('width'));
  const h = Number(el.getAttribute('height'));
  if ((w > 0 && w < 48) || (h > 0 && h < 48)) return '';
  st.rich = true;
  return `![${alt.replace(/[[\]()\n]/g, '')}](${src})`;
}

// URLs are left exactly as written: the renderer finds them before it looks at escapes, so a
// backslash inside one would end up in the link.
const URL_SPLIT_RE = /(https?:\/\/[^\s<|]+)/;

/** Escape the characters the renderer would read as formatting, outside of URLs. `_` only
 *  formats at a word boundary, so `snake_case` is left alone; `~` and `|` only in pairs. */
function escapeText(text: string): string {
  return text
    .split(URL_SPLIT_RE)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(/\\/g, '\\\\')
            .replace(/\*/g, '\\*')
            .replace(/(?<!\w)_|_(?!\w)/g, '\\_')
            .replace(/~~/g, '\\~\\~')
            .replace(/\|\|/g, '\\|\\|')
            .replace(/\[(?=\/?(?:b|i|u|s|img|spoiler)\])/gi, '\\['),
    )
    .join('');
}

function oneLine(text: string): string {
  return text
    .replace(/\s*\n\s*/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}
