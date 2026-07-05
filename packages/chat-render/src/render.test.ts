import { describe, expect, it } from 'vitest';
import {
  applyEmoticons,
  DEFAULT_EMOTICONS,
  escapeHtml,
  linkify,
  renderLine,
  renderText,
} from './index.js';

// A rendered spoiler carries a trailing re-hide handle (a covered-spoiler affordance,
// styled + wired by the client). Wrap expected spoiler content through this helper.
const spoiler = (inner: string) =>
  `<span class="mara-spoiler">${inner}<span class="mara-spoiler-hide" aria-hidden="true"></span></span>`;

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

  it('does not give links target="_blank" (the app opens them itself)', () => {
    // _blank does nothing in the Tauri 2 desktop client (it blocks _blank new windows) and
    // double-opens in the Tauri 1 legacy client; the app intercepts the click instead.
    expect(linkify('https://example.com/x')).not.toContain('target="_blank"');
    expect(renderText('https://example.com/x')).not.toContain('target="_blank"');
  });
});

describe('renderText — custom emoji', () => {
  const emoji = {
    blob: '/emoji/blob.png',
    wave: 'https://cdn.example.com/wave.gif',
  };

  it('renders a known :shortcode: as an inline emoji image (upload-style relative src)', () => {
    const html = renderText('hi :blob: there', { emoji });
    // Server-relative /emoji/ path loses its leading slash so it resolves against the base.
    expect(html).toContain('<img class="mara-emoji" src="emoji/blob.png"');
    expect(html).toContain('alt=":blob:"');
    expect(html).toContain('hi ');
    expect(html).toContain(' there');
  });

  it('accepts an absolute http(s) emoji URL unchanged', () => {
    const html = renderText(':wave:', { emoji });
    expect(html).toContain('src="https://cdn.example.com/wave.gif"');
    expect(html).toContain('class="mara-emoji"');
  });

  it('leaves an unknown shortcode as literal text', () => {
    expect(renderText('say :nope: please', { emoji })).toBe('say :nope: please');
  });

  it('does not convert shortcodes inside a code span', () => {
    const html = renderText('`:blob:`', { emoji });
    expect(html).not.toContain('mara-emoji');
    expect(html).toContain('<code');
    expect(html).toContain(':blob:');
  });

  it('does not touch colon runs that are not shortcodes', () => {
    // Nothing named "30"/"45" in the map, so a clock time is untouched.
    expect(renderText('at 12:30:45 sharp', { emoji })).toBe('at 12:30:45 sharp');
  });

  it('ignores a manifest URL with a disallowed scheme (defense-in-depth)', () => {
    const html = renderText(':x:', { emoji: { x: 'javascript:alert(1)' } });
    expect(html).not.toContain('<img');
    expect(html).toBe(':x:');
  });

  it('renders no emoji when no map is supplied', () => {
    expect(renderText('plain :blob: text')).toBe('plain :blob: text');
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

  it('does not give the image link target="_blank"', () => {
    // A plain click is handled in JS (lightbox); _blank would make the desktop WebView
    // ALSO open the image in the system browser, despite the client's preventDefault.
    const html = renderText('https://example.com/cat.png');
    expect(html).toContain('class="mara-img-link"');
    expect(html).not.toMatch(/mara-img-link[^>]*target="_blank"/);
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
    expect(renderText('||top secret||')).toBe(spoiler('top secret'));
  });

  it('renders inline code and code blocks without formatting inside', () => {
    expect(renderText('`a*b*c`')).toBe('<code class="mara-code">a*b*c</code>');
    expect(renderText('```let x = *y*```')).toBe('<code class="mara-codeblock">let x = *y*</code>');
  });

  it('supports a double-backtick code span so a single backtick can appear inside', () => {
    expect(renderText('``a`b``')).toBe('<code class="mara-code">a`b</code>');
  });

  it('honors backslash escapes for special characters', () => {
    // Escaped markers render literally (no formatting), dropping the backslash.
    expect(renderText('\\*not italic\\*')).toBe('*not italic*');
    expect(renderText('\\*x\\*')).not.toContain('<em>');
    expect(renderText('\\|\\|x\\|\\|')).toBe('||x||');
    expect(renderText('\\# not a header')).toBe('# not a header'); // escapes the block marker too
    expect(renderText('a \\\\ b')).toBe('a \\ b'); // \\ -> one literal backslash
    // A real, unescaped marker still formats.
    expect(renderText('*yes*')).toBe('<em>yes</em>');
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

  it('strips a code-block language hint (no syntax highlighting)', () => {
    expect(renderText('```js\nlet x = 1;\n```')).toBe(
      '<code class="mara-codeblock">let x = 1;\n</code>',
    );
    // No newline after the fence → no language hint, the whole thing is code.
    expect(renderText('```plain text```')).toBe('<code class="mara-codeblock">plain text</code>');
  });
});

describe('renderText — spoilers wrapping links & images', () => {
  const opts = { links: true, images: true };

  it('wraps a bare link in a ||spoiler|| without the URL eating the closing ||', () => {
    expect(renderText('||https://example.com||', opts)).toBe(
      spoiler('<a href="https://example.com" rel="noopener noreferrer">https://example.com</a>'),
    );
  });

  it('allows whitespace around spoiler content (unlike bold), matching Discord', () => {
    // `|| x ||` is a spoiler containing " x " — a spoiler is a container, not emphasis.
    expect(renderText('|| hidden ||')).toBe(spoiler(' hidden '));
    expect(renderText('|| https://example.com ||', opts)).toBe(
      spoiler(' <a href="https://example.com" rel="noopener noreferrer">https://example.com</a> '),
    );
  });

  it('wraps an inline image (by extension) in a ||spoiler||', () => {
    const html = renderText('||https://example.com/pic.png||', opts);
    expect(html).toContain('<span class="mara-spoiler"><span class="mara-img-box">');
    expect(html).toContain('src="https://example.com/pic.png"');
    // The spoiler is terminated (not left as a literal leading `||`).
    expect(html).not.toContain('||');
  });

  it('wraps a Markdown image in a ||spoiler||', () => {
    const html = renderText('||![alt](/uploads/pic.png)||', opts);
    expect(html).toContain('<span class="mara-spoiler"><span class="mara-img-box">');
    expect(html).not.toContain('||');
  });

  it('wraps a link in a legacy [spoiler] tag without eating [/spoiler]', () => {
    expect(renderText('[spoiler]https://example.com[/spoiler]', opts)).toBe(
      spoiler('<a href="https://example.com" rel="noopener noreferrer">https://example.com</a>'),
    );
  });

  it('does not let a URL swallow any [/tag] closing (e.g. [b]…[/b])', () => {
    expect(renderText('[b]https://example.com[/b]', opts)).toBe(
      '<strong><a href="https://example.com" rel="noopener noreferrer">https://example.com</a></strong>',
    );
  });

  it('stops a URL at a pipe but keeps single brackets and IPv6 literals', () => {
    // Single `|` ends the URL (Discord-like); the `|2` trails as text.
    expect(renderText('https://example.com/a|b', opts)).toBe(
      '<a href="https://example.com/a" rel="noopener noreferrer">https://example.com/a</a>|b',
    );
    // A single `[` (not a `[/` closing tag) stays in the URL.
    expect(renderText('https://example.com/a[b]c', opts)).toContain(
      'href="https://example.com/a[b]c"',
    );
    // IPv6 literal is preserved end to end.
    expect(renderText('http://[2001:db8::1]/p', opts)).toContain('href="http://[2001:db8::1]/p"');
  });
});

describe('renderText — Discord block markdown', () => {
  it('renders headers (1–3 #) and subtext, with inline markdown inside', () => {
    expect(renderText('# Big')).toBe('<div class="mara-h1">Big</div>');
    expect(renderText('## Mid')).toBe('<div class="mara-h2">Mid</div>');
    expect(renderText('### Small')).toBe('<div class="mara-h3">Small</div>');
    expect(renderText('# **bold** title')).toBe(
      '<div class="mara-h1"><strong>bold</strong> title</div>',
    );
    expect(renderText('-# fine print')).toBe('<div class="mara-subtext">fine print</div>');
    // 4+ hashes / no text isn't a header.
    expect(renderText('#### nope')).toBe('#### nope');
    expect(renderText('#notaheader')).toBe('#notaheader');
  });

  it('renders headers/subtext regardless of line endings (CRLF from a Windows MOTD)', () => {
    // The header/subtext regexes are `$`-anchored; without CRLF→LF normalization a
    // trailing \r would stop them from matching (a Windows-authored MOTD.md rendered
    // headers as plain text). Both endings must produce the same block markup.
    expect(renderText('# Big\r\n## Mid')).toBe(
      '<div class="mara-h1">Big</div><div class="mara-h2">Mid</div>',
    );
    expect(renderText('-# fine print\r\nplain')).toBe(
      '<div class="mara-subtext">fine print</div>plain',
    );
  });

  it('renders single-line and rest-of-message block quotes', () => {
    expect(renderText('> quoted')).toBe('<blockquote class="mara-quote">quoted</blockquote>');
    // Consecutive `> ` lines fold into one quote.
    expect(renderText('> a\n> b')).toBe('<blockquote class="mara-quote">a\nb</blockquote>');
    // `>>> ` quotes the rest of the message, plain `>` lines included.
    expect(renderText('>>> a\nb\nc')).toBe('<blockquote class="mara-quote">a\nb\nc</blockquote>');
  });

  it('renders bullet and numbered lists', () => {
    expect(renderText('- a\n- b')).toBe('<ul class="mara-list"><li>a</li><li>b</li></ul>');
    expect(renderText('* a\n* b')).toBe('<ul class="mara-list"><li>a</li><li>b</li></ul>');
    expect(renderText('1. a\n2. b')).toBe('<ol class="mara-list"><li>a</li><li>b</li></ol>');
  });

  it('folds a wrapped list item into one <li> instead of splitting the list', () => {
    // An indented continuation line (a soft-wrapped bullet) stays part of its item, so
    // the whole thing is ONE list — not a list, a stray line, then another list.
    expect(renderText('- first item that\n  wraps on\n- second')).toBe(
      '<ul class="mara-list"><li>first item that wraps on</li><li>second</li></ul>',
    );
    expect(renderText('1. one that\n   wraps\n2. two')).toBe(
      '<ol class="mara-list"><li>one that wraps</li><li>two</li></ol>',
    );
  });

  it('ends a list at a blank or non-indented line, not at a wrap', () => {
    // Blank line ends the list; the following non-indented text is its own plain line.
    expect(renderText('- a\n  wrapped\n\nafter')).toBe(
      '<ul class="mara-list"><li>a wrapped</li></ul>\n\nafter',
    );
  });

  it('keeps plain lines separated and blocks self-breaking', () => {
    // Plain line then a header: no extra blank line, header is its own block.
    expect(renderText('hello\n# Title')).toBe('hello<div class="mara-h1">Title</div>');
    // Two plain lines: a newline between them (the view renders it via pre-wrap).
    expect(renderText('a\nb')).toBe('a\nb');
  });

  it('preserves a blank line between two blocks as a gap', () => {
    expect(renderText('# H\n\n- a')).toBe(
      '<div class="mara-h1">H</div>\n\n<ul class="mara-list"><li>a</li></ul>',
    );
  });

  it('does not block-format when blocks are disabled (emote/away contexts)', () => {
    // A leading `#`/`>` stays literal; inline markdown still applies.
    expect(renderText('# not a header **but bold**', { blocks: false })).toBe(
      '# not a header <strong>but bold</strong>',
    );
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

describe('renderText — @mentions', () => {
  const user = (name: string, color = '#3366cc') => ({ name, color });
  const opts = { mentions: ['alice', 'Bob Smith', 'Rosalind', 'Rosa'].map((n) => user(n)) };

  it('styles a known @name in the target user colour with a matching glow', () => {
    const html = renderText('hey @alice look', opts);
    expect(html).toContain(
      '<strong class="mara-mention" style="color:#3366cc;text-shadow:0 0 6px #3366cc">@alice</strong>',
    );
  });

  it('matches case-insensitively, keeping the typed form', () => {
    expect(renderText('hey @ALICE look', opts)).toContain('>@ALICE</strong>');
  });

  it('matches multi-word names, longest first', () => {
    expect(renderText('cc @Bob Smith please', opts)).toContain('>@Bob Smith</strong>');
    // Longest-first: a known @Rosalind is never half-styled as @Rosa.
    expect(renderText('ping @Rosalind', opts)).toContain('>@Rosalind</strong>');
  });

  it('never matches unknown names, glued @s, or longer words', () => {
    expect(renderText('hi @stranger', opts)).not.toContain('mara-mention');
    expect(renderText('mail me at bob@alice', opts)).not.toContain('mara-mention');
    expect(renderText('ping @alicespring', opts)).not.toContain('mara-mention');
  });

  it('leaves mentions inside code spans literal', () => {
    const html = renderText('run `git blame @alice` ok', opts);
    expect(html).toContain('git blame @alice');
    expect(html).not.toContain('mara-mention');
  });

  it('escapes names with HTML-special characters', () => {
    const html = renderText('hi @<b>evil</b>', { mentions: [user('<b>evil</b>')] });
    expect(html).toContain('>@&lt;b&gt;evil&lt;/b&gt;</strong>');
    expect(html).not.toContain('<b>evil</b>');
  });

  it('drops the style (still bold) when the colour is not clean #rrggbb', () => {
    const html = renderText('hi @eve', {
      mentions: [{ name: 'eve', color: 'red;background:url(x)' }],
    });
    expect(html).toContain('<strong class="mara-mention">@eve</strong>');
    expect(html).not.toContain('style=');
  });

  it('does nothing without the option (default off)', () => {
    expect(renderText('hey @alice')).not.toContain('mara-mention');
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
    expect(renderText('[spoiler]hidden[/spoiler]')).toBe(spoiler('hidden'));
  });

  it('matches [spoiler] case-insensitively', () => {
    expect(renderText('[Spoiler]x[/SPOILER]')).toBe(spoiler('x'));
  });

  it('applies inner markdown inside a [spoiler] tag', () => {
    expect(renderText('[spoiler]**bold**[/spoiler]')).toBe(spoiler('<strong>bold</strong>'));
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

  it('discord layout puts name+timestamp in a header with the text below', () => {
    const html = renderLine(
      { kind: 'chat', authorName: 'alice', authorColor: '#ff0000', text: 'hi', timestamp: '12:00' },
      { layout: 'discord' },
    );
    expect(html).toContain('mara-discord');
    expect(html).toContain('<div class="mara-head">');
    expect(html).toContain('<span class="mara-author" style="color:#ff0000">alice</span>');
    expect(html).toContain('<span class="mara-ts">12:00</span>');
    expect(html).toContain('<div class="mara-text">hi</div>');
    expect(html).not.toContain('alice:'); // no compact "name:" prefix in cozy mode
  });

  it('discord continuation drops the header (grouped run)', () => {
    const html = renderLine(
      {
        kind: 'chat',
        authorName: 'alice',
        authorColor: '#ff0000',
        text: 'again',
        timestamp: '12:01',
      },
      { layout: 'discord', continuation: true },
    );
    expect(html).toContain('mara-cont');
    expect(html).not.toContain('mara-head');
    expect(html).not.toContain('12:01'); // the timestamp lives only in the (suppressed) header
    expect(html).toContain('<div class="mara-text">again</div>');
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

  it('renders an away line in the author colour: name escaped, note markdown + links, no images', () => {
    const html = renderLine({
      kind: 'away',
      authorName: 'http://bob', // a URL-ish name must NOT become a link
      authorColor: '#00ff00',
      text: 'is away (**lunch** see https://x.com cat https://c.png)',
    });
    expect(html).toContain('mara-away');
    expect(html).toContain('color:#00ff00'); // the whole line is in the user's colour
    expect(html).toContain('<em>'); // italic, like an action
    expect(html).toContain('<strong>lunch</strong>'); // markdown applies to the note
    expect(html).toContain('<a href="https://x.com"'); // links work in the note
    expect(html).not.toContain('<img'); // but inline images are off (away persists)
    expect(html).not.toContain('href="http://bob"'); // the name is escaped, never a link
  });

  it('falls back to a safe away colour when authorColor is invalid', () => {
    const html = renderLine({
      kind: 'away',
      authorName: 'x',
      authorColor: 'red',
      text: 'is back.',
    });
    expect(html).toContain('color:#888888');
  });
});
