import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';
import { UserEmojiStore } from './userEmoji.js';

const log = createLogger('silent');
const HEX = 'a'.repeat(32);
const HEX2 = 'b'.repeat(32);

describe('UserEmojiStore', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mara-emoji-'));
    file = join(dir, 'user-emoji.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('sets, reads, and builds a wire manifest with owner + adder name', () => {
    const store = new UserEmojiStore(file, log);
    store.set('blobwave', { file: `${HEX}.png`, owner: 7, by: 'alice', at: 1000 });
    expect(store.count()).toBe(1);
    expect(store.get('blobwave')?.owner).toBe(7);
    expect(store.manifest()).toEqual([
      { name: 'blobwave', url: `/emoji/${HEX}.png`, owner: 7, by: 'alice' },
    ]);
  });

  it('delete returns the removed record (for file cleanup) and is idempotent', () => {
    const store = new UserEmojiStore(file, log);
    store.set('party', { file: `${HEX}.gif`, owner: 3, by: 'bob', at: 1 });
    const removed = store.delete('party');
    expect(removed?.file).toBe(`${HEX}.gif`);
    expect(store.count()).toBe(0);
    expect(store.delete('party')).toBeUndefined();
  });

  it('persists across instances via flush + load', () => {
    const a = new UserEmojiStore(file, log);
    a.set('cat', { file: `${HEX}.webp`, owner: 42, by: 'cara', at: 5 });
    a.flush();

    const b = new UserEmojiStore(file, log);
    expect(b.get('cat')).toEqual({ file: `${HEX}.webp`, owner: 42, by: 'cara', at: 5 });
  });

  it('skips malformed entries on load (bad name, non-hex file, missing owner)', () => {
    writeFileSync(
      file,
      JSON.stringify({
        good: { file: `${HEX}.png`, owner: 1, by: 'x', at: 0 },
        'bad name!': { file: `${HEX}.png`, owner: 1 },
        notHex: { file: 'evil.png', owner: 1 },
        noOwner: { file: `${HEX2}.png` },
      }),
    );
    const store = new UserEmojiStore(file, log);
    expect(store.count()).toBe(1);
    expect(store.get('good')?.owner).toBe(1);
    expect(store.get('notHex')).toBeUndefined();
  });

  it('reloadFromDisk picks up an operator edit and reports freed images', () => {
    const store = new UserEmojiStore(file, log);
    store.set('keep', { file: `${HEX}.png`, owner: 1, by: 'a', at: 0 });
    store.set('badword', { file: `${HEX2}.png`, owner: 2, by: 'b', at: 0 });
    store.flush();

    // Operator hand-edits the file, removing the offending entry.
    writeFileSync(file, JSON.stringify({ keep: { file: `${HEX}.png`, owner: 1, by: 'a', at: 0 } }));
    const removed = store.reloadFromDisk();

    expect(store.get('badword')).toBeUndefined();
    expect(store.get('keep')?.owner).toBe(1);
    expect(removed.map((r) => r.file)).toEqual([`${HEX2}.png`]); // the image to reclaim
  });

  it('reloadFromDisk treats a repointed shortcode as freeing the old image', () => {
    const store = new UserEmojiStore(file, log);
    store.set('cat', { file: `${HEX}.png`, owner: 1, by: 'a', at: 0 });
    store.flush();
    writeFileSync(file, JSON.stringify({ cat: { file: `${HEX2}.png`, owner: 1, by: 'a', at: 0 } }));
    const removed = store.reloadFromDisk();
    expect(store.get('cat')?.file).toBe(`${HEX2}.png`);
    expect(removed.map((r) => r.file)).toEqual([`${HEX}.png`]);
  });

  it('reloadFromDisk keeps the current set when the file is malformed JSON', () => {
    const store = new UserEmojiStore(file, log);
    store.set('safe', { file: `${HEX}.png`, owner: 1, by: 'a', at: 0 });
    store.flush();
    writeFileSync(file, '{ this is not json');
    const removed = store.reloadFromDisk();
    expect(store.get('safe')?.owner).toBe(1); // not wiped
    expect(removed).toEqual([]);
  });

  it('an empty file path stays in-memory only (no write)', () => {
    const store = new UserEmojiStore('', log);
    store.set('mem', { file: `${HEX}.png`, owner: 1, by: 'y', at: 0 });
    store.flush();
    // The store works, but nothing was written to `file` (it was never given one).
    expect(store.get('mem')?.owner).toBe(1);
    expect(() => readFileSync(file, 'utf8')).toThrow();
  });
});
