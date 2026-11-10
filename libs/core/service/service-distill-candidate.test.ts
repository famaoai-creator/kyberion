import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { withExecutionContext } from '../authority.js';
import { pathResolver } from '../path-resolver.js';
import { safeRmSync } from '../secure-io.js';
import {
  assessServiceDistillCandidate,
  buildServiceProcedureCandidate,
} from './service-distill-candidate.js';
import {
  loadFacadeProposal,
  type FacadeProposalRecord,
} from '../knowledge/facade-proposal-rows.js';
import { memoryPromotionQueuePath } from '../knowledge/memory-promotion-queue.js';
import { SERVICE_PROCEDURE_PROPOSAL } from '../knowledge/reuse-proposals.js';

const queuePath = `active/shared/tmp/test-memory-queue-service-distill-${process.pid}.jsonl`;
const originalQueuePath = process.env.KYBERION_MEMORY_QUEUE_PATH;
beforeAll(() => {
  process.env.KYBERION_MEMORY_QUEUE_PATH = queuePath;
});
afterAll(() => {
  if (originalQueuePath === undefined) delete process.env.KYBERION_MEMORY_QUEUE_PATH;
  else process.env.KYBERION_MEMORY_QUEUE_PATH = originalQueuePath;
});

const recording = {
  schema_version: 'service-recording.v1',
  recording_id: 'svc-distill-candidate-test',
  source: 'service-capture',
  created_at: '2026-08-17T00:00:00.000Z',
  target: { name: 'Issue intake', services: ['github'] },
  steps: [
    {
      step_id: 'step-001',
      service_id: 'github',
      action: 'create_issue',
      summary: 'Create issue',
      risk_class: 'high',
      params: { owner: 'famaoai', repo: 'kyberion', title: '{{input.title}}' },
    },
  ],
  risk_summary: { requires_manual_review: true, approval_required_count: 1 },
};

describe('service-distill-candidate', () => {
  const candidates: FacadeProposalRecord[] = [];
  const load = (id: string, scope?: FacadeProposalRecord['scope']) =>
    loadFacadeProposal(SERVICE_PROCEDURE_PROPOSAL, id, scope);

  afterEach(() => {
    withExecutionContext('surface_runtime', () => {
      // A personal owner queue is never redirected by the test override.
      for (const candidate of candidates.splice(0))
        if (candidate.scope?.tier === 'personal')
          safeRmSync(memoryPromotionQueuePath(candidate.scope), { force: true });
      safeRmSync(pathResolver.rootResolve(queuePath), { force: true });
    });
  });

  it('captures a scoped, review-only service procedure candidate on the queue', () => {
    const result = buildServiceProcedureCandidate(recording, {
      procedureId: 'service.issue-intake.candidate-test',
      intentPhrases: ['create an issue'],
      recordingRef: 'active/shared/runtime/recordings/svc-distill-candidate-test.json',
      missionId: 'MSN-SERVICE-CANDIDATE',
      tenantSlug: 'acme-corp',
      tier: 'confidential',
    });
    candidates.push(result.candidate);

    expect(result.preflight.ok).toBe(true);
    expect(result.pipeline._draft).toBe(true);
    expect(result.pipeline.steps[0]).toMatchObject({ op: 'core:await_decision' });
    expect(result.candidate).toMatchObject({
      source_type: 'mission',
      status: 'proposed',
      target_kind: 'procedure',
      scope: {
        tier: 'confidential',
        tenant_slug: 'acme-corp',
        mission_id: 'MSN-SERVICE-CANDIDATE',
        promotion_policy: 'human_review',
      },
      metadata: { executable: false, review_required: true, promotion_state: 'review_required' },
      record_kind: 'service_procedure',
      decided_via: 'concierge',
    });
    expect(
      load(result.candidate.candidate_id, {
        ...result.candidate.scope!,
        tenant_slug: 'other-tenant',
      })
    ).toBeNull();
    expect(load(result.candidate.candidate_id, result.candidate.scope)?.candidate_id).toBe(
      result.candidate.candidate_id
    );
  });

  it('refuses an owner-less personal candidate instead of capturing it unscoped', () => {
    expect(() =>
      buildServiceProcedureCandidate(recording, { intentPhrases: ['create an issue'] })
    ).toThrow('MEMORY_SCOPE_REQUIRED');
  });

  it('preserves a personal owner-only service candidate without inventing a tenant', () => {
    const result = buildServiceProcedureCandidate(recording, {
      intentPhrases: ['create an issue'],
      tier: 'personal',
      ownerNhi: 'nhi:service-owner',
    });
    candidates.push(result.candidate);
    expect(result.candidate.scope?.tenant_slug).toBeUndefined();
    expect(load(result.candidate.candidate_id, result.candidate.scope)?.candidate_id).toBe(
      result.candidate.candidate_id
    );
    expect(
      load(result.candidate.candidate_id, {
        ...result.candidate.scope!,
        owner_nhi: 'nhi:other-owner',
      })
    ).toBeNull();
  });

  it('rejects recordings with observation validation errors before persistence', () => {
    const invalidObservation = {
      ...recording,
      steps: [{ ...recording.steps[0], validation_errors: ['missing required field'] }],
    };
    expect(
      assessServiceDistillCandidate({
        recording: invalidObservation,
        intentPhrases: ['create an issue'],
      })
    ).toMatchObject({
      eligible: false,
      targetKind: 'procedure',
    });
    expect(() =>
      buildServiceProcedureCandidate(invalidObservation, {
        procedureId: 'service.issue-intake.invalid-observation',
        intentPhrases: ['create an issue'],
      })
    ).toThrow('observation validation errors');
  });

  it('refuses public scope until a brokered publication flow exists', () => {
    expect(() =>
      buildServiceProcedureCandidate(recording, {
        procedureId: 'service.issue-intake.public-test',
        intentPhrases: ['create an issue'],
        tier: 'public',
      })
    ).toThrow('public scope');
  });
});
