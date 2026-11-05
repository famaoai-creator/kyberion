import { describe, expect, it } from 'vitest';
import { inboxHref, parseInboxFilters } from './needs-you-client';

describe('inbox URL filter state', () => {
  it('reads known reasons and the overdue flag, ignoring anything else', () => {
    expect(parseInboxFilters(new URLSearchParams('reason=approval&overdue=1'))).toEqual({
      reason: 'approval',
      overdue: true,
    });
    expect(parseInboxFilters(new URLSearchParams('reason=everything&overdue=yes'))).toEqual({
      overdue: false,
    });
  });

  it('writes filters back and keeps the shell scope in the query', () => {
    expect(inboxHref({ reason: 'review', overdue: true })).toBe('/inbox?reason=review&overdue=1');
    expect(inboxHref({ overdue: false }, new URLSearchParams('tenant=famao-ai&reason=x'))).toBe(
      '/inbox?tenant=famao-ai'
    );
  });
});
