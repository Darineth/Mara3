import { describe, expect, it } from 'vitest';
import type { ConnectionState } from '@mara/client-core';
import { connectionNotice, type NoticeState } from './connectionNotice.js';

function run(sequence: ConnectionState[]): (string | null)[] {
  const state: NoticeState = { dropAnnounced: false };
  return sequence.map((s) => connectionNotice(s, state));
}

describe('connectionNotice', () => {
  it('stays silent during the initial connect', () => {
    expect(run(['connecting', 'authenticating', 'active'])).toEqual([null, null, null]);
  });

  it('announces a drop once, then a recovery', () => {
    const out = run(['active', 'reconnecting', 'authenticating', 'active']);
    expect(out).toEqual([null, 'Connection lost — reconnecting…', null, 'Reconnected.']);
  });

  it('does not repeat the drop notice across retry attempts', () => {
    const out = run(['reconnecting', 'reconnecting', 'reconnecting']);
    expect(out).toEqual(['Connection lost — reconnecting…', null, null]);
  });

  it('handles a second drop/recover cycle', () => {
    const out = run(['reconnecting', 'active', 'reconnecting', 'active']);
    expect(out).toEqual([
      'Connection lost — reconnecting…',
      'Reconnected.',
      'Connection lost — reconnecting…',
      'Reconnected.',
    ]);
  });
});
