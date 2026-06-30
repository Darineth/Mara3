/**
 * Bridge to native shell capabilities (the Tauri desktop client). Everything
 * here is a safe no-op in a plain browser, so the same web build runs hosted on
 * the server and inside the thin desktop shell unchanged.
 */

interface TauriCore {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
}
interface TauriGlobal {
  core: TauriCore;
  /** Tauri 1 shell API (present in the Win7 legacy client, not the modern shell). */
  shell?: { open(url: string): Promise<void> };
}

function tauri(): TauriGlobal | null {
  const g = globalThis as { __TAURI__?: TauriGlobal };
  return g.__TAURI__ ?? null;
}

/** True when running inside the Tauri desktop shell. */
export function isDesktop(): boolean {
  return tauri() !== null;
}

/**
 * Append a line to the desktop client's local log, filed under `channel` (its own
 * sub-folder, one file per month: `<logDir>/<channel>/Mara3_YYYY-MM.log`). No-op in a
 * plain browser.
 */
export async function nativeLog(channel: string, line: string): Promise<void> {
  const t = tauri();
  if (!t) return;
  try {
    await t.core.invoke('mara_log', { channel, line });
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
  const t = tauri();
  if (!t) return;
  await t.core.invoke('switch_server');
}

/**
 * Open a URL in the system browser via the shell's opener plugin (so it doesn't
 * navigate this window away from the chat). Falls back to a new tab in a plain
 * browser. Used for the desktop update-download link.
 */
export async function openExternal(url: string): Promise<void> {
  const t = tauri();
  if (!t) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  try {
    // Modern shell (Tauri 2): opener plugin. Win7 legacy (Tauri 1): shell.open.
    if (t.core?.invoke) {
      await t.core.invoke('plugin:opener|open_url', { url });
      return;
    }
    if (t.shell?.open) {
      await t.shell.open(url);
      return;
    }
    throw new Error('no native opener');
  } catch {
    window.open(url, '_blank', 'noopener');
  }
}
