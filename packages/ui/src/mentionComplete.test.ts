import { describe, expect, it } from 'vitest';
import { matchMention } from './mentionComplete.js';

const NAMES = ['alice', 'Bob Smith', 'bobby', 'Zoe'];

describe('matchMention', () => {
  it('triggers on @ at the line start or after whitespace', () => {
    expect(matchMention('@bo', NAMES)?.items).toEqual(['Bob Smith', 'bobby']);
    expect(matchMention('hey @bo', NAMES)?.items).toEqual(['Bob Smith', 'bobby']);
    expect(matchMention('hey @bo', NAMES)?.start).toBe(4);
  });

  it('never triggers on an email-style @ (glued to a word)', () => {
    expect(matchMention('mail bob@bo', NAMES)).toBeNull();
    expect(matchMention('a@', NAMES)).toBeNull();
  });

  it('offers the whole roster on a bare @, alphabetically', () => {
    expect(matchMention('@', NAMES)?.items).toEqual(['alice', 'Bob Smith', 'bobby', 'Zoe']);
  });

  it('matches across spaces for multi-word names, and closes when nothing matches', () => {
    expect(matchMention('@Bob S', NAMES)?.items).toEqual(['Bob Smith']);
    expect(matchMention('@Bob said hi', NAMES)).toBeNull();
  });

  it('ranks prefix matches first, then contains, case-insensitively', () => {
    const names = ['abc', 'xbc', 'BCd'];
    expect(matchMention('@bc', names)?.items).toEqual(['BCd', 'abc', 'xbc']);
  });

  it('a second @ retriggers a fresh token', () => {
    expect(matchMention('@alice hi @zo', NAMES)?.items).toEqual(['Zoe']);
    expect(matchMention('@alice hi @zo', NAMES)?.start).toBe(10);
  });

  it('caps results at the limit', () => {
    const many = Array.from({ length: 60 }, (_, i) => `user${String(i).padStart(2, '0')}`);
    expect(matchMention('@user', many, 50)?.items).toHaveLength(50);
  });
});
