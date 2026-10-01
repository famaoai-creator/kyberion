import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../lib/use-concierge-i18n', () => ({ useConciergeI18n: () => ({ locale: 'en' }) }));
import { ReviewCheckin } from './review-checkin';

describe('read-only review initial UI contract', () => {
  it('is idle by default and explains bounded lifetime with explicit start controls', () => {
    const markup = renderToStaticMarkup(React.createElement(ReviewCheckin, { tenant: 'acme' }));
    expect(markup).toContain('Checks are off');
    expect(markup).toContain('only while this page stays open');
    expect(markup).toContain('No operations are performed');
    expect(markup).toContain('Check now');
    expect(markup).toContain('Enable checks for one hour');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('href="/settings#settings-recording"');
    expect(markup).not.toContain('pendingCount');
  });
  it.each(['all', '__no_tenant__', ''])(
    'does not start without a concrete selected tenant: %s',
    (tenant) => {
      const markup = renderToStaticMarkup(React.createElement(ReviewCheckin, { tenant }));
      expect(markup).toContain('Select one organization');
      expect(markup.match(/disabled=""/g)).toHaveLength(2);
    }
  );
});
