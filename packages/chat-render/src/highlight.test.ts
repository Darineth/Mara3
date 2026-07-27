import { describe, expect, it } from 'vitest';
import { highlightComposer } from './highlight.js';

const EMOJI = { party: '/emoji/party.png' };
const NAMES = ['Rosa', 'Rosalind'];

/** The rendered text with the markup taken back off — what the user actually sees. */
function plain(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

describe('highlightComposer', () => {
  // The invariant the whole feature rests on: the highlight is painted behind a transparent
  // textarea, so a single added/dropped character would slide it out from under the caret.
  describe('never changes the text', () => {
    const drafts = [
      '',
      'plain text',
      '**bold** and *italic* and ***both***',
      '__underline__ _italic_ ~~struck~~ ||spoiler||',
      'snake_case_name and 3 * 4 * 5',
      '`code` and ``a`b`` and\n```js\nconst x = 1;\n```',
      '\\*not italic\\* and \\\\ and \\#',
      '# Heading\n## Two\n### Three\n-# subtext',
      '> quoted\n> more\n\n>>> rest of it\nstill quoted',
      '- one\n- two\n  wrapped\n* star\n1. first\n2. second',
      'https://example.com/a.png and !https://example.com/opaque',
      '/uploads/abc.png plus /files/0123456789abcdef0123456789abcdef.zip/2048/notes.zip',
      '![alt text](https://example.com/x.png) and [img]https://example.com/y.png[/img]',
      '[IMG]https://example.com/y.png[/IMG] and [img]not a url[/img]',
      '[B]bbcode[/B] [i]it[/i] [u]u[/u] [s]s[/s] [SPOILER]hidden[/SPOILER]',
      ':party: :unknown: 12:30:45',
      '@Rosa and @Rosalind and mail@Rosa and @nobody',
      'a & b < c > d "quoted" \'single\'',
      'trailing newline\n',
      '\n\n\n',
      '   leading spaces kept',
      'mixed **bold with `code` and :party: inside** tail',
      '||spoiler with https://example.com in it||',
    ];
    for (const draft of drafts) {
      it(JSON.stringify(draft), () => {
        expect(plain(highlightComposer(draft, { emoji: EMOJI, mentions: NAMES }))).toBe(draft);
      });
    }
  });

  it('emboldens the word and dims the asterisks', () => {
    const html = highlightComposer('say **hi** now');
    expect(html).toContain('<strong>hi</strong>');
    expect(html).toContain('<span class="mara-hl-mk">**</span>');
  });

  it('marks up italic, underline, strikethrough and spoilers', () => {
    expect(highlightComposer('*a*')).toContain('<em><span class="mara-hl-em">a</span></em>');
    expect(highlightComposer('__a__')).toContain('<u>a</u>');
    expect(highlightComposer('~~a~~')).toContain('<s>a</s>');
    expect(highlightComposer('||a||')).toContain('<span class="mara-hl-spoiler">a</span>');
    expect(highlightComposer('***a***')).toContain('<strong><em><span class="mara-hl-em">a</span>');
  });

  // Each word is slanted on its own so it stays an atomic box the width of the regular face;
  // the spaces stay plain text, which is what keeps the mirror wrapping like the textarea.
  it('slants emphasis one word at a time, leaving the spaces alone', () => {
    const html = highlightComposer('*two words*');
    expect(html).toContain('<span class="mara-hl-em">two</span> <span class="mara-hl-em">words');
  });

  it('leaves emphasis upright when it carries more than plain text', () => {
    // Word boundaries inside a nested span aren't ours to find, so no slant is applied.
    expect(highlightComposer('*a `b` c*')).toContain('<em>');
    expect(highlightComposer('*a `b` c*')).not.toContain('mara-hl-em');
  });

  it('leaves markdown characters inside a code span alone', () => {
    const html = highlightComposer('`**not bold**`');
    expect(html).not.toContain('<strong>');
    expect(html).toContain('mara-hl-code');
  });

  it('honours backslash escapes', () => {
    const html = highlightComposer('\\*plain\\*');
    expect(html).not.toContain('<em>');
    expect(html).toContain('<span class="mara-hl-mk">\\</span>');
  });

  it('lights up only emoji the server actually has', () => {
    const html = highlightComposer(':party: :missing:', { emoji: EMOJI });
    expect(html).toContain('<span class="mara-hl-emoji">:party:</span>');
    expect(html).not.toContain('>:missing:<');
  });

  it('lights up only known mentions, longest name first', () => {
    const html = highlightComposer('@Rosalind @nobody', { mentions: NAMES });
    expect(html).toContain('<span class="mara-hl-mention">@Rosalind</span>');
    expect(html).not.toContain('>@nobody<');
  });

  it('marks links, including the ! inline-image marker', () => {
    const html = highlightComposer('!https://example.com/x');
    expect(html).toContain('<span class="mara-hl-mk">!</span>');
    expect(html).toContain('<span class="mara-hl-link">https://example.com/x</span>');
  });

  it('classifies block lines and dims their markers', () => {
    expect(highlightComposer('## Title')).toContain('<span class="mara-hl-h2">');
    expect(highlightComposer('-# small')).toContain('<span class="mara-hl-subtext">');
    expect(highlightComposer('> quoted')).toContain('<span class="mara-hl-quote">');
    expect(highlightComposer('- item')).toContain('<span class="mara-hl-mk">- </span>');
    expect(highlightComposer('1. item')).toContain('<span class="mara-hl-mk">1. </span>');
  });

  it('quotes every remaining line after >>>', () => {
    const html = highlightComposer('>>> first\nsecond');
    expect(html.match(/mara-hl-quote/g)?.length).toBe(2);
  });

  it('keeps one line per line', () => {
    expect(highlightComposer('a\nb\nc').split('\n')).toHaveLength(3);
  });

  it('escapes HTML in the draft', () => {
    const html = highlightComposer('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});
