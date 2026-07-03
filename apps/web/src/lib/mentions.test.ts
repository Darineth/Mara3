import { describe, expect, it } from 'vitest';
import { mentionsUser } from './mentions.js';

describe('mentionsUser', () => {
  it('matches a plain @name, case-insensitively, anywhere in the line', () => {
    expect(mentionsUser('hey @Bob, you around?', 'Bob')).toBe(true);
    expect(mentionsUser('hey @bob!', 'Bob')).toBe(true);
    expect(mentionsUser('@BOB', 'bob')).toBe(true);
    expect(mentionsUser('nothing here', 'Bob')).toBe(false);
  });

  it('requires the name to stand alone (no longer-word or glued matches)', () => {
    expect(mentionsUser('ping @Rosalind', 'Rosa')).toBe(false);
    expect(mentionsUser('ping @Rosa-lind', 'Rosa')).toBe(false);
    expect(mentionsUser('ping @Rosa.', 'Rosa')).toBe(true); // punctuation ends it
    expect(mentionsUser('mail me at bob@Bob', 'Bob')).toBe(false); // glued @
  });

  it('handles names with spaces and regex specials, matched literally', () => {
    expect(mentionsUser('cc @Bob Smith please', 'Bob Smith')).toBe(true);
    expect(mentionsUser('cc @Bob please', 'Bob Smith')).toBe(false);
    expect(mentionsUser('hi @what? yes', 'what?')).toBe(true);
    expect(mentionsUser('hi @whatX yes', 'what?')).toBe(false); // ? not a wildcard
  });

  it('never matches an empty or blank name', () => {
    expect(mentionsUser('@ hello', '')).toBe(false);
    expect(mentionsUser('@  hello', '   ')).toBe(false);
  });
});
