import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultSettings,
  isValidIdentityKey,
  loadSettings,
  MACRO_COUNT,
  serverUrl,
} from './settings.js';

describe('settings macros', () => {
  it('defaults to MACRO_COUNT slots with F1 pre-filled and the rest empty', () => {
    expect(defaultSettings.macros).toHaveLength(MACRO_COUNT);
    expect(defaultSettings.macros[0]).toBe('Mara 3: Who even presses F1 anymore?  Seriously.');
    expect(defaultSettings.macros.slice(1).every((m) => m === '')).toBe(true);
  });

  it('always returns MACRO_COUNT slots (no localStorage in this env)', () => {
    const settings = loadSettings();
    expect(settings.macros).toHaveLength(MACRO_COUNT);
  });
});

describe('isValidIdentityKey', () => {
  it('accepts a trimmed 1–128 char string', () => {
    expect(isValidIdentityKey('a')).toBe(true);
    expect(isValidIdentityKey('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
    expect(isValidIdentityKey('x'.repeat(128))).toBe(true);
    expect(isValidIdentityKey('  padded-key  ')).toBe(true); // trimmed before measuring
  });

  it('rejects empty/whitespace-only or over-long input', () => {
    expect(isValidIdentityKey('')).toBe(false);
    expect(isValidIdentityKey('   ')).toBe(false);
    expect(isValidIdentityKey('x'.repeat(129))).toBe(false);
  });
});

describe('serverUrl', () => {
  const g = globalThis as unknown as { document?: unknown; window?: unknown };
  const prev = { document: g.document, window: g.window };
  // Pretend the page is served at a given base + protocol.
  function servedAt(baseURI: string, protocol: string) {
    g.document = { baseURI };
    g.window = { location: { protocol, host: new URL(baseURI).host } };
  }
  afterEach(() => {
    g.document = prev.document;
    g.window = prev.window;
  });

  it('uses wss and preserves a subpath when served under one', () => {
    servedAt('https://example.com/mara/', 'https:');
    expect(serverUrl()).toBe('wss://example.com/mara/ws');
  });

  it('works at the domain root', () => {
    servedAt('https://example.com/', 'https:');
    expect(serverUrl()).toBe('wss://example.com/ws');
  });

  it('drops a trailing index.html and keeps the subpath dir', () => {
    servedAt('https://example.com/mara/index.html', 'https:');
    expect(serverUrl()).toBe('wss://example.com/mara/ws');
  });

  it('uses ws (not wss) over plain http, preserving host:port', () => {
    servedAt('http://localhost:5050/', 'http:');
    expect(serverUrl()).toBe('ws://localhost:5050/ws');
  });

  it('falls back to localhost when there is no document (non-browser)', () => {
    g.document = undefined;
    g.window = undefined;
    expect(serverUrl()).toBe('ws://localhost:5050/ws');
  });
});
