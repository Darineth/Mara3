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

  it('renders image URLs inline as a clickable thumbnail', () => {
    const html = renderText('look https://example.com/cat.png cute');
    expect(html).toContain('<img class="mara-img" src="https://example.com/cat.png"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('<a href="https://example.com/cat.png"');
  });

  it('treats image URLs with a query string as images', () => {
    const html = renderText('https://cdn.example.com/a.jpg?w=200');
    expect(html).toContain('<img class="mara-img" src="https://cdn.example.com/a.jpg?w=200"');
  });

  it('leaves non-image URLs as plain links', () => {
    const html = renderText('https://example.com/page');
    expect(html).not.toContain('<img');
    expect(html).toContain('<a href="https://example.com/page"');
  });

  it('renders image URLs as links when images are disabled', () => {
    const html = renderText('https://example.com/cat.png', { images: false });
    expect(html).not.toContain('<img');
    expect(html).toContain('<a href="https://example.com/cat.png"');
  });

  it('keeps a trailing ampersand inside the link without stranding a semicolon', () => {
    const html = renderText('see https://example.com/a?b=1&');
    expect(html).toContain('<a href="https://example.com/a?b=1&amp;"');
    expect(html.endsWith('</a>')).toBe(true); // nothing left dangling after the link
    expect(html).not.toMatch(/;\s*$/);
  });

  it('keeps a trailing ampersand inside an inline image URL', () => {
    const html = renderText('https://cdn.example.com/a.png?x=1&');
    expect(html).toContain('src="https://cdn.example.com/a.png?x=1&amp;"');
    expect(html).not.toMatch(/;\s*$/); // no stranded semicolon
  });

  it('wraps inline images in a hideable box with show/hide controls', () => {
    const html = renderText('https://example.com/cat.png');
    expect(html).toContain('class="mara-img-box"');
    expect(html).toContain('class="mara-img-hide"');
    expect(html).toContain('class="mara-img-show"');
  });

  it('renders a server-relative upload path as an inline image (no baked-in host)', () => {
    const html = renderText('here you go /uploads/abc123.png');
    expect(html).toContain('<img class="mara-img" src="/uploads/abc123.png"');
    expect(html).toContain('here you go'); // text stays, image lifted below
  });

  it('does not treat /uploads inside a larger token as a relative image', () => {
    const html = renderText('path/uploads/x.png');
    expect(html).not.toContain('<img');
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
