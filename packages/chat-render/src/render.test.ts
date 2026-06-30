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

  it('treats an extension-less URL as an image when the query declares a format', () => {
    expect(renderText('https://cdn.example.com/img?format=jpg')).toContain('<img class="mara-img"');
    expect(renderText('https://cdn.example.com/img?w=20&fm=png')).toContain(
      '<img class="mara-img"',
    );
    expect(renderText('https://cdn.example.com/i?ext=webp')).toContain('<img class="mara-img"');
  });

  it('leaves a genuinely opaque URL (no extension, no declared format) as a link', () => {
    const html = renderText('https://encrypted-tbn0.gstatic.com/images?q=tbn:abc&s=10');
    expect(html).not.toContain('<img');
    expect(html).toContain(
      '<a href="https://encrypted-tbn0.gstatic.com/images?q=tbn:abc&amp;s=10"',
    );
  });

  it('forces an opaque URL inline when prefixed with the `!` sender marker', () => {
    const html = renderText('!https://encrypted-tbn0.gstatic.com/images?q=tbn:abc');
    expect(html).toContain(
      '<img class="mara-img" src="https://encrypted-tbn0.gstatic.com/images?q=tbn:abc"',
    );
    expect(html).not.toContain('!https'); // the marker is consumed, not rendered
    expect(html).not.toContain('src="!'); // and never leaks into the URL
  });

  it('honors images:false even for a `!`-marked URL (renders a link, drops the marker)', () => {
    const html = renderText('!https://example.com/opaque', { images: false });
    expect(html).not.toContain('<img');
    expect(html).toContain('<a href="https://example.com/opaque"');
    expect(html).not.toContain('!https');
  });

  it('leaves a lone `!` (not before a URL) as literal text', () => {
    expect(renderText('wow!')).toBe('wow!');
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

  it('renders a server-relative upload path as a base-relative inline image', () => {
    // Emitted WITHOUT the leading slash so it resolves against the page base —
    // works at the domain root and under a subpath (e.g. https://host/mara/).
    const html = renderText('here you go /uploads/abc123.png');
    expect(html).toContain('<img class="mara-img" src="uploads/abc123.png"');
    expect(html).not.toContain('src="/uploads/'); // not root-absolute
    expect(html).toContain('href="uploads/abc123.png"'); // lightbox link too
    expect(html).toContain('here you go'); // surrounding text stays
  });

  it('renders an inline image IN PLACE, between the surrounding text', () => {
    const html = renderText('before https://example.com/cat.png after');
    // The image sits where the URL was: "before" precedes it, "after" follows it —
    // not lifted into a block at the end.
    expect(html).toMatch(/before[\s\S]*<img class="mara-img"[\s\S]*after/);
    expect(html).not.toContain('mara-imgs'); // no hoist wrapper
  });

  it('leaves absolute http(s) image URLs untouched (only /uploads/ is made relative)', () => {
    const html = renderText('https://cdn.example.com/a.png');
    expect(html).toContain('src="https://cdn.example.com/a.png"');
  });

  it('does not treat /uploads inside a larger token as a relative image', () => {
    const html = renderText('path/uploads/x.png');
    expect(html).not.toContain('<img');
  });

  it('never emits a real tag from user angle brackets', () => {
    const html = renderText('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('neutralizes an attribute-breakout attempt embedded in a URL', () => {
    const html = renderText('see http://x.com" onmouseover="alert(1) end');
    expect(html).not.toContain('" onmouseover="'); // quote did not break out of href
    expect(html).toContain('&quot;'); // it was escaped instead
  });

  it('does not re-scan restored placeholders (single-pass restore invariant)', () => {
    // A code span adjacent to a URL: the stashed <code> tag carries its own
    // quotes. A recursive restore could inject those into the anchor's href;
    // a single pass must not, so no real <code> tag ends up inside an attribute.
    const html = renderText('http://x.com`y`');
    expect(html).not.toContain('href="http://x.com<code');
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

describe('renderText — Markdown image syntax', () => {
  it('renders ![alt](url) inline as an image with the alt text', () => {
    const html = renderText('look ![a cat](https://example.com/cat.png) here');
    expect(html).toContain('<img class="mara-img" src="https://example.com/cat.png"');
    expect(html).toContain('alt="a cat"');
    expect(html).toMatch(/look[\s\S]*<img[\s\S]*here/); // in place
    expect(html).not.toContain('!['); // the markdown syntax is consumed
  });

  it('forces ![](url) inline regardless of extension, with empty alt', () => {
    const html = renderText('![](https://example.com/opaque)');
    expect(html).toContain('<img class="mara-img" src="https://example.com/opaque"');
    expect(html).toContain('alt=""');
  });

  it('renders a ![alt](/uploads/…) path as a base-relative inline image', () => {
    const html = renderText('![shot](/uploads/abc123.png)');
    expect(html).toContain('<img class="mara-img" src="uploads/abc123.png"');
    expect(html).toContain('alt="shot"');
  });

  it('escapes the alt text (no attribute breakout)', () => {
    const html = renderText('![x"onerror="alert(1)](https://example.com/p.png)');
    expect(html).not.toContain('"onerror="');
    expect(html).toContain('&quot;');
  });

  it('degrades ![alt](url) to a link when images are disabled', () => {
    const html = renderText('![cat](https://example.com/cat.png)', { images: false });
    expect(html).not.toContain('<img');
    expect(html).toContain('<a href="https://example.com/cat.png"');
  });

  it('leaves ![alt](url) literal when the URL is not an allowed scheme', () => {
    const html = renderText('![x](javascript:alert(1))');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('src="javascript:');
  });
});

describe('renderText — legacy Mara 2 tags', () => {
  it('forces [img] contents inline as an image regardless of extension', () => {
    const html = renderText('[img]https://example.com/pic[/img]');
    expect(html).toContain('<img class="mara-img" src="https://example.com/pic"');
    expect(html).not.toContain('[img]');
    expect(html).not.toContain('[/img]');
  });

  it('renders an [img] server-relative upload path inline', () => {
    const html = renderText('[img]/uploads/abc123.bin[/img]');
    expect(html).toContain('<img class="mara-img" src="uploads/abc123.bin"');
  });

  it('leaves [img] with non-URL contents as literal text', () => {
    const html = renderText('[img]not a url[/img]');
    expect(html).not.toContain('<img');
    expect(html).toContain('[img]not a url[/img]');
  });

  it('escapes a quote smuggled into [img] contents (no attribute breakout)', () => {
    const html = renderText('[img]https://x.com/a"onerror="alert(1)[/img]');
    expect(html).not.toContain('"onerror="'); // quote did not break out of src
    expect(html).toContain('&quot;'); // it was escaped instead
  });

  it('renders [img] as a link when images are disabled', () => {
    const html = renderText('[img]https://example.com/pic[/img]', { images: false });
    expect(html).not.toContain('<img');
    expect(html).toContain('<a href="https://example.com/pic"');
  });

  it('renders legacy [b], [i], [u], [s] tags as their markdown equivalents', () => {
    expect(renderText('[b]bold[/b]')).toBe('<strong>bold</strong>');
    expect(renderText('[i]italic[/i]')).toBe('<em>italic</em>');
    expect(renderText('[u]under[/u]')).toBe('<u>under</u>');
    expect(renderText('[s]strike[/s]')).toBe('<s>strike</s>');
  });

  it('matches bracket tags case-insensitively and nests', () => {
    expect(renderText('[B][i]x[/I][/b]')).toBe('<strong><em>x</em></strong>');
  });

  it('leaves bracket tags literal when markdown is disabled', () => {
    expect(renderText('[b]x[/b]', { markdown: false })).toBe('[b]x[/b]');
  });

  it('renders the legacy [spoiler] tag like a ||spoiler||', () => {
    expect(renderText('[spoiler]hidden[/spoiler]')).toBe(
      '<span class="mara-spoiler">hidden</span>',
    );
  });

  it('matches [spoiler] case-insensitively', () => {
    expect(renderText('[Spoiler]x[/SPOILER]')).toBe('<span class="mara-spoiler">x</span>');
  });

  it('applies inner markdown inside a [spoiler] tag', () => {
    expect(renderText('[spoiler]**bold**[/spoiler]')).toBe(
      '<span class="mara-spoiler"><strong>bold</strong></span>',
    );
  });

  it('leaves [spoiler] literal when markdown is disabled', () => {
    expect(renderText('[spoiler]x[/spoiler]', { markdown: false })).toBe('[spoiler]x[/spoiler]');
  });
});

describe('renderLine', () => {
  it('renders a chat line with author color and escaped text', () => {
    const html = renderLine({
      kind: 'chat',
      authorName: 'al<i>ce',
      authorColor: '#ff0000',
      text: 'hi',
      timestamp: '12:00',
    });
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

  it('renders a system line as escaped text only — no link/image/markdown from a name', () => {
    // A user-chosen name embedded in a join notice must not become a link, image, or
    // formatted text (L5). renderText still escapes, so it is never an XSS vector —
    // this asserts it is also not a clickable/inline-media vector.
    const html = renderLine({
      kind: 'system',
      authorName: '',
      authorColor: '',
      text: '![](/uploads/x.png) http://evil.com **bold** joined',
    });
    expect(html).toContain('mara-system');
    expect(html).not.toContain('<img'); // no inline image from the name
    expect(html).not.toContain('<a '); // no auto-link
    expect(html).not.toContain('<strong>'); // no markdown
    expect(html).toContain('joined');
  });

  it('renders a notice line at default colour (no dim/italic wrapper) with markdown', () => {
    const html = renderLine({
      kind: 'notice',
      authorName: '',
      authorColor: '',
      text: 'MOTD **hi**',
    });
    expect(html).toContain('mara-notice');
    expect(html).not.toContain('<em>'); // not the dim italic system style
    expect(html).toContain('<strong>hi</strong>'); // markdown still applies
  });

  it('renders an away line in the author colour, escaped (no markdown/links)', () => {
    const html = renderLine({
      kind: 'away',
      authorName: 'bob',
      authorColor: '#00ff00',
      text: 'bob is away (**lunch** http://x ![](/y))',
    });
    expect(html).toContain('mara-away');
    expect(html).toContain('color:#00ff00'); // the whole line is in the user's colour
    expect(html).toContain('<em>'); // italic, like an action
    expect(html).not.toContain('<strong>'); // away note is escaped — no markdown
    expect(html).not.toContain('<a '); // no auto-link
    expect(html).not.toContain('<img'); // no inline image
  });

  it('falls back to a safe away colour when authorColor is invalid', () => {
    const html = renderLine({
      kind: 'away',
      authorName: 'x',
      authorColor: 'red',
      text: 'x is back.',
    });
    expect(html).toContain('color:#888888');
  });
});
