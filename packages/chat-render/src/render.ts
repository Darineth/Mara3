// Line-level rendering: wraps the text→HTML pipeline (text.ts) in the per-kind
// chat/emote/system markup the Svelte ChatView injects via {@html}.
import {
  emojiOnlyCount,
  escapeHtml,
  renderText,
  toRenderUrl,
  type RenderTextOptions,
} from './text.js';

// A chat message that is nothing but emoji renders them large (Discord "jumbo"): `mara-jumbo`
// on the text container, plus `mara-jumbo-lg` for just a few, so ChatView can size them up.
// Past this many the message stays inline — a wall of emoji shouldn't fill the view.
const JUMBO_MAX = 27;
function jumboTextClass(line: LineModel, options: RenderLineOptions): string {
  const n = emojiOnlyCount(line.text, options.emoji);
  if (n < 1 || n > JUMBO_MAX) return 'mara-text';
  return n <= 3 ? 'mara-text mara-jumbo mara-jumbo-lg' : 'mara-text mara-jumbo';
}

/**
 * How a line is presented: a normal message, a `/me` action, a dim server notice
 * (joins/leaves/connection), or a prominent server `notice` (the MOTD) rendered at
 * the default text colour.
 */
export type LineKind = 'chat' | 'emote' | 'system' | 'notice' | 'away';

/** A single conversation line, decoupled from transport/roster types. */
export interface LineModel {
  kind: LineKind;
  authorName: string;
  /** `#rrggbb`; ignored for system lines. */
  authorColor: string;
  /** Hosted avatar path (`/avatars/…`), or empty/absent for the monogram fallback. */
  authorAvatar?: string;
  text: string;
  /** Pre-formatted timestamp string, or omit to render none. */
  timestamp?: string;
}

/** Per-line options: the text pipeline's options plus the line layout. */
export type RenderLineOptions = RenderTextOptions & {
  /** 'mara' (compact — timestamp gutter then `Name: text`) or 'discord' (cozy — a
   *  `Name  timestamp` header with the text below). Defaults to 'mara'. */
  layout?: 'mara' | 'discord';
  /** discord layout only: this chat line continues the previous author's group (same
   *  author, close in time), so drop its `Name  timestamp` header and show just the text. */
  continuation?: boolean;
  /** Show the author avatar (image or monogram) on chat lines. Defaults to true; false
   *  renders names only (no avatar column). */
  avatars?: boolean;
};

// Leading timestamp span, or empty when the line carries no timestamp. Timestamps
// always render when present (no user toggle). It sits in its own column (a flex
// gutter, see ChatView) so the message body wraps to the body's start, not under
// the timestamp — hence no trailing space here.
function ts(line: LineModel): string {
  if (!line.timestamp) return '';
  return `<span class="mara-ts">${escapeHtml(line.timestamp)}</span>`;
}

// Only a hosted path we would have issued is trusted as an avatar `src`; anything else (a
// hand-set or hostile profile) falls back to the monogram. Belt-and-suspenders with the wire
// schema — this HTML is author-controlled and injected via {@html}, so the URL is both
// pattern-validated here and HTML-escaped when interpolated.
function safeAvatarUrl(avatar: string | undefined): string {
  if (!avatar) return '';
  return /^\/(?:avatars|uploads)\/[A-Za-z0-9._-]+(?:\?v=[A-Za-z0-9]+)?$/.test(avatar) ? avatar : '';
}

/** The character for a monogram avatar fallback: the name's first letter or digit, skipping
 *  leading punctuation/symbols (so `*VSCodeStar*` → `V`, `@bob` → `B`), uppercased. Falls
 *  back to `?` when the name has no alphanumeric character. */
