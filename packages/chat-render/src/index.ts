/** @mara/chat-render — turn chat messages into safe, display-ready HTML. */
export {
  escapeHtml,
  applyEmoticons,
  applyMarkdown,
  linkify,
  renderText,
  DEFAULT_EMOTICONS,
  type RenderTextOptions,
} from './text.js';
export {
  renderLine,
  monogramInitial,
  type LineModel,
  type LineKind,
  type RenderLineOptions,
} from './render.js';
