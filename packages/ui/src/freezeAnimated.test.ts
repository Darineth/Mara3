import { describe, expect, it } from 'vitest';
import { candidateKind } from './freezeAnimated.js';

describe('candidateKind', () => {
  it('treats GIF as animated (skip the runtime check)', () => {
    expect(candidateKind('/emoji/abc.gif')).toBe('gif');
    expect(candidateKind('https://host/a.GIF?v=1')).toBe('gif');
  });

  it('flags webp/png/avif for a runtime animation check', () => {
    expect(candidateKind('/emoji/abc.webp')).toBe('check');
    expect(candidateKind('/uploads/abc.png')).toBe('check');
    expect(candidateKind('https://host/x.avif#frag')).toBe('check');
  });

  it('skips formats that are always static', () => {
    for (const src of ['/uploads/a.jpg', '/uploads/a.jpeg', '/x.bmp', '/x.svg', '/no-extension']) {
      expect(candidateKind(src)).toBe('no');
    }
  });
});
