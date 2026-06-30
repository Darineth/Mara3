import { afterEach, describe, expect, it, vi } from 'vitest';
import { isDesktop, nativeLog } from './native.js';

type G = { __TAURI__?: { core: { invoke: ReturnType<typeof vi.fn> } } };

afterEach(() => {
  delete (globalThis as G).__TAURI__;
});

describe('native bridge', () => {
  it('reports not-desktop and no-ops in a plain browser', async () => {
    expect(isDesktop()).toBe(false);
    await expect(nativeLog('system', 'hi')).resolves.toBeUndefined();
  });

  it('detects the shell and forwards logs to the native command', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    (globalThis as G).__TAURI__ = { core: { invoke } };

    expect(isDesktop()).toBe(true);
    await nativeLog('general', 'hello from web');
    expect(invoke).toHaveBeenCalledWith('mara_log', {
      channel: 'general',
      line: 'hello from web',
    });
  });

  it('swallows native errors', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('boom'));
    (globalThis as G).__TAURI__ = { core: { invoke } };
    await expect(nativeLog('system', 'x')).resolves.toBeUndefined();
  });
});
