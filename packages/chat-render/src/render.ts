// Line-level rendering: wraps the text→HTML pipeline (text.ts) in the per-kind
// chat/emote/system markup the Svelte ChatView injects via {@html}.
import { escapeHtml, renderText, type RenderTextOptions } from './text.js';

/**
 * How a line is presented: a normal message, a `/me` action, a dim server notice
 * (joins/leaves/connection), or a prominent server `notice` (the MOTD) rendered at
 * the default text colour.
 */
export type LineKind = 'chat' | 'emote' | 'system' | 'notice';

/** A single conversation line, decoupled from transport/roster types. */
export interface LineModel {
  kind: LineKind;
  authorName: string;
  /** `#rrggbb`; ignored for system lines. */
  authorColor: string;
  text: string;
  /** Pre-formatted timestamp string, or omit to render none. */
  timestamp?: string;
}

/** Per-line options; currently just the text pipeline's options. */
export type RenderLineOptions = RenderTextOptions;

// Leading timestamp span, or empty when the line carries no timestamp. Timestamps
// always render when present (no user toggle). It sits in its own column (a flex
// gutter, see ChatView) so the message body wraps to the body's start, not under
// the timestamp — hence no trailing space here.
function ts(line: LineModel): string {
  if (!line.timestamp) return '';
  return `<span class="mara-ts">${escapeHtml(line.timestamp)}</span>`;
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

  // chat: "name:" prefix in author color, body in default color.
  // emote: whole "name + body" italicized in author color (a `/me` action).
  // system: italic body only, no author (server-generated notice).
  // The body is a single wrapping column after the timestamp gutter, so wrapped
  // lines align to where the author/message starts (see ChatView's flex layout).
  switch (line.kind) {
    case 'chat':
      return (
        `<div class="mara-line mara-chat">${ts(line)}` +
        `<span class="mara-body">` +
        `<span class="mara-author" style="color:${color}">${name}:</span> ` +
        `<span class="mara-text">${renderText(line.text, options)}</span>` +
        `</span></div>`
      );
    case 'emote':
      return (
        `<div class="mara-line mara-emote">${ts(line)}` +
        `<span class="mara-body mara-text" style="color:${color}"><em>${name} ${renderText(line.text, options)}</em></span></div>`
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
  }
}
