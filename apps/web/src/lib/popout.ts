/**
 * Pop-out windows: a conversation opened in its own browser window. The window
 * runs the full app pinned to a single conversation ("solo view"), selected by
 * a `?view=` query — `view=channel:<name>` or `view=pm:<peer token>`.
 *
 * Pop-outs follow the mirror model: the conversation stays in the main window
 * (tab, unread badge and all); the pop-out is an extra live view. Each window
 * is its own client connection — the server already converges a user's windows
 * (channel snapshots on join, PM mirroring), and PM history hydrates from the
 * device-local store (lib/pmHistory.ts), so nothing new crosses the wire.
 */
import type { Token } from '@mara/client-core';
import { isDesktop, openNativePopout } from './native.js';

export type SoloView = { kind: 'channel'; name: string } | { kind: 'pm'; peer: Token };

/** The wire form of a view: the `?view=` value and what the shell IPC takes. */
export function viewParam(view: SoloView): string {
  return view.kind === 'channel' ? `channel:${view.name}` : `pm:${view.peer}`;
}

/** Parse a window.location.search into a solo view, or null for the normal app.
 *  Garbage values are ignored rather than erroring — the URL is user-editable. */
export function parseSoloView(search: string): SoloView | null {
  const value = new URLSearchParams(search).get('view');
  if (!value) return null;
  const sep = value.indexOf(':');
  if (sep < 0) return null;
  const kind = value.slice(0, sep);
  const rest = value.slice(sep + 1);
  if (kind === 'channel' && rest) return { kind: 'channel', name: rest };
  if (kind === 'pm' && /^\d+$/.test(rest)) return { kind: 'pm', peer: Number(rest) as Token };
  return null;
}

/** The pop-out URL for a view, derived from the current page URL (preserves
 *  host/subpath; any existing `view` param is replaced). */
export function soloViewUrl(view: SoloView, base: string): string {
  const url = new URL(base);
  url.searchParams.set('view', viewParam(view));
  return url.toString();
}

/** Open (or refocus) the pop-out window for a view. The window target is derived
 *  from the view, so popping the same conversation out twice reuses one window.
 *  In the desktop shells this is a real native window created over IPC. Returns
 *  false when the open was refused (popup blocker, or a desktop shell too old to
 *  know pop-outs) — callers must not hand the conversation off to a window that
 *  doesn't exist. */
export async function openPopout(view: SoloView): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (isDesktop()) return openNativePopout(viewParam(view));
  const target =
    view.kind === 'channel' ? `mara-ch-${view.name.replace(/\W+/g, '_')}` : `mara-pm-${view.peer}`;
  const win = window.open(
    soloViewUrl(view, window.location.href),
    target,
    'popup=yes,width=560,height=680',
  );
  return win !== null;
}

// -- cross-window coordination ------------------------------------------------
//
// Popped-out PMs use "move" semantics: the pop-out owns the conversation and the
// main window hides its tab until the pop-out closes. Windows coordinate over a
// BroadcastChannel: a PM pop-out announces `pm-open` on start (and in answer to
// any `pm-query`), and `pm-closed` on the way out. Main windows hide/restore
// tabs on those messages, and use a query→timeout when a message arrives for a
// supposedly popped-out peer, so a pop-out that died silently (crash) forfeits
// the conversation back instead of it going nowhere.

export type PopoutBusMessage =
  | { type: 'pm-open'; peer: Token }
  | { type: 'pm-closed'; peer: Token }
  | { type: 'pm-query'; peer?: Token }
  /** Ask the owning pop-out to raise itself (best-effort — browsers may ignore
   *  programmatic focus, but we must never re-navigate the window instead). */
  | { type: 'pm-focus'; peer: Token };

export interface PopoutBus {
  post(message: PopoutBusMessage): void;
  close(): void;
}

/** Join the pop-out coordination channel; null where BroadcastChannel doesn't
 *  exist (then pop-outs simply stay mirrors — nothing breaks). */
export function popoutBus(onMessage: (m: PopoutBusMessage) => void): PopoutBus | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  const channel = new BroadcastChannel('mara3.popouts');
  channel.onmessage = (e) => onMessage(e.data as PopoutBusMessage);
  return {
    post: (message) => channel.postMessage(message),
    close: () => channel.close(),
  };
}
