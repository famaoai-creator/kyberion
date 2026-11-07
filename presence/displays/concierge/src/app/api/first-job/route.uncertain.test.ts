import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  decide,
  fj,
  heldRequest,
  readApprovals,
  rotateSessionKey,
  setUpFirstJob,
  tearDownFirstJob,
  terminate,
  type Body,
} from '../../../../test/first-job-route-harness';

// 初めての仕事 outcomes the route cannot confirm (carried over from the core
// approval / recovery tests' Studio HTTP cases), on its own installation
// (test/first-job-route-harness.ts). Narrow spies on the real core writers,
// installed only for the request under test: a crashed decision write, a
// decision whose post-write readback cannot be found, and a recovery that
// crashes after its terminal receipt.
beforeAll(() => setUpFirstJob(), 120_000);
afterAll(() => tearDownFirstJob());
afterEach(() => vi.restoreAllMocks());

describe('concierge /api/first-job uncertain outcomes', { timeout: 120_000 }, () => {
  it('reports crashed and unconfirmed writes as uncertain, unsafe to retry and without their cause', async () => {
    const { session, requestId, card } = await heldRequest();
    const body = { decision: 'approved', display_digest: card.display_digest, session_id: session };

    // 1. The decision write crashes: unknown outcome, the cause stays in the log.
    const store = fj.approvals;
    const write = vi.spyOn(store, 'decideApprovalRequest').mockImplementation(() => {
      throw new Error('PRIVATE /private/secret-path decision crash');
    });
    const crashed = await decide(card.approval_request_id, body);
    write.mockRestore();
    expect(crashed.status).toBe(503);
    expect(crashed.body).toMatchObject({
      ok: false,
      error: 'first_job_decision_uncertain',
      retry_safe: false,
    });
    expect(crashed.body.correlation_id).toEqual(expect.any(String));
    expect(JSON.stringify(crashed.body)).not.toMatch(/PRIVATE|private/);
    expect(fj.approvals.loadApprovalRequest('autonomy', card.approval_request_id)?.status).toBe(
      'pending'
    );

    // 2. The decision is written but its readback is missing (HEAD
    //    first-job-approval.test.ts "failed post-write readback").
    const load = store.loadApprovalRequest;
    let written = false;
    const real = store.decideApprovalRequest;
    const writeSpy = vi
      .spyOn(store, 'decideApprovalRequest')
      .mockImplementation((...args: Parameters<typeof real>) => {
        written = true;
        return real(...args);
      });
    const readSpy = vi
      .spyOn(store, 'loadApprovalRequest')
      .mockImplementation((...args: Parameters<typeof load>) => (written ? null : load(...args)));
    const unread = await decide(card.approval_request_id, body);
    writeSpy.mockRestore();
    readSpy.mockRestore();
    expect(unread.status).toBe(503);
    expect(unread.body).toMatchObject({ error: 'first_job_decision_uncertain', retry_safe: false });
    expect(JSON.stringify(unread.body)).not.toMatch(/private|knowledge\/|active\//);
    expect(fj.approvals.loadApprovalRequest('autonomy', card.approval_request_id)?.status).toBe(
      'approved'
    );

    // 3. The approval can no longer be verified, and its recovery crashes
    //    after the terminal receipt (HEAD first-job-recovery.test.ts
    //    "redacts private failure paths and marks post-write failure uncertain").
    rotateSessionKey();
    const candidate = (await readApprovals(session)).body.recovery_requests.find(
      (row: Body) => row.request_id === requestId
    );
    expect(candidate).toMatchObject({ status: 'eligible' });
    const dispatch = await import('@agent/core/dot/dot-dispatch');
    vi.spyOn(dispatch, 'declineRecoveredDotAction').mockImplementation(() => {
      throw new Error('PRIVATE /private/crash-after-tombstone');
    });
    const ended = await terminate(requestId, {
      action: 'terminate_unstarted',
      session_id: session,
      display_digest: candidate.display_digest,
    });
    expect(ended.status).toBe(503);
    expect(ended.body).toMatchObject({ error: 'first_job_recovery_uncertain', retry_safe: false });
    expect(JSON.stringify(ended.body)).not.toMatch(/PRIVATE|crash-after-tombstone/);
    expect(fj.approvals.loadApprovalRequest('autonomy', card.approval_request_id)?.status).toBe(
      'approved'
    );
  });
});
