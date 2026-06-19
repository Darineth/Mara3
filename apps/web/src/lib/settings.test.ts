import { describe, expect, it } from 'vitest';
import { defaultSettings, loadSettings, MACRO_COUNT } from './settings.js';

describe('settings macros', () => {
  it('defaults to exactly MACRO_COUNT empty macro slots', () => {
    expect(defaultSettings.macros).toHaveLength(MACRO_COUNT);
    expect(defaultSettings.macros.every((m) => m === '')).toBe(true);
  });

  it('always returns MACRO_COUNT slots (no localStorage in this env)', () => {
    const settings = loadSettings();
    expect(settings.macros).toHaveLength(MACRO_COUNT);
  });
});
