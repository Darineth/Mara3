/**
 * @mara/plugin-api — the modern reimagining of Mara 2's `MaraPlugin`.
 *
 * The original was a native C++ DLL loaded via `QPluginLoader` exposing three
 * text-transformation hooks. Here a plugin is just a TypeScript object; plugins
 * are composed into a {@link TextPipeline} the client applies to outgoing and
 * incoming message text. (Build-time registration is CSP-safe for web/mobile;
 * desktop can additionally `import()` plugins dynamically.)
 */

/** Per-invocation metadata passed to every hook so transforms can be context-aware. */
export interface PluginContext {
  direction: 'incoming' | 'outgoing';
  channelToken?: number;
  fromToken?: number;
}

/** A plugin implements one or more of the three text hooks. */
export interface MaraPlugin {
  readonly name: string;
  readonly version?: string;
  /** Transform incoming text before display (first pass). */
  preprocessText?(text: string, ctx: PluginContext): string;
  /** Transform incoming text before display (final pass). */
  postprocessText?(text: string, ctx: PluginContext): string;
  /** Transform the user's text before it is sent. */
  preprocessOutgoing?(text: string, ctx: PluginContext): string;
}

/**
 * Chained text transforms the client applies at send/receive boundaries.
 * On receive the client runs `preprocessText` (early pass, e.g. decode/parse)
 * then `postprocessText` (late pass, e.g. render-time substitution); on send it
 * runs `preprocessOutgoing`. `ctx` is partial here — `createPipeline` fills in
 * the `direction` before handing it to each plugin.
 */
export interface TextPipeline {
  readonly plugins: readonly MaraPlugin[];
  preprocessText(text: string, ctx?: Partial<PluginContext>): string;
  postprocessText(text: string, ctx?: Partial<PluginContext>): string;
  preprocessOutgoing(text: string, ctx?: Partial<PluginContext>): string;
}

function fold(
  plugins: readonly MaraPlugin[],
  hook: keyof Pick<MaraPlugin, 'preprocessText' | 'postprocessText' | 'preprocessOutgoing'>,
  text: string,
  ctx: PluginContext,
): string {
  // Left-to-right fold: each plugin sees the previous one's output, so
  // registration order is the transform order. Plugins without the hook
  // pass the text through untouched.
  let result = text;
  for (const plugin of plugins) {
    const fn = plugin[hook];
    if (fn) result = fn.call(plugin, result, ctx);
  }
  return result;
}

/** Compose plugins (applied in order) into a {@link TextPipeline}. */
export function createPipeline(plugins: MaraPlugin[]): TextPipeline {
  // Snapshot so later mutation of the caller's array can't change the pipeline.
  // Each boundary supplies a default `direction` before spreading the caller's
  // partial ctx (which normally omits direction, leaving the default in place).
  const list = [...plugins];
  return {
    plugins: list,
    preprocessText: (text, ctx) =>
      fold(list, 'preprocessText', text, { direction: 'incoming', ...ctx }),
    postprocessText: (text, ctx) =>
      fold(list, 'postprocessText', text, { direction: 'incoming', ...ctx }),
    preprocessOutgoing: (text, ctx) =>
      fold(list, 'preprocessOutgoing', text, { direction: 'outgoing', ...ctx }),
  };
}

// -- sample plugins ---------------------------------------------------------

/** Masks a configurable word list on both incoming and outgoing text. */
export function censorPlugin(words: string[]): MaraPlugin {
  // Escape regex metacharacters in each word (the words are user/config data,
  // not patterns) and match whole words case-insensitively.
  const patterns = words.map(
    (w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'),
  );
  // Replace with same-length runs of '*' so message length is preserved.
  const mask = (text: string) =>
    patterns.reduce((acc, re) => acc.replace(re, (m) => '*'.repeat(m.length)), text);
  return {
    name: 'censor',
    version: '1.0.0',
    preprocessOutgoing: mask,
    postprocessText: mask,
  };
}
