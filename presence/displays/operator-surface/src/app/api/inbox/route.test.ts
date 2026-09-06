import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  acceptInboxEntryWithHumanReceipt: vi.fn(),
  markInboxEntry: vi.fn(),
}));

vi.mock('@agent/core/deliverable-inbox', () => ({
  acceptInboxEntryWithHumanReceipt: mocks.acceptInboxEntryWithHumanReceipt,
  markInboxEntry: mocks.markInboxEntry,
}));

vi.mock('@agent/core/surface-mutation-guard', () => ({
  authorizeSurfaceMutation: () => ({ ok: true }),
}));

import { POST } from './route.js';

describe('operator-surface inbox route', () => {
  beforeEach(() => {
    mocks.acceptInboxEntryWithHumanReceipt.mockReset();
    mocks.markInboxEntry.mockReset();
  });

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

  it.each([
    ['malformed JSON', '{'],
    ['null JSON', 'null'],
    ['array JSON', '[]'],
  ])('returns 400 for %s before inbox mutation', async (_label, body) => {
    const response = await POST(
      new Request('http://localhost/api/inbox', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }) as unknown as Parameters<typeof POST>[0]
    );

    expect(response.status).toBe(400);
    expect(mocks.acceptInboxEntryWithHumanReceipt).not.toHaveBeenCalled();
    expect(mocks.markInboxEntry).not.toHaveBeenCalled();
  });

  it('rejects file form values instead of coercing them into identifiers', async () => {
    const form = new FormData();
    form.append('entry_id', new File(['not-an-id'], 'entry.txt'));
    form.append('status', 'accepted');

    const response = await POST(
      new Request('http://localhost/api/inbox', {
        method: 'POST',
        body: form,
      }) as unknown as Parameters<typeof POST>[0]
    );

    expect(response.status).toBe(400);
    expect(mocks.acceptInboxEntryWithHumanReceipt).not.toHaveBeenCalled();
  });
});
