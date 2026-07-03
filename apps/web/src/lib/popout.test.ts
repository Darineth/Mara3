import { describe, expect, it } from 'vitest';
import { parseSoloView, soloViewUrl } from './popout.js';

describe('parseSoloView', () => {
  it('parses channel and pm views', () => {
    expect(parseSoloView('?view=channel:general')).toEqual({ kind: 'channel', name: 'general' });
    expect(parseSoloView('?view=pm:42')).toEqual({ kind: 'pm', peer: 42 });
  });

  it('handles channel names with spaces, colons, and unicode via URL encoding', () => {
    const url = soloViewUrl({ kind: 'channel', name: 'two words: ok é' }, 'https://host/mara/');
    expect(parseSoloView(new URL(url).search)).toEqual({
      kind: 'channel',
      name: 'two words: ok é',
    });
  });

  it('returns null for the normal app and for garbage', () => {
    expect(parseSoloView('')).toBeNull();
    expect(parseSoloView('?other=1')).toBeNull();
    expect(parseSoloView('?view=nonsense')).toBeNull();
    expect(parseSoloView('?view=channel:')).toBeNull();
    expect(parseSoloView('?view=pm:abc')).toBeNull();
    expect(parseSoloView('?view=pm:1.5')).toBeNull();
    expect(parseSoloView('?view=bogus:thing')).toBeNull();
  });
});

describe('soloViewUrl', () => {
  it('preserves host and subpath, replacing any existing view param', () => {
    const url = soloViewUrl(
      { kind: 'pm', peer: 7 },
      'https://host/mara/index.html?view=channel:old',
    );
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/mara/index.html');
    expect(parsed.searchParams.get('view')).toBe('pm:7');
  });
});
