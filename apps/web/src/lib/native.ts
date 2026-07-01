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
