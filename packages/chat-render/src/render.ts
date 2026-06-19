// Line-level rendering: wraps the text→HTML pipeline (text.ts) in the per-kind
// chat/emote/system markup the Svelte ChatView injects via {@html}.
import { escapeHtml, renderText, type RenderTextOptions } from './text.js';

/** How a line is presented: a normal message, a `/me` action, or a server notice. */
export type LineKind = 'chat' | 'emote' | 'system';

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

/** Per-line options; extends the text pipeline's options with timestamp control. */
export interface RenderLineOptions extends RenderTextOptions {
  showTimestamps?: boolean;
}

// Leading timestamp span (with trailing space) or empty string. Suppressed when
// disabled or when the line carries no timestamp.
function ts(line: LineModel, options: RenderLineOptions): string {
  if (options.showTimestamps === false || !line.timestamp) return '';
  return `<span class="mara-ts">${escapeHtml(line.timestamp)}</span> `;
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
  switch (line.kind) {
    case 'chat':
      return (
        `<div class="mara-line mara-chat">${ts(line, options)}` +
        `<span class="mara-author" style="color:${color}">${name}:</span> ` +
        `<span class="mara-text">${renderText(line.text, options)}</span></div>`
      );
    case 'emote':
      return (
        `<div class="mara-line mara-emote">${ts(line, options)}` +
        `<span class="mara-text" style="color:${color}"><em>${name} ${renderText(line.text, options)}</em></span></div>`
      );
    case 'system':
      return (
        `<div class="mara-line mara-system">${ts(line, options)}` +
        `<span class="mara-text"><em>${renderText(line.text, options)}</em></span></div>`
      );
  }
}
