import { describe, expect, it } from 'vitest';
import type { ChatLine } from '@mara/client-core';
import {
  PM_HISTORY_MAX_CONVERSATIONS,
  PM_HISTORY_MAX_LINES,
  clearPmHistory,
  loadPmHistory,
  removePmConversation,
  savePmHistory,
  upsertPmConversation,
} from './pmHistory.js';

/** In-memory Storage stand-in. */
function fakeStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & {
  data: Map<string, string>;
} {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

function line(text: string, at = 1000, from: number | null = 7): ChatLine {
  return { id: 1, kind: 'chat', from, text, at };
}

const convo = (peer: number, lines: ChatLine[], name = `peer${peer}`) => ({
  peer,
  name,
  color: '#123456',
  lines,
});

describe('pmHistory', () => {
  it('round-trips conversations for the same identity, stripping line ids', () => {
    const s = fakeStorage();
    savePmHistory('key-a', [convo(7, [line('hello'), line('there', 2000)])], s);
    const loaded = loadPmHistory('key-a', s);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.peer).toBe(7);
    expect(loaded[0]!.name).toBe('peer7');
    expect(loaded[0]!.lines.map((l) => l.text)).toEqual(['hello', 'there']);
    expect(loaded[0]!.lines[0]).not.toHaveProperty('id');
  });

  it('loads nothing for a different identity key', () => {
    const s = fakeStorage();
    savePmHistory('key-a', [convo(7, [line('secret')])], s);
    expect(loadPmHistory('key-b', s)).toEqual([]);
  });

  it('survives missing storage, absent data, and corrupt JSON', () => {
    expect(loadPmHistory('key', null)).toEqual([]);
    const s = fakeStorage();
    expect(loadPmHistory('key', s)).toEqual([]);
    s.data.set('mara3.pmHistory', '{not json');
    expect(loadPmHistory('key', s)).toEqual([]);
    expect(() => savePmHistory('key', [], null)).not.toThrow();
  });

  it('drops malformed conversations and lines instead of trusting them', () => {
    const s = fakeStorage();
    s.data.set(
      'mara3.pmHistory',
      JSON.stringify({
        identityKey: 'key',
        conversations: [
          { peer: 7, name: 'ok', color: '#fff', lines: [line('good'), { bogus: true }, 42] },
          { nope: 1 },
        ],
      }),
    );
    const loaded = loadPmHistory('key', s);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.lines.map((l) => l.text)).toEqual(['good']);
  });

  it('caps lines per conversation, keeping the newest', () => {
    const s = fakeStorage();
    const many = Array.from({ length: PM_HISTORY_MAX_LINES + 25 }, (_, i) => line(`m${i}`, i));
    savePmHistory('key', [convo(7, many)], s);
    const loaded = loadPmHistory('key', s);
    expect(loaded[0]!.lines).toHaveLength(PM_HISTORY_MAX_LINES);
    expect(loaded[0]!.lines[0]!.text).toBe('m25');
    expect(loaded[0]!.lines.at(-1)!.text).toBe(`m${PM_HISTORY_MAX_LINES + 24}`);
  });

  it('drops the least-recently-active conversations over the cap, preserving order', () => {
    const s = fakeStorage();
    // Conversation i's last activity is at time i; conversation 0 is the stalest.
    const convos = Array.from({ length: PM_HISTORY_MAX_CONVERSATIONS + 2 }, (_, i) =>
      convo(i, [line('hi', i)]),
    );
    savePmHistory('key', convos, s);
    const loaded = loadPmHistory('key', s);
    expect(loaded).toHaveLength(PM_HISTORY_MAX_CONVERSATIONS);
    // The two stalest (peers 0 and 1) are gone; the rest keep their original order.
    expect(loaded.map((c) => c.peer)).toEqual(convos.slice(2).map((c) => c.peer));
  });

  it('upsertPmConversation merges one thread without touching the others', () => {
    const s = fakeStorage();
    savePmHistory('key', [convo(7, [line('a')]), convo(8, [line('b')])], s);
    // Replace an existing thread…
    upsertPmConversation('key', convo(8, [line('b'), line('b2', 2000)]), s);
    let loaded = loadPmHistory('key', s);
    expect(loaded.map((c) => c.peer)).toEqual([7, 8]);
    expect(loaded[1]!.lines.map((l) => l.text)).toEqual(['b', 'b2']);
    expect(loaded[0]!.lines.map((l) => l.text)).toEqual(['a']);
    // …and append a new one, ids stripped either way.
    upsertPmConversation('key', convo(9, [line('c')]), s);
    loaded = loadPmHistory('key', s);
    expect(loaded.map((c) => c.peer)).toEqual([7, 8, 9]);
    expect(loaded[2]!.lines[0]).not.toHaveProperty('id');
  });

  it('removePmConversation forgets one thread; clearPmHistory forgets all', () => {
    const s = fakeStorage();
    savePmHistory('key', [convo(7, [line('a')]), convo(8, [line('b')])], s);
    removePmConversation('key', 7, s);
    expect(loadPmHistory('key', s).map((c) => c.peer)).toEqual([8]);
    clearPmHistory(s);
    expect(loadPmHistory('key', s)).toEqual([]);
  });
});
