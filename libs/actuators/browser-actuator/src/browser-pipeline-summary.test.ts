import { describe, expect, it } from 'vitest';
import { buildBrowserPipelineSummary, refMapFromSnapshot } from './browser-pipeline-summary.js';

describe('browser pipeline summary', () => {
  it('flattens url/title/refs/screenshot for operators', () => {
    const summary = buildBrowserPipelineSummary({
      last_url: 'https://example.com/',
      last_screenshot: 'evidence/browser/shot.png',
      browser_tabs: [
        { tab_id: 'tab-1', url: 'https://example.com/', title: 'Example Domain', active: true },
      ],
      last_snapshot: {
        url: 'https://example.com/',
        title: 'Example Domain',
        element_count: 1,
        elements: [
          {
            ref: '@e1',
            tag: 'a',
            name: 'Learn more',
            text: 'Learn more',
            href: 'https://iana.org/domains/example',
            selector: 'a',
          },
        ],
      },
    });

    expect(summary).toMatchObject({
      url: 'https://example.com/',
      title: 'Example Domain',
      element_count: 1,
      screenshot: 'evidence/browser/shot.png',
      last_url: 'https://example.com/',
    });
    expect(summary.refs).toEqual([
      {
        ref: '@e1',
        tag: 'a',
        name: 'Learn more',
        text: 'Learn more',
        href: 'https://iana.org/domains/example',
      },
    ]);
  });

  it('builds a ref_map from a snapshot', () => {
    expect(
      refMapFromSnapshot({
        elements: [
          { ref: '@e1', selector: 'a.link' },
          { ref: '@e2', selector: 'button' },
        ],
      })
    ).toEqual({ '@e1': 'a.link', '@e2': 'button' });
  });
});
