import { describe, expect, it } from 'vitest';
import type { ConnectionState } from '@mara/client-core';
import { connectedNotice, connectionNotice, type NoticeState } from './connectionNotice.js';

function run(sequence: ConnectionState[]): (string | null)[] {
  const state: NoticeState = { dropAnnounced: false };
  return sequence.map((s) => connectionNotice(s, state));
}

describe('connectedNotice', () => {
  const info = { name: 'Mara', version: '3.0.39', protocol: 5 };

  it('names the server and version', () => {
    expect(connectedNotice(info)).toBe('Connected to Mara (v3.0.39).');
  });

  it('adds when the server started, in local time, if the server sends it', () => {
    const startedAt = Date.UTC(2026, 8, 29, 18, 5);
    const local = new Date(startedAt).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    expect(connectedNotice({ ...info, startedAt })).toBe(
      `Connected to Mara (v3.0.39), running since ${local}.`,
    );
  });
});

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

  it('says the server is shutting down when it closed with 1012', () => {
    const state: NoticeState = { dropAnnounced: false };
    expect(connectionNotice('reconnecting', state, 1012)).toBe(
      'Server is shutting down — reconnecting…',
    );
    expect(connectionNotice('active', state, 1012)).toBe('Reconnected.');
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
