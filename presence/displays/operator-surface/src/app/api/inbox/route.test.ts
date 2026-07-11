import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  acceptInboxEntryWithHumanReceipt: vi.fn(),
  markInboxEntry: vi.fn(),
}));

vi.mock('@agent/core', () => ({
  acceptInboxEntryWithHumanReceipt: mocks.acceptInboxEntryWithHumanReceipt,
  markInboxEntry: mocks.markInboxEntry,
}));

import { POST } from './route.js';

describe('operator-surface inbox route', () => {
  it('marks inbox entries as accepted via form data', async () => {
    mocks.acceptInboxEntryWithHumanReceipt.mockReturnValue({
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
    expect(mocks.acceptInboxEntryWithHumanReceipt).toHaveBeenCalledWith({
      entryId: 'INBOX-1',
      actorId: 'human:operator-surface',
      authenticated: true,
      authMethod: 'surface_session',
      responsibilityStatement: 'I accept this deliverable on behalf of the operator.',
    });
  });
});
