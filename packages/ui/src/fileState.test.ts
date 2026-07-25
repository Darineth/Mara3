import { get } from 'svelte/store';
import { describe, expect, it, vi } from 'vitest';
import { goneFiles, markFileGone, markFileSaving, savingFiles } from './fileState.js';

describe('goneFiles', () => {
  it('records a url and hands out a NEW set each time, so subscribers re-run', () => {
    const before = get(goneFiles);
    markFileGone('files/aaa/1/x.txt');
    const after = get(goneFiles);
    expect(after.has('files/aaa/1/x.txt')).toBe(true);
    // A mutated-in-place Set would leave ChatView's reconcile effect asleep, and the card
    // would keep claiming the file is there until something else forced a render.
    expect(after).not.toBe(before);
  });

  it('is idempotent — marking the same url twice changes nothing', () => {
    markFileGone('files/bbb/1/y.txt');
    const once = get(goneFiles);
    markFileGone('files/bbb/1/y.txt');
    expect(get(goneFiles)).toBe(once); // same set: no needless re-render
  });
});

describe('savingFiles', () => {
  it('acknowledges a download and clears itself again', () => {
    vi.useFakeTimers();
    try {
      markFileSaving('files/ccc/1/z.zip');
      expect(get(savingFiles).has('files/ccc/1/z.zip')).toBe(true);
      vi.advanceTimersByTime(3999);
      expect(get(savingFiles).has('files/ccc/1/z.zip')).toBe(true); // still showing
      vi.advanceTimersByTime(1);
      expect(get(savingFiles).has('files/ccc/1/z.zip')).toBe(false); // and gone
    } finally {
      vi.useRealTimers();
    }
  });

  it('restarts the window on a second click instead of expiring early', () => {
    vi.useFakeTimers();
    try {
      markFileSaving('files/ddd/1/again.bin');
      vi.advanceTimersByTime(3000);
      markFileSaving('files/ddd/1/again.bin'); // clicked again
      vi.advanceTimersByTime(3000); // past the FIRST timer's deadline
      expect(get(savingFiles).has('files/ddd/1/again.bin')).toBe(true);
      vi.advanceTimersByTime(1000);
      expect(get(savingFiles).has('files/ddd/1/again.bin')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
