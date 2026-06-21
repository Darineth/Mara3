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
}

function tauri(): TauriGlobal | null {
  const g = globalThis as { __TAURI__?: TauriGlobal };
  return g.__TAURI__ ?? null;
}

/** True when running inside the Tauri desktop shell. */
export function isDesktop(): boolean {
  return tauri() !== null;
}

/** Append a line to the desktop client's local log file (no-op in a browser). */
export async function nativeLog(line: string): Promise<void> {
  const t = tauri();
  if (!t) return;
  try {
    await t.core.invoke('mara_log', { line });
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
