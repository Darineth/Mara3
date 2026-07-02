import { describe, expect, it } from 'vitest';
import { matchEmojiShortcode, type EmojiPair } from './emojiComplete.js';

const emoji: EmojiPair[] = [
  ['smile', '/emoji/smile.png'],
  ['smirk', '/emoji/smirk.png'],
  ['awesome', '/emoji/awesome.png'],
  ['sad', '/emoji/sad.png'],
];

const names = (m: ReturnType<typeof matchEmojiShortcode>) => m?.items.map(([n]) => n);

describe('matchEmojiShortcode', () => {
  it('matches an in-progress shortcode and reports the : position', () => {
    const m = matchEmojiShortcode('hi :sm', emoji);
    expect(names(m)).toEqual(['smile', 'smirk']);
    expect(m?.start).toBe(3); // index of the ':'
  });

  it('ranks prefix matches above mere substring matches, then alphabetically', () => {
    // Query "a": "awesome" (prefix) outranks "sad" (contains an "a").
    expect(names(matchEmojiShortcode(':a', emoji))).toEqual(['awesome', 'sad']);
  });

  it('does not open on a bare colon — needs at least one character', () => {
    expect(matchEmojiShortcode('say :', emoji)).toBeNull();
    // ...but opens as soon as a name character is typed.
    expect(names(matchEmojiShortcode('say :sm', emoji))).toEqual(['smile', 'smirk']);
  });

  it('does not trigger inside a clock or a namespaced word', () => {
    expect(matchEmojiShortcode('at 12:30', emoji)).toBeNull();
    expect(matchEmojiShortcode('note:foo', emoji)).toBeNull();
  });

  it('does not trigger on a completed :shortcode:', () => {
    expect(matchEmojiShortcode('here :smile:', emoji)).toBeNull();
  });

  it('triggers a second shortcode typed flush against a completed one', () => {
    const m = matchEmojiShortcode(':sad::sm', emoji);
    expect(names(m)).toEqual(['smile', 'smirk']);
    expect(m?.start).toBe(5); // the second ':' opens the new token
  });

  it('returns null when nothing matches the query', () => {
    expect(matchEmojiShortcode(':zzz', emoji)).toBeNull();
  });

  it('triggers at the very start of the line', () => {
    expect(names(matchEmojiShortcode(':sad', emoji))).toEqual(['sad']);
  });

  it('respects the result limit', () => {
    const many: EmojiPair[] = Array.from({ length: 10 }, (_, i) => [`sm${i}`, `/emoji/sm${i}.png`]);
    expect(matchEmojiShortcode(':sm', many, 3)?.items).toHaveLength(3);
  });
});
