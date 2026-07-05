import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  markInboxEntry: vi.fn(),
}));

vi.mock('@agent/core', () => ({
  markInboxEntry: mocks.markInboxEntry,
}));

import { POST } from './route.js';

describe('operator-surface inbox route', () => {
  it('marks inbox entries as accepted via form data', async () => {
    mocks.markInboxEntry.mockReturnValue({
      entry_id: 'INBOX-1',
      status: 'accepted',
    });

    const response = await POST(
      new Request('http://localhost/api/inbox', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ entry_id: 'INBOX-1', status: 'accepted' }),
      }) as any
    );

    expect(response.status).toBe(303);
    expect(mocks.markInboxEntry).toHaveBeenCalledWith('INBOX-1', 'accepted');
  });
});
