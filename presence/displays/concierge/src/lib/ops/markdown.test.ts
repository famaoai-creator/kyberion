import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { isSafeMarkdownUrl, Markdown, parseMarkdownBlocks } from './markdown';

const html = (source: string) => renderToStaticMarkup(React.createElement(Markdown, { source }));

describe('chat markdown', () => {
  it('renders the common formatting', () => {
    const out = html(
      '# Title\n\nSome **bold** and *italic* and `code`.\n\n- one\n- two\n\n1. a\n2. b\n\n> quoted'
    );
    expect(out).toContain('<h3>Title</h3>');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<em>italic</em>');
    expect(out).toContain('<code>code</code>');
    expect(out).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(out).toContain('<ol><li>a</li><li>b</li></ol>');
    expect(out).toContain('<blockquote>quoted</blockquote>');
  });

  it('never turns text into markup', () => {
    const out = html('<img src=x onerror=alert(1)> and <script>alert(1)</script>');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<script');
    expect(out).toContain('&lt;img');
  });

  it('only links safe URLs, and opens them safely', () => {
    expect(isSafeMarkdownUrl('https://example.com')).toBe(true);
    expect(isSafeMarkdownUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeMarkdownUrl('data:text/html;base64,AAAA')).toBe(false);
    const out = html('[ok](https://example.com) and [bad](javascript:alert(1))');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).not.toContain('href="javascript');
    expect(out).toContain('[bad](javascript:alert(1))');
  });

  it('handles fenced code, including one still streaming in', () => {
    const blocks = parseMarkdownBlocks('before\n\n```ts\nconst a = 1;\n```\n\nafter');
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'code', 'paragraph']);
    expect(blocks[1]).toMatchObject({ kind: 'code', lang: 'ts', text: 'const a = 1;' });
    // An unterminated fence (mid-stream) renders what has arrived instead of swallowing the message.
    const partial = parseMarkdownBlocks('```js\nlet x');
    expect(partial).toEqual([{ kind: 'code', lang: 'js', text: 'let x' }]);
    expect(html('```\n<b>not bold</b>\n```')).toContain('&lt;b&gt;not bold&lt;/b&gt;');
  });
});
