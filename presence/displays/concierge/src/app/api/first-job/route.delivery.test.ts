import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FIRST_JOB_TENANT,
  decide,
  fj,
  heldRequest,
  read,
  readArtifact,
  standalone,
  start,
  tearDownFirstJob,
  setUpFirstJob,
  type Body,
} from '../../../../test/first-job-route-harness';

// 初めての仕事 delivery on its own installation (test/first-job-route-harness.ts):
// start, the owner's approval, the operator tick and the delivered receipt.
beforeAll(() => setUpFirstJob(), 120_000);
afterAll(() => tearDownFirstJob());

describe('concierge /api/first-job delivery', { timeout: 120_000 }, () => {
  it('starts, decides, delivers and shows the receipt, then repeats safely', async () => {
    const { session, requestId, card } = await heldRequest();
    expect(card).toMatchObject({ request_id: requestId, revision: 1, tenant: FIRST_JOB_TENANT });

    // A replay of the same request id is history, not a second request.
    const replay = await start({ action: 'start', request_id: requestId, session_id: session });
    expect(replay.body).toMatchObject({ ok: true, replayed: true, mode: 'history' });

    const decided = await decide(card.approval_request_id, {
      decision: 'approved',
      display_digest: card.display_digest,
      session_id: session,
    });
    expect(decided.status).toBe(200);
    expect(decided.body).toEqual({
      ok: true,
      approval_request_id: card.approval_request_id,
      status: 'approved',
    });
    const again = await decide(card.approval_request_id, {
      decision: 'approved',
      display_digest: card.display_digest,
      session_id: session,
    });
    expect(again.status).toBe(409);
    expect(again.body.retry_safe).toBe(true);

    expect((await standalone(() => fj.operator.tickFirstJob(FIRST_JOB_TENANT))).outcome).toBe(
      'artifact_verified'
    );
    const snapshot = (await read('?session_id=' + session)).body;
    const delivered = snapshot.tasks.find((task: Body) => task.id === requestId);
    expect(delivered.artifact).toMatchObject({ verification: 'verified', revision: 1 });
    const receipt = await readArtifact(
      `session_id=${session}&request_id=${requestId}&revision=1&sha256=${delivered.artifact.sha256}`
    );
    expect(receipt.status).toBe(200);
    expect(receipt.headers.get('x-content-type-options')).toBe('nosniff');
    expect(receipt.body).toMatchObject({ ok: true, sessionId: session });
    expect(typeof receipt.body.artifact.body).toBe('string');
    expect(receipt.body.artifact.body.length).toBeGreaterThan(0);

    // Another owner's session id, a wrong digest or another member: no receipt.
    const missing = await readArtifact(
      `session_id=concierge-${'0'.repeat(64)}&request_id=${requestId}&revision=1&sha256=${delivered.artifact.sha256}`
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('first_job_artifact_unavailable');
    const stranger = await readArtifact(
      `session_id=${session}&request_id=${requestId}&revision=1&sha256=${delivered.artifact.sha256}`,
      { token: fj.otherToken }
    );
    expect(stranger.status).toBe(403);
    expect(stranger.body.artifact).toBeUndefined();
  });
});
