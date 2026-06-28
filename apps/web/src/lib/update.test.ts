import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkDesktopUpdate, cmpVersion, updateConfig } from './update.js';

type G = {
  __MARA_UPDATE__?: { current: string; manifestUrl: string };
  fetch?: typeof fetch;
};

afterEach(() => {
  delete (globalThis as G).__MARA_UPDATE__;
  vi.restoreAllMocks();
});

describe('cmpVersion', () => {
  it('orders by numeric segments', () => {
    expect(cmpVersion('3.0.1', '3.0.0')).toBe(1);
    expect(cmpVersion('3.0.0', '3.0.1')).toBe(-1);
    expect(cmpVersion('3.0.0', '3.0.0')).toBe(0);
    expect(cmpVersion('3.1.0', '3.0.9')).toBe(1);
    expect(cmpVersion('10.0.0', '9.9.9')).toBe(1);
  });

  it('tolerates missing/extra segments and junk', () => {
    expect(cmpVersion('3.0', '3.0.0')).toBe(0);
    expect(cmpVersion('3.0.0.1', '3.0.0')).toBe(1);
    expect(cmpVersion('3.x.5', '3.0.5')).toBe(0); // junk segment -> 0
  });
});

describe('updateConfig', () => {
  it('is null in a plain browser', () => {
    expect(updateConfig()).toBeNull();
  });

  it('reads the shell-injected config', () => {
    (globalThis as G).__MARA_UPDATE__ = { current: '3.0.0', manifestUrl: 'https://h/latest.json' };
    expect(updateConfig()).toEqual({ current: '3.0.0', manifestUrl: 'https://h/latest.json' });
  });
});

describe('checkDesktopUpdate', () => {
  it('returns null outside the shell (no config)', async () => {
    await expect(checkDesktopUpdate()).resolves.toBeNull();
  });

  it('returns the newer build with a valid download URL', async () => {
    (globalThis as G).__MARA_UPDATE__ = { current: '3.0.0', manifestUrl: 'https://h/latest.json' };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ version: '3.0.1', url: 'https://h/x.zip', notes: 'fixes' })),
    );
    await expect(checkDesktopUpdate()).resolves.toEqual({
      version: '3.0.1',
      url: 'https://h/x.zip',
      notes: 'fixes',
    });
  });

  it('returns null when the manifest is not newer', async () => {
    (globalThis as G).__MARA_UPDATE__ = { current: '3.0.1', manifestUrl: 'https://h/latest.json' };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ version: '3.0.1', url: 'https://h/x.zip' })),
    );
    await expect(checkDesktopUpdate()).resolves.toBeNull();
  });

  it('drops a non-http download URL but still reports the version', async () => {
    (globalThis as G).__MARA_UPDATE__ = { current: '3.0.0', manifestUrl: 'https://h/latest.json' };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ version: '3.0.1', url: 'javascript:alert(1)' })),
    );
    await expect(checkDesktopUpdate()).resolves.toEqual({ version: '3.0.1', url: '', notes: '' });
  });

  it('swallows fetch/parse failures', async () => {
    (globalThis as G).__MARA_UPDATE__ = { current: '3.0.0', manifestUrl: 'https://h/latest.json' };
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    await expect(checkDesktopUpdate()).resolves.toBeNull();
  });
});
