import type { ConnectionState } from '@mara/client-core';
import { CLOSE_SERVICE_RESTART, type ServerInfo } from '@mara/protocol';

/**
 * The session-start line: server name and version, plus when the server started if it says
 * (older servers don't), in the viewer's own locale and time zone.
 */
export function connectedNotice(info: ServerInfo): string {
  const since =
    info.startedAt !== undefined
      ? `, running since ${new Date(info.startedAt).toLocaleString(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
        })}`
      : '';
  return `Connected to ${info.name} (v${info.version})${since}.`;
}

export interface NoticeState {
  dropAnnounced: boolean;
}

/**
 * Decide whether a connection status change should append a system line to the
 * chat. Returns the notice text (and mutates `state`) on a drop or recovery,
 * otherwise null. `closeCode` is why the socket closed: 1012 means the server is
 * shutting down on purpose, which reads differently from a lost connection. Keeping
 * it pure makes the drop/recover behavior testable without a live socket.
 */
export function connectionNotice(
  status: ConnectionState,
  state: NoticeState,
  closeCode: number | null = null,
): string | null {
  if (status === 'reconnecting' && !state.dropAnnounced) {
    state.dropAnnounced = true;
    return closeCode === CLOSE_SERVICE_RESTART
      ? 'Server is shutting down — reconnecting…'
      : 'Connection lost — reconnecting…';
  }
  if (status === 'active' && state.dropAnnounced) {
    state.dropAnnounced = false;
    return 'Reconnected.';
  }
  return null;
}
