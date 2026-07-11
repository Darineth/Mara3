import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChannelHistoryEntry } from '@mara/protocol';
import { HistoryStore } from './history.js';
import { createLogger } from './logger.js';

const log = createLogger('silent');

function entry(id: number, text = `m${id}`): ChannelHistoryEntry {
  return { id, from: 7, name: 'alice', color: '#aabbcc', kind: 'chat', text, at: 1000 + id };
}

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'mara-hist-')), 'history.json');
}

describe('HistoryStore persistence', () => {
  it('round-trips through flush and reload, with no temp file left behind', () => {
    const file = tempFile();
    const a = new HistoryStore(file, log);
    a.append('Main', entry(1), 100);
    a.append('Main', entry(2), 100);
    a.append('Dev', entry(3), 100);
    a.flush();
    expect(existsSync(`${file}.tmp`)).toBe(false);
    const b = new HistoryStore(file, log);
    expect(b.get('Main').map((e) => e.id)).toEqual([1, 2]);
    expect(b.get('Dev').map((e) => e.id)).toEqual([3]);
    expect(b.maxId()).toBe(3);
  });

  it('drops only the invalid entries on load, keeping everything else', () => {
    const file = tempFile();
    writeFileSync(
      file,
      JSON.stringify({
        Main: [entry(1), { id: 2, garbage: true }, entry(3)],
        Dev: [entry(4)],
      }),
    );
    const store = new HistoryStore(file, log);
    // The bad entry is gone; its neighbours and the other channel survive.
    expect(store.get('Main').map((e) => e.id)).toEqual([1, 3]);
    expect(store.get('Dev').map((e) => e.id)).toEqual([4]);
  });

  it('moves an unparseable file aside instead of letting the next save erase it', () => {
    const file = tempFile();
    writeFileSync(file, '{"Main": [truncated by a crash');
    const store = new HistoryStore(file, log);
    expect(store.get('Main')).toEqual([]); // starts empty...
    expect(existsSync(`${file}.corrupt`)).toBe(true); // ...but the evidence is preserved
    expect(readFileSync(`${file}.corrupt`, 'utf8')).toContain('truncated by a crash');
    // A subsequent flush writes fresh data without touching the rescued file.
    store.append('Main', entry(1), 100);
    store.flush();
    expect(new HistoryStore(file, log).get('Main').map((e) => e.id)).toEqual([1]);
    expect(existsSync(`${file}.corrupt`)).toBe(true);
  });

  it('still backfills ids for pre-id entries, after per-entry validation', () => {
    const file = tempFile();
    const old = (text: string) => ({
      from: 7,
      name: 'alice',
      color: '#aabbcc',
      kind: 'chat',
      text,
      at: 1,
    });
    writeFileSync(file, JSON.stringify({ Main: [entry(5), old('a'), old('b')] }));
    const store = new HistoryStore(file, log);
    expect(store.get('Main').map((e) => e.id)).toEqual([5, 6, 7]);
    expect(store.maxId()).toBe(7);
  });

  it('caps the buffer on append, dropping the oldest', () => {
    const store = new HistoryStore('', log); // in-memory only
    for (let i = 1; i <= 5; i++) store.append('Main', entry(i), 3);
    expect(store.get('Main').map((e) => e.id)).toEqual([3, 4, 5]);
  });

  it('looks a message up by id only within its own channel', () => {
    const store = new HistoryStore('', log);
    store.append('Main', entry(1, 'in main'), 100);
    store.append('Dev', entry(2, 'in dev'), 100);
    expect(store.byId('Main', 1)?.text).toBe('in main');
    // The scoping is what stops a reply from quoting a message in a channel you aren't in.
    expect(store.byId('Main', 2)).toBeUndefined();
    expect(store.byId('Main', 99)).toBeUndefined(); // aged out / never existed
  });
});
