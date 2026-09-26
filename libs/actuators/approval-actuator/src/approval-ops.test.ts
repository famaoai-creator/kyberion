import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createApprovalRequest: vi.fn(),
  listApprovalRequests: vi.fn(),
}));

vi.mock('@agent/core/governance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/governance')>()),
  createApprovalRequest: mocks.createApprovalRequest,
  listApprovalRequests: mocks.listApprovalRequests,
}));

import { requestReviewOp } from './approval-ops.js';

const past = () => new Date(Date.now() - 60_000).toISOString();
const future = () => new Date(Date.now() + 60_000).toISOString();

describe('requestReviewOp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createApprovalRequest.mockReturnValue({ id: 'REV-FRESH' });
  });

  it('deduplicates onto a live approval', () => {
    mocks.listApprovalRequests.mockReturnValue([
      { id: 'REV-1', correlationId: 'k', status: 'approved', expiresAt: future() },
    ]);
    expect(requestReviewOp({ topic: 't', idempotency_key: 'k' })).toMatchObject({
      status: 'approved',
      request_id: 'REV-1',
      deduplicated: true,
    });
    expect(mocks.createApprovalRequest).not.toHaveBeenCalled();
  });

  it('never reports a lapsed or malformed-expiry approval as approved', () => {
    for (const expiresAt of [past(), 'not-a-date']) {
      mocks.listApprovalRequests.mockReturnValue([
        { id: 'REV-OLD', correlationId: 'k', status: 'approved', expiresAt },
      ]);
      expect(requestReviewOp({ topic: 't', idempotency_key: 'k' }), expiresAt).toMatchObject({
        status: 'pending',
        request_id: 'REV-FRESH',
      });
    }
    expect(mocks.createApprovalRequest).toHaveBeenCalledTimes(2);
  });
});
