import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FIRST_JOB_TENANT,
  decide,
  fj,
  heldRequest,
  read,
  readApprovals,
  rotateSessionKey,
  setUpFirstJob,
  tearDownFirstJob,
  terminate,
  type Body,
} from '../../../../test/first-job-route-harness';

// 初めての仕事 decisions that are refused, and recovery of a request whose
// approval can no longer be verified, on its own installation
// (test/first-job-route-harness.ts).
beforeAll(() => setUpFirstJob(), 120_000);
afterAll(() => tearDownFirstJob());

describe('concierge /api/first-job decisions and recovery', { timeout: 120_000 }, () => {
  it('refuses a decision on a request that is not this viewer’s, then offers recovery for an approval it can no longer verify', async () => {
    const { session, requestId, card } = await heldRequest();
    // An approval in the same store that belongs to someone else's work.
    const foreign = fj.authority.withExecutionContext('infrastructure_sentinel', () =>
      fj.approvals.createApprovalRequest('infrastructure_sentinel', {
        channel: 'inbox',
        storageChannel: 'autonomy',
        threadTs: '',
        correlationId: 'foreign',
        requestedBy: 'dot:someone-else',
        draft: { title: 'Another request', summary: 'Not this diagnostic' },
      })
    );
    const refused = await decide(foreign.id, {
      decision: 'approved',
      display_digest: card.display_digest,
      session_id: session,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('first_job_approval_unavailable');
    expect(fj.approvals.loadApprovalRequest('autonomy', foreign.id)?.status).toBe('pending');
    // Another conversation's session id never reaches this viewer's request.
    const otherSession = await decide(card.approval_request_id, {
      decision: 'approved',
      display_digest: card.display_digest,
      session_id: 'concierge-' + 'f'.repeat(64),
    });
    expect(otherSession.status).toBe(409);
    expect(otherSession.body.error).toBe('first_job_scope_changed');
    // Another member, even with a valid session and the exact digest.
    const stranger = await decide(
      card.approval_request_id,
      { decision: 'approved', display_digest: card.display_digest, session_id: session },
      { token: fj.otherToken }
    );
    expect(stranger.status).toBe(403);
    expect(stranger.body.error).toBe('first_job_access_denied');
    // Carried over from Studio's route boundary: no injected authority field,
    // and an explicit forged bearer never falls back to the valid cookie.
    for (const field of [
      'authenticated',
      'memberId',
      'decidedBy',
      'token',
      'effect_binding',
      'note',
    ]) {
      const injected = await decide(card.approval_request_id, {
        decision: 'approved',
        display_digest: card.display_digest,
        session_id: session,
        [field]: 'spoof',
      });
      expect(injected.status, field).toBe(400);
      expect(injected.body.error).toBe('first_job_invalid_request');
    }
    const forged = await decide(
      card.approval_request_id,
      { decision: 'approved', display_digest: card.display_digest, session_id: session },
      { headers: { authorization: 'Bearer kys1.forged.fake' } }
    );
    expect(forged.status).toBe(401);
    expect(fj.approvals.loadApprovalRequest('autonomy', card.approval_request_id)?.status).toBe(
      'pending'
    );
    expect(
      (
        await decide(card.approval_request_id, {
          decision: 'approved',
          display_digest: card.display_digest,
          session_id: session,
        })
      ).status
    ).toBe(200);
    // The browser-session key rotates before the next tick: the signed
    // decision can no longer be verified, so the request is held.
    rotateSessionKey();
    const listed = await readApprovals(session);
    expect(listed.status).toBe(200);
    expect(listed.body.approvals).toEqual([]);
    const candidate = listed.body.recovery_requests.find(
      (row: Body) => row.request_id === requestId
    );
    expect(candidate).toMatchObject({
      status: 'eligible',
      session_id: session,
      tenant: FIRST_JOB_TENANT,
    });
    expect(listed.body.held_requests.some((row: Body) => row.request_id === requestId)).toBe(false);

    const crossOrigin = await terminate(
      requestId,
      {
        action: 'terminate_unstarted',
        session_id: session,
        display_digest: candidate.display_digest,
      },
      { origin: 'http://evil.example' }
    );
    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.body).toMatchObject({
      error: 'first_job_origin_denied',
      retry_safe: true,
    });
    for (const field of ['tenant', 'authenticated', 'memberId', 'token', 'reason', 'request_id']) {
      const injected = await terminate(requestId, {
        action: 'terminate_unstarted',
        session_id: session,
        display_digest: candidate.display_digest,
        [field]: 'spoof',
      });
      expect(injected.status, field).toBe(400);
    }
    expect(JSON.stringify(listed.body)).not.toContain('recoveryReceipt');
    const strangerRecovery = await terminate(
      requestId,
      {
        action: 'terminate_unstarted',
        session_id: session,
        display_digest: candidate.display_digest,
      },
      { token: fj.otherToken }
    );
    expect(strangerRecovery.status).toBe(403);
    expect(strangerRecovery.body).toMatchObject({
      error: 'first_job_access_denied',
      retry_safe: false,
    });

    const ended = await terminate(requestId, {
      action: 'terminate_unstarted',
      session_id: session,
      display_digest: candidate.display_digest,
    });
    expect(ended.status).toBe(200);
    expect(ended.body).toEqual({
      ok: true,
      request_id: requestId,
      status: 'terminated_unstarted',
    });
    const after = await readApprovals(session);
    expect(
      after.body.recovery_requests.find((row: Body) => row.request_id === requestId)
    ).toMatchObject({ status: 'terminated_unstarted' });
    const task = (await read('?session_id=' + session)).body.tasks.find(
      (row: Body) => row.id === requestId
    );
    expect(task.executionStatus).toBe('terminated_unstarted');
  });
});
