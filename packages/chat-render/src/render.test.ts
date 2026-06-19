import { describe, expect, it } from 'vitest';
import {
  applyEmoticons,
  DEFAULT_EMOTICONS,
  escapeHtml,
  linkify,
  renderLine,
  renderText,
} from './index.js';

describe('escapeHtml', () => {
  it('neutralizes markup', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
  });
});

describe('applyEmoticons', () => {
  it('replaces known codes, longest-match first', () => {
    expect(applyEmoticons('hi :) and <3')).toBe('hi 🙂 and ❤️');
  });
});

describe('linkify', () => {
  it('wraps urls in safe anchors', () => {
    const html = linkify('see https://example.com/x now');
    expect(html).toContain('<a href="https://example.com/x"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});

describe('renderText — safety + links', () => {
  it('escapes before linkifying and never emits user markup', () => {
    const html = renderText('<b>hi</b> http://example.com');
    expect(html).toContain('&lt;b&gt;hi&lt;/b&gt;');
    expect(html).toContain('<a href="http://example.com"');
  });

  it('does not apply emoticons by default', () => {
    expect(renderText('love <3')).toBe('love &lt;3');
  });

  it('applies emoticons only when opted in', () => {
    expect(renderText('love <3', { emoticons: DEFAULT_EMOTICONS })).toBe('love ❤️');
  });
});

describe('renderText — Discord markdown', () => {
  it('renders bold, italic, and bold-italic', () => {
    expect(renderText('**b**')).toBe('<strong>b</strong>');
    expect(renderText('*i*')).toBe('<em>i</em>');
    expect(renderText('_i_')).toBe('<em>i</em>');
    expect(renderText('***bi***')).toBe('<strong><em>bi</em></strong>');
  });

  it('renders underline, strikethrough, and spoilers', () => {
    expect(renderText('__u__')).toBe('<u>u</u>');
    expect(renderText('~~s~~')).toBe('<s>s</s>');
    expect(renderText('||top secret||')).toBe('<span class="mara-spoiler">top secret</span>');
  });

  it('renders inline code and code blocks without formatting inside', () => {
    expect(renderText('`a*b*c`')).toBe('<code class="mara-code">a*b*c</code>');
    expect(renderText('```let x = *y*```')).toBe('<code class="mara-codeblock">let x = *y*</code>');
  });

  it('escapes markup inside formatting', () => {
    expect(renderText('**<img>**')).toBe('<strong>&lt;img&gt;</strong>');
  });

  it('leaves snake_case and underscored URLs alone', () => {
    expect(renderText('snake_case_thing')).toBe('snake_case_thing');
    const html = renderText('http://example.com/a_b_c');
    expect(html).toContain('href="http://example.com/a_b_c"');
    expect(html).not.toContain('<em>');
  });

  it('ignores space-padded asterisks (like multiplication)', () => {
    expect(renderText('2 * 3 * 4')).toBe('2 * 3 * 4');
  });

  it('formats text wrapping a link', () => {
    const html = renderText('**see http://x.com now**');
    expect(html).toContain('<strong>see ');
    expect(html).toContain('<a href="http://x.com"');
    expect(html).toContain('now</strong>');
  });
});

describe('renderLine', () => {
  it('renders a chat line with author color and escaped text', () => {
    const html = renderLine(
      {
        kind: 'chat',
        authorName: 'al<i>ce',
        authorColor: '#ff0000',
        text: 'hi',
        timestamp: '12:00',
      },
      { showTimestamps: true },
    );
    expect(html).toContain('mara-chat');
    expect(html).toContain('color:#ff0000');
    expect(html).toContain('al&lt;i&gt;ce:');
    expect(html).toContain('<span class="mara-ts">12:00</span>');
  });

  it('applies markdown to the message body', () => {
    const html = renderLine({
      kind: 'chat',
      authorName: 'bob',
      authorColor: '#00ff00',
      text: 'say **hi**',
    });
    expect(html).toContain('say <strong>hi</strong>');
  });

  it('falls back to a safe color when authorColor is invalid', () => {
    const html = renderLine({ kind: 'chat', authorName: 'x', authorColor: 'red', text: 'hi' });
    expect(html).toContain('color:#888888');
  });

  it('renders emote and system lines', () => {
    expect(
      renderLine({ kind: 'emote', authorName: 'bob', authorColor: '#00ff00', text: 'waves' }),
    ).toContain('mara-emote');
    expect(
      renderLine({ kind: 'system', authorName: '', authorColor: '', text: 'bob joined' }),
    ).toContain('mara-system');
  });
});
