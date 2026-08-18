import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeRmSync } from './secure-io.js';
import {
  assessServiceDistillCandidate,
  buildServiceProcedureCandidate,
} from './service-distill-candidate.js';
import { loadDistillCandidateRecord } from './distill-candidate-registry.js';

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
  const candidateIds: string[] = [];

  afterEach(() => {
    for (const candidateId of candidateIds.splice(0)) {
      safeRmSync(pathResolver.shared(`runtime/distill-candidates/${candidateId}.json`), {
        force: true,
      });
    }
  });

  it('persists a scoped, review-only service procedure candidate', () => {
    const result = buildServiceProcedureCandidate(recording, {
      procedureId: 'service.issue-intake.candidate-test',
      intentPhrases: ['create an issue'],
      recordingRef: 'active/shared/runtime/recordings/svc-distill-candidate-test.json',
      missionId: 'MSN-SERVICE-CANDIDATE',
      tenantSlug: 'acme-corp',
      tier: 'confidential',
    });
    candidateIds.push(result.candidate.candidate_id);

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
    });
    expect(loadDistillCandidateRecord(result.candidate.candidate_id)?.candidate_id).toBe(
      result.candidate.candidate_id
    );
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
