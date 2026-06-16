import { escapeHtml, renderText, type RenderTextOptions } from './text.js';

export type LineKind = 'chat' | 'emote' | 'system';

export interface LineModel {
  kind: LineKind;
  authorName: string;
  /** `#rrggbb`; ignored for system lines. */
  authorColor: string;
  text: string;
  /** Pre-formatted timestamp string, or omit to render none. */
  timestamp?: string;
}

export interface RenderLineOptions extends RenderTextOptions {
  showTimestamps?: boolean;
}

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
  const color = /^#[0-9a-fA-F]{6}$/.test(line.authorColor) ? line.authorColor : '#888888';
  const name = escapeHtml(line.authorName);

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
