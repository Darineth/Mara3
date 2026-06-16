/**
 * Text → safe HTML pipeline, porting Mara 2's `MTextProcessors` / `MHtmlEscaper`
 * to the browser. Order matters: emoticons run on the raw text (so `<3` is seen
 * before `<` is escaped), then we escape, then we linkify into the escaped text.
 */

/** Default emoticon set: code → replacement (emoji are plain text, hence safe). */
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
  return escaped.replace(/(https?:\/\/[^\s<]+[^\s<.,!?;:)])/g, (url) => {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });
}

export interface RenderTextOptions {
  emoticons?: Record<string, string>;
  /** Set false to skip URL linkification. */
  links?: boolean;
}

/** Turn a raw message body into safe, display-ready HTML. */
export function renderText(raw: string, options: RenderTextOptions = {}): string {
  const withEmoji = applyEmoticons(raw, options.emoticons ?? DEFAULT_EMOTICONS);
  const escaped = escapeHtml(withEmoji);
  return options.links === false ? escaped : linkify(escaped);
}
