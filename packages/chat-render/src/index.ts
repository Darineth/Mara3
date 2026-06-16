/** @mara/chat-render — turn chat messages into safe, display-ready HTML. */
export {
  escapeHtml,
  applyEmoticons,
  linkify,
  renderText,
  DEFAULT_EMOTICONS,
  type RenderTextOptions,
} from './text.js';
export { renderLine, type LineModel, type LineKind, type RenderLineOptions } from './render.js';
