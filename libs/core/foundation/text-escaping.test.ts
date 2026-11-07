import { describe, expect, it } from 'vitest';

import { escapeHtml, escapeXml } from './text-escaping.js';

describe('text escaping', () => {
  it('escapes HTML metacharacters consistently', () => {
    expect(escapeHtml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&#39;');
  });

  it('escapes XML metacharacters consistently', () => {
    expect(escapeXml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&apos;');
  });
});
