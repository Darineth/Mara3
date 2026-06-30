import { describe, expect, it } from 'vitest';
import { censorPlugin, createPipeline, type MaraPlugin } from './index.js';

describe('createPipeline', () => {
  it('chains plugins in order for each hook', () => {
    const calls: string[] = [];
    const a: MaraPlugin = {
      name: 'a',
      preprocessOutgoing: (t) => (calls.push('a'), `${t}-a`),
    };
    const b: MaraPlugin = {
      name: 'b',
      preprocessOutgoing: (t) => (calls.push('b'), `${t}-b`),
    };
    const pipeline = createPipeline([a, b]);
    expect(pipeline.preprocessOutgoing('x')).toBe('x-a-b');
    expect(calls).toEqual(['a', 'b']);
  });

  it('passes direction + context to hooks', () => {
    let seen: unknown;
    const probe: MaraPlugin = {
      name: 'probe',
      preprocessText: (t, ctx) => ((seen = ctx), t),
    };
    createPipeline([probe]).preprocessText('hi', { channelToken: 7 });
    expect(seen).toEqual({ direction: 'incoming', channelToken: 7 });
  });

  it('is a no-op when no plugin implements a hook', () => {
    const pipeline = createPipeline([{ name: 'noop' }]);
    expect(pipeline.preprocessOutgoing('hello')).toBe('hello');
  });
});

describe('sample plugins', () => {
  it('censor masks words on incoming and outgoing', () => {
    const pipeline = createPipeline([censorPlugin(['badword'])]);
    expect(pipeline.preprocessOutgoing('a BadWord here')).toBe('a ******* here');
    expect(pipeline.postprocessText('badword')).toBe('*******');
  });
});
