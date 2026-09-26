import { describe, expect, it } from 'vitest';
import { extractHtmlTitle, htmlToMarkdown } from './html-to-markdown.js';

describe('html-to-markdown', () => {
  it('converts block/inline tags and drops head, scripts and comments', () => {
    const html =
      '<html><head><title>T</title><style>p{}</style></head><body><!-- x -->' +
      '<h1>Head</h1><p>A <a href="/u">link</a> &amp; <em>em</em></p>' +
      '<ol><li>one</li><li>two</li></ol><pre>line 1\n  line 2</pre><script>bad()</script></body></html>';
    expect(htmlToMarkdown(html)).toBe(
      '# Head\n\nA [link](/u) & *em*\n\n1. one\n2. two\n\n```\nline 1\n  line 2\n```'
    );
  });

  it('extracts the <title> with entities decoded, or undefined', () => {
    expect(extractHtmlTitle('<title>\n  R&amp;D  &#x2014; Plan </title>')).toBe('R&D — Plan');
    expect(extractHtmlTitle('<title> </title>')).toBeUndefined();
    expect(extractHtmlTitle('<p>none</p>')).toBeUndefined();
  });
});