export function monogramInitial(name: string): string {
  return (name.match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase();
}

// The author's avatar as an <img>, or a monogram fallback: their initial on their colour.
// `cls` sizes it for the layout (inline for compact, larger for the discord gutter).
function avatarHtml(line: LineModel, color: string, cls: string): string {
  const url = safeAvatarUrl(line.authorAvatar);
  if (url) {
    // Strip the leading slash so the src resolves against the page base (subpath-safe), the
    // same as uploads/emoji.
    return `<img class="mara-avatar ${cls}" src="${escapeHtml(toRenderUrl(url))}" alt="" loading="lazy" />`;
  }
  const initial = escapeHtml(monogramInitial(line.authorName));
  return `<span class="mara-avatar mara-avatar-mono ${cls}" style="background:${color}" aria-hidden="true">${initial}</span>`;
}

/**
 * Render one conversation line to an HTML string. Mirrors Mara 2's chat/emote/
 * plain templates from `MaraStaticData`, but emits plain semantic markup the
 * Svelte ChatView drops into the DOM (no embedded browser needed).
 */
export function renderLine(line: LineModel, options: RenderLineOptions = {}): string {
  // Validate the color before interpolating it into a style attribute (it is the
  // one author-controlled value placed outside of escaped text); fall back to grey.
  const color = /^#[0-9a-fA-F]{6}$/.test(line.authorColor) ? line.authorColor : '#888888';
  const name = escapeHtml(line.authorName);

  // chat: whole "name: body" in the author color (the name stays bold via CSS).
  // emote: whole "name + body" italicized in author color (a `/me` action).
  // system: italic body only, no author (server-generated notice).
  // The body is a single wrapping column after the timestamp gutter, so wrapped
  // lines align to where the author/message starts (see ChatView's flex layout).
  switch (line.kind) {
    case 'chat': {
      const showAv = options.avatars !== false;
      const textClass = jumboTextClass(line, options);
      // discord (cozy): an avatar gutter, then a `Name  timestamp` header with the text
      // below in the default colour. A grouped continuation (same author, close in time)
      // drops the avatar + header and shows just the text, indented to line up under them
      // (or flush left when avatars are off — the `mara-no-av` class zeroes the indent).
      if (options.layout === 'discord') {
        if (options.continuation) {
          return (
            `<div class="mara-line mara-chat mara-discord mara-cont${showAv ? '' : ' mara-no-av'}">` +
            `<div class="${textClass}">${renderText(line.text, options)}</div>` +
            `</div>`
          );
        }
        return (
          `<div class="mara-line mara-chat mara-discord">` +
          (showAv ? avatarHtml(line, color, 'mara-avatar-lg') : '') +
          `<div class="mara-discord-main">` +
          `<div class="mara-head"><span class="mara-author" style="color:${color}">${name}</span>${ts(line)}</div>` +
          `<div class="${textClass}">${renderText(line.text, options)}</div>` +
          `</div></div>`
        );
      }
      // mara (compact): timestamp gutter, a small inline avatar, then `name: body` in colour.
      return (
        `<div class="mara-line mara-chat">${ts(line)}` +
        `<span class="mara-body" style="color:${color}">` +
        (showAv ? avatarHtml(line, color, 'mara-avatar-inline') : '') +
        `<span class="mara-author">${name}:</span> ` +
        `<span class="${textClass}">${renderText(line.text, options)}</span>` +
        `</span></div>`
      );
    }
    case 'emote':
      return (
        `<div class="mara-line mara-emote">${ts(line)}` +
        `<span class="mara-body mara-text" style="color:${color}"><em>${name} ${renderText(line.text, { ...options, blocks: false })}</em></span></div>`
      );
    case 'system':
      // System notices (join/leave/disconnect/connection) embed a user-chosen display
      // name in their text, so they render as ESCAPED TEXT ONLY — no markdown, links,
      // or inline images. Otherwise a name like `http://evil.com` or `![](/uploads/x)`
      // would become a clickable link / image inside everyone's "X joined" line.
      return (
        `<div class="mara-line mara-system">${ts(line)}` +
        `<span class="mara-body mara-text"><em>${renderText(line.text, { links: false, images: false, markdown: false })}</em></span></div>`
      );
    case 'notice':
      // Prominent server notice (MOTD): default text colour, no dim/italic.
      return (
        `<div class="mara-line mara-notice">${ts(line)}` +
        `<span class="mara-body mara-text">${renderText(line.text, options)}</span></div>`
      );
    case 'away':
      // Away/back status, rendered like an emote: the escaped author name + the note,
      // italic in the user's colour. The note gets the full text pipeline (markdown +
      // links), but inline IMAGES are forced off — an away note persists and is re-shown
      // to everyone on join, so it can't plant images across channels.
      return (
        `<div class="mara-line mara-away">${ts(line)}` +
        `<span class="mara-body mara-text" style="color:${color}"><em>${name} ${renderText(line.text, { ...options, images: false, blocks: false })}</em></span></div>`
      );
  }
}
