import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NeedsYouLink } from './needs-you-link';

describe('NeedsYouLink (replaces duplicate decision UIs)', () => {
  it('links to the filtered /inbox and offers no decision buttons', () => {
    const markup = renderToStaticMarkup(
      React.createElement(NeedsYouLink, { reason: 'review', locale: 'ja' })
    );
    expect(markup).toContain('href="/inbox?reason=review"');
    expect(markup).toContain('あなた待ちで判断する');
    expect(markup).not.toContain('承認する');
  });

  it('accepts any surface locale and falls back to a Concierge one', () => {
    const markup = renderToStaticMarkup(
      React.createElement(NeedsYouLink, { locale: 'en-US', lead: false })
    );
    expect(markup).toContain('href="/inbox"');
    expect(markup).toContain('Decide in Needs you');
  });
});
