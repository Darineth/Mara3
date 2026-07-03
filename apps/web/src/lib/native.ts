/**
 * Bridge to native shell capabilities (the Tauri desktop client). Everything
 * here is a safe no-op in a plain browser, so the same web build runs hosted on
 * the server and inside the thin desktop shell unchanged.
 */

interface TauriCore {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
}
interface TauriGlobal {
  /** Tauri 2 invoke surface (the modern shell, on a *local* page). */
  core?: TauriCore;
  /** Tauri 1 invoke surface (the Win7 legacy client). */
  tauri?: TauriCore;
  /** Tauri 1 also exposes invoke at the top level in some builds. */
  invoke?: TauriCore['invoke'];
  /** Tauri 1 shell API (present in the Win7 legacy client, not the modern shell). */
  shell?: { open(url: string): Promise<void> };
}

function tauri(): TauriGlobal | null {
  const g = globalThis as { __TAURI__?: TauriGlobal };
  return g.__TAURI__ ?? null;
}

/**
 * Tauri 2's low-level IPC. This is what `@tauri-apps/api`'s `invoke` calls under the
 * hood, and crucially it IS injected on **remote** pages that have been granted IPC —
 * whereas the `window.__TAURI__` convenience global is NOT injected there even with
 * `withGlobalTauri` (tauri#11934). The desktop clients load the hosted UI as a remote
 * page, so this is the surface that actually works there.
 */
function tauriInternals(): TauriCore | null {
  const g = globalThis as { __TAURI_INTERNALS__?: TauriCore };
  return g.__TAURI_INTERNALS__ ?? null;
}

/**
 * Invoke a native command across every shell/page shape: Tauri 2 local pages expose
 * `__TAURI__.core.invoke`; Tauri 2 remote pages expose only `__TAURI_INTERNALS__.invoke`;
 * Tauri 1 (the Win7 client) exposes `__TAURI__.tauri.invoke` (or a bare `.invoke`).
 * Called as a method so each surface's `invoke` keeps its own `this`.
 */
function rawInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const t = tauri();
  if (t?.core?.invoke) return t.core.invoke(cmd, args); // Tauri 2, local page
  if (t?.tauri?.invoke) return t.tauri.invoke(cmd, args); // Tauri 1
  if (t?.invoke) return t.invoke(cmd, args); // Tauri 1 (bare)
  const ti = tauriInternals();
  if (ti?.invoke) return ti.invoke(cmd, args); // Tauri 2, remote page
  return Promise.reject(new Error('no native invoke'));
}

/**
 * True when running inside a Tauri desktop shell. Checks both globals: the loaded
 * server page (remote) only has `__TAURI_INTERNALS__`, not `__TAURI__`.
 */
export function isDesktop(): boolean {
  return tauri() !== null || tauriInternals() !== null;
}

/**
 * Append a line to the desktop client's local log, filed under `channel` (its own
 * sub-folder, one file per month: `<logDir>/<channel>/Mara3_YYYY-MM.log`). No-op in a
 * plain browser.
 */
export async function nativeLog(channel: string, line: string): Promise<void> {
  if (!isDesktop()) return;
  try {
    await rawInvoke('mara_log', { channel, line });
  } catch {
    /* logging must never break the app */
  }
}

/**
 * Return the desktop client to its server picker (the "Switch server" action).
 * No-op outside the shell; throws are surfaced so the caller can report failure
 * (e.g. when the current server's origin isn't IPC-allowed).
 */
export async function switchServer(): Promise<void> {
  if (!isDesktop()) return;
  await rawInvoke('switch_server');
}

/**
 * Ask the desktop shell to flash its taskbar button (Windows) / bounce its dock icon
 * (macOS) / set the window urgency hint (Linux), to alert the user to a private message
 * that arrived while the window was in the background. No-op in a plain browser, and the
 * shell itself ignores it when the window is already focused. Best-effort: a missing
 * grant or unsupported shell must never break message handling.
 */
export async function requestAttention(): Promise<void> {
  if (!isDesktop()) return;
  try {
    await rawInvoke('request_attention');
  } catch {
    /* attention is a nicety — never let it disrupt the chat */
  }
}

/**
 * Ask the desktop shell to open (or refocus) a native pop-out window for a
 * conversation. The page passes only the view descriptor (`channel:<name>` /
 * `pm:<token>`); the shell builds the URL from its own saved server address, so
 * a page can never point a native window somewhere else. Returns false when the
 * shell refused or predates pop-outs (an older client) — callers then fall back
 * to tab behaviour, exactly like a blocked browser popup.
 */
export async function openNativePopout(view: string): Promise<boolean> {
  if (!isDesktop()) return false;
  try {
    await rawInvoke('open_popout', { view });
    return true;
  } catch {
    return false;
  }
}

/** Close this pop-out's native window (JS `window.close()` is a no-op in a webview).
 *  The shell only honours it for pop-out windows. No-op in a plain browser. */
export async function closeNativePopout(): Promise<void> {
  if (!isDesktop()) return;
  try {
    await rawInvoke('close_self');
  } catch {
    /* an older shell just leaves the window open */
  }
}

/** Raise this pop-out's native window (the pm-focus nudge). Best-effort. */
export async function focusNativePopout(): Promise<void> {
  if (!isDesktop()) return;
  try {
    await rawInvoke('focus_self');
  } catch {
    /* best-effort */
  }
}

/**
 * Open a URL in the system browser via the shell's opener plugin (so it doesn't
 * navigate this window away from the chat). Falls back to a new tab in a plain
 * browser. Used for the desktop update-download link.
 */
export async function openExternal(url: string): Promise<void> {
  if (!isDesktop()) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  try {
    // Win7 legacy (Tauri 1): shell.open. Modern shell (Tauri 2, remote page): the native
    // `open_external` command, which validates the scheme in Rust (http/https only) — the
    // opener plugin itself is not granted to the server's origin.
    const shell = tauri()?.shell;
    if (shell?.open) {
      await shell.open(url);
      return;
    }
    await rawInvoke('open_external', { url });
  } catch {
    window.open(url, '_blank', 'noopener');
  }
}
