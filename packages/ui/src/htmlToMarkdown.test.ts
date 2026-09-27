// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { renderText } from '@mara/chat-render';
import { htmlToMarkdown as md } from './htmlToMarkdown.js';

describe('htmlToMarkdown', () => {
  it('returns null when there is nothing but text', () => {
    expect(md('<p>Just a paragraph.</p><div>And a line.</div>')).toBeNull();
    // A code editor's copy: coloured spans, no formatting a message could carry.
    expect(
      md('<div style="color:#d4d4d4"><span style="color:#569cd6">const</span> x = 1;</div>'),
    ).toBeNull();
  });

  it('converts inline formatting', () => {
    expect(md('<p>a <b>bold</b>, <em>italic</em>, <u>under</u> and <s>gone</s></p>')).toBe(
      'a **bold**, *italic*, __under__ and ~~gone~~',
    );
    expect(md('<p><strong><em>both</em></strong></p>')).toBe('***both***');
    expect(md('<p>run <code>npm i</code> first</p>')).toBe('run `npm i` first');
  });

  it('reads formatting from inline styles, and lets style override the tag', () => {
    expect(
      md('<span style="font-weight:700">heavy</span> <span style="font-style:italic">slant</span>'),
    ).toBe('**heavy** *slant*');
    // Google Docs: the whole paste sits in a not-actually-bold <b>.
    expect(
      md(
        '<b style="font-weight:normal" id="docs-internal-guid-1"><p><span style="font-weight:700">Hi</span> there</p><p>Second</p></b>',
      ),
    ).toBe('**Hi** there\n\nSecond');
  });

  it('keeps whitespace outside the markers and does not double them', () => {
    expect(md('<p>x<b> padded </b>y</p>')).toBe('x **padded** y');
    expect(md('<p><b>a <strong>b</strong> c</b></p>')).toBe('**a b c**');
  });

  it('writes links as text (url), or just the url', () => {
    expect(md('<p>see <a href="https://example.com/docs">the docs</a></p>')).toBe(
      'see the docs (https://example.com/docs)',
    );
    expect(md('<p><a href="https://example.com/">https://example.com/</a> <b>x</b></p>')).toBe(
      'https://example.com/ **x**',
    );
    expect(md('<p><a href="#top">top</a> <a href="mailto:a@b.c">mail</a> <b>x</b></p>')).toBe(
      'top mail **x**',
    );
  });

  it('keeps a trailing URL outside a formatting marker', () => {
    const out = md('<p><b>read <a href="https://x.com/a">this</a></b></p>');
    expect(out).toBe('**read this** (https://x.com/a)');
  });

  it('converts headings, lists, quotes and code blocks', () => {
    expect(md('<h1>Title</h1><h2>Sub</h2><h5>Small</h5>')).toBe('# Title\n\n## Sub\n\n**Small**');
    expect(md('<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>')).toBe(
      '- one\n- two\n- nested',
    );
    expect(md('<ol start="3"><li>c</li><li><p>d</p></li></ol>')).toBe('3. c\n4. d');
    expect(md('<blockquote><p>quoted</p><p>more</p></blockquote>')).toBe('> quoted\n>\n> more');
    expect(md('<pre class="language-js"><code>if (a) {\n  b();\n}\n</code></pre>')).toBe(
      '```js\nif (a) {\n  b();\n}\n```',
    );
  });

  it('converts a data table and ignores a layout table', () => {
    expect(
      md(
        '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>x|y</td></tr><tr><td></td><td><b>z</b></td></tr></tbody></table>',
      ),
    ).toBe('| A | B |\n| --- | --- |\n| 1 | x\\|y |\n|  | **z** |');
    expect(md('<table><tr><td><b>only</b> cell</td></tr></table>')).toBe('**only** cell');
  });

  it('escapes text that would otherwise format, but not URLs or snake_case', () => {
    expect(md('<p>2*3*4 and snake_case and _x_ <b>y</b></p>')).toBe(
      '2\\*3\\*4 and snake_case and \\_x\\_ **y**',
    );
    expect(md('<p>https://x.com/a_b_ <i>k</i></p>')).toBe('https://x.com/a_b_ *k*');
    expect(md('<p># not a heading</p><p><b>x</b></p>')).toBe('\\# not a heading\n\n**x**');
  });

  it('handles images: emoji become text, real pictures become ![alt](url), icons are dropped', () => {
    expect(md('<p>hi <img alt=":wave:" src="/emoji/wave.png"> <b>x</b></p>')).toBe(
      'hi :wave: **x**',
    );
    expect(md('<p><img alt="😀" src="https://t.co/1f600.svg"> <b>x</b></p>')).toBe('😀 **x**');
    expect(md('<p><img alt="A cat" src="https://x.com/cat.jpg"></p>')).toBe(
      '![A cat](https://x.com/cat.jpg)',
    );
    expect(md('<p><img width="16" src="https://x.com/i.png"> <b>x</b></p>')).toBe('**x**');
  });

  it('separates divs by a line and paragraphs by a blank line; skips hidden and controls', () => {
    expect(md('<div><b>a</b></div><div>b</div><p>c</p>')).toBe('**a**\nb\n\nc');
    expect(
      md('<p><b>x</b><span style="display:none">hidden</span><button>React</button></p>'),
    ).toBe('**x**');
  });

  it('produces markdown the renderer formats as intended', () => {
    const html = renderText(md('<p><b>bold</b> <a href="https://e.com/p">link</a></p>') ?? '');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('href="https://e.com/p"');
    expect(html).not.toContain('https://e.com/p)');
  });
});
