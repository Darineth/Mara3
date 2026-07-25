import { afterEach, describe, expect, it, vi } from 'vitest';
import { isDesktop, nativeLog, openExternalNative, requestAttention } from './native.js';

type Invoke = ReturnType<typeof vi.fn>;
type G = {
  __TAURI__?: {
    core?: { invoke: Invoke };
    tauri?: { invoke: Invoke };
    shell?: { open: Invoke };
  };
  __TAURI_INTERNALS__?: { invoke: Invoke };
};

afterEach(() => {
  delete (globalThis as G).__TAURI__;
  delete (globalThis as G).__TAURI_INTERNALS__;
});

describe('native bridge', () => {
  it('reports not-desktop and no-ops in a plain browser', async () => {
    expect(isDesktop()).toBe(false);
    await expect(nativeLog('system', 'hi')).resolves.toBeUndefined();
  });

  // Shared files are downloaded by handing the URL to the system browser. The caller has
  // to be able to tell a real hand-off from a failed one, because the fallback differs —
  // and must never be window.open, which in a shell opens an internal window (a blank one
  // for an attachment). A no-IPC page is the Win7-on-a-bare-IP case (tauri#7009).
  it('reports whether a native open actually happened', async () => {
    expect(await openExternalNative('https://example.com')).toBe(false); // plain browser

    const open = vi.fn().mockResolvedValue(undefined);
    (globalThis as G).__TAURI__ = { shell: { open } }; // Tauri 1 with IPC (hostname server)
    expect(await openExternalNative('https://example.com')).toBe(true);
    expect(open).toHaveBeenCalledWith('https://example.com');
    delete (globalThis as G).__TAURI__;

    // Tauri 2 remote page: the scheme-checked command.
    const invoke = vi.fn().mockResolvedValue(undefined);
    (globalThis as G).__TAURI_INTERNALS__ = { invoke };
    expect(await openExternalNative('https://example.com')).toBe(true);
    expect(invoke).toHaveBeenCalledWith('open_external', { url: 'https://example.com' });

    // The command rejecting (no such command, or IPC denied) is a failure, not a silent
    // success — the caller downloads in place instead.
    invoke.mockRejectedValue(new Error('not allowed'));
    expect(await openExternalNative('https://example.com')).toBe(false);
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

  it('uses the Tauri 1 invoke surface (Win7 legacy client)', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    // Tauri 1 exposes invoke at __TAURI__.tauri.invoke, not __TAURI__.core.
    (globalThis as G).__TAURI__ = { tauri: { invoke } };

    expect(isDesktop()).toBe(true);
    await nativeLog('general', 'hi from win7');
    expect(invoke).toHaveBeenCalledWith('mara_log', {
      channel: 'general',
      line: 'hi from win7',
    });
  });

  it('uses __TAURI_INTERNALS__ on a remote page (no __TAURI__ global)', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    // The loaded server page (remote) only gets __TAURI_INTERNALS__, not __TAURI__
    // (tauri#11934). nativeLog must still reach the command there.
    (globalThis as G).__TAURI_INTERNALS__ = { invoke };

    expect(isDesktop()).toBe(true);
    await nativeLog('general', 'hi from remote');
    expect(invoke).toHaveBeenCalledWith('mara_log', {
      channel: 'general',
      line: 'hi from remote',
    });
  });

  it('swallows native errors', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('boom'));
    (globalThis as G).__TAURI__ = { core: { invoke } };
    await expect(nativeLog('system', 'x')).resolves.toBeUndefined();
  });

  it('forwards a request-attention call to the native command', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    (globalThis as G).__TAURI__ = { core: { invoke } };
    await requestAttention();
    expect(invoke).toHaveBeenCalledWith('request_attention', undefined);
  });

  it('no-ops request-attention in a plain browser', async () => {
    const invoke = vi.fn();
    await expect(requestAttention()).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });
});
