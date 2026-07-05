import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cmpVersion,
  corsSafeManifestUrl,
  desktopVersion,
  getUpdateStatus,
  resetUpdateStatus,
  updateConfig,
  updateStatusText,
} from './update.js';

type G = {
  __MARA_UPDATE__?: { current: string; manifestUrl: string };
  fetch?: typeof fetch;
};

afterEach(() => {
  delete (globalThis as G).__MARA_UPDATE__;
  resetUpdateStatus(); // getUpdateStatus is memoized — clear between cases
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

describe('desktopVersion', () => {
  it('is null in a plain browser, the shell version in the client', () => {
    expect(desktopVersion()).toBeNull();
    (globalThis as G).__MARA_UPDATE__ = { current: '3.0.1', manifestUrl: '' };
    expect(desktopVersion()).toBe('3.0.1');
  });
});

describe('corsSafeManifestUrl', () => {
  it('rewrites a GitHub release-asset URL (no CORS) to CORS-enabled raw content', () => {
    expect(
      corsSafeManifestUrl(
        'https://github.com/Darineth/Mara3/releases/latest/download/latest-windows-x64.json',
      ),
    ).toBe('https://raw.githubusercontent.com/Darineth/Mara3/main/updates/latest-windows-x64.json');
    // Other platforms follow the same mapping.
    expect(
      corsSafeManifestUrl(
        'https://github.com/Darineth/Mara3/releases/latest/download/latest-linux-x64.json',
      ),
    ).toBe('https://raw.githubusercontent.com/Darineth/Mara3/main/updates/latest-linux-x64.json');
    expect(
      corsSafeManifestUrl(
        'https://github.com/Darineth/Mara3/releases/latest/download/latest-windows7-x64.json',
      ),
    ).toBe(
      'https://raw.githubusercontent.com/Darineth/Mara3/main/updates/latest-windows7-x64.json',
    );
  });

  it('leaves a non-GitHub / already-CORS-safe URL unchanged', () => {
    for (const url of [
      'https://raw.githubusercontent.com/Darineth/Mara3/main/updates/latest-windows-x64.json',
      'https://my-host.example/latest.json',
      'https://github.com/Darineth/Mara3/releases/download/v3.0.0/latest-windows-x64.json', // versioned, not /latest/
    ]) {
      expect(corsSafeManifestUrl(url)).toBe(url);
    }
  });
});

describe('getUpdateStatus', () => {
  it('fetches the rewritten (CORS-safe) URL for a baked GitHub release-asset manifest', async () => {
    (globalThis as G).__MARA_UPDATE__ = {
      current: '3.0.0',
      manifestUrl:
        'https://github.com/Darineth/Mara3/releases/latest/download/latest-windows-x64.json',
    };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ version: '3.0.1', url: 'https://h/x.zip' })),
      );
    await getUpdateStatus();
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://raw.githubusercontent.com/Darineth/Mara3/main/updates/latest-windows-x64.json',
      expect.anything(),
    );
  });

  it('is "disabled" outside the shell / with no manifest URL', async () => {
    await expect(getUpdateStatus()).resolves.toEqual({ state: 'disabled' });
    resetUpdateStatus();
    (globalThis as G).__MARA_UPDATE__ = { current: '3.0.1', manifestUrl: '' };
    await expect(getUpdateStatus()).resolves.toEqual({ state: 'disabled' });
  });

  it('is "available" with the newer build when one exists', async () => {
    (globalThis as G).__MARA_UPDATE__ = { current: '3.0.0', manifestUrl: 'https://h/latest.json' };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ version: '3.0.1', url: 'https://h/x.zip', notes: 'fixes' })),
    );
    await expect(getUpdateStatus()).resolves.toEqual({
      state: 'available',
      current: '3.0.0',
      update: { version: '3.0.1', url: 'https://h/x.zip', notes: 'fixes' },
    });
  });

  it('is "uptodate" when the manifest is not newer', async () => {
    (globalThis as G).__MARA_UPDATE__ = { current: '3.0.1', manifestUrl: 'https://h/latest.json' };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ version: '3.0.1', url: 'https://h/x.zip' })),
    );
    await expect(getUpdateStatus()).resolves.toEqual({ state: 'uptodate', current: '3.0.1' });
  });

  it('drops a non-http download URL but still reports available', async () => {
    (globalThis as G).__MARA_UPDATE__ = { current: '3.0.0', manifestUrl: 'https://h/latest.json' };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ version: '3.0.1', url: 'javascript:alert(1)' })),
    );
    await expect(getUpdateStatus()).resolves.toEqual({
      state: 'available',
      current: '3.0.0',
      update: { version: '3.0.1', url: '', notes: '' },
    });
  });

  it('is "error" on fetch/parse failure', async () => {
    (globalThis as G).__MARA_UPDATE__ = { current: '3.0.0', manifestUrl: 'https://h/latest.json' };
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    await expect(getUpdateStatus()).resolves.toEqual({ state: 'error', current: '3.0.0' });
  });

  it('memoizes — one fetch shared across calls until reset', async () => {
    (globalThis as G).__MARA_UPDATE__ = { current: '3.0.0', manifestUrl: 'https://h/latest.json' };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ version: '3.0.0' })));
    await getUpdateStatus();
    await getUpdateStatus();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('updateStatusText', () => {
  it('formats each state', () => {
    expect(updateStatusText({ state: 'disabled' })).toBe('Update check off');
    expect(updateStatusText({ state: 'error', current: '3.0.0' })).toBe('Update check failed');
    expect(updateStatusText({ state: 'uptodate', current: '3.0.1' })).toBe('Up to date');
    expect(
      updateStatusText({
        state: 'available',
        current: '3.0.0',
        update: { version: '3.0.2', url: '', notes: '' },
      }),
    ).toBe('Update available: v3.0.2');
  });
});
