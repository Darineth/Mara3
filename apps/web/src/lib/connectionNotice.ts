import type { ConnectionState } from '@mara/client-core';

export interface NoticeState {
  dropAnnounced: boolean;
}

/**
 * Decide whether a connection status change should append a system line to the
 * chat. Returns the notice text (and mutates `state`) on a drop or recovery,
 * otherwise null. Keeping it pure makes the drop/recover behavior testable
 * without a live socket.
 */
export function connectionNotice(status: ConnectionState, state: NoticeState): string | null {
  if (status === 'reconnecting' && !state.dropAnnounced) {
    state.dropAnnounced = true;
    return 'Connection lost — reconnecting…';
  }
  if (status === 'active' && state.dropAnnounced) {
    state.dropAnnounced = false;
    return 'Reconnected.';
  }
  return null;
}
