import { describe, expect, it } from 'vitest';
import {
  evaluateArtifactBundleGate,
  evaluateIntentDriftReviewGate,
  resolveArtifactReviewerProfile,
  resolveMissionReviewDesign,
  summarizeReviewGateVerdicts,
} from './mission-review-gates.js';

describe('mission-review-gates', () => {
  it('selects strict mode for high-stakes stage-gated workflows', () => {
    const review = resolveMissionReviewDesign({
      missionClass: 'operations_and_release',
      deliveryShape: 'cross_system_change',
      riskProfile: 'high_stakes',
      workflowPattern: 'stage_gated_delivery',
      stage: 'preflight',
    });

    expect(review.review_mode).toBe('strict');
    expect(review.required_gate_ids).toContain('CONTRACT_VALID');
    expect(review.required_gate_ids).toContain('SECURITY_READY');
    expect(review.required_gate_ids).toContain('DELIVERABLE_QUALITY');
  });

  it('selects lean mode for low-risk workflows', () => {
    const review = resolveMissionReviewDesign({
      missionClass: 'content_and_media',
      deliveryShape: 'single_artifact',
      riskProfile: 'low',
      workflowPattern: 'single_track_execution',
      stage: 'execution',
    });

    expect(review.review_mode).toBe('lean');
    expect(review.required_gate_ids).toContain('CONTRACT_VALID');
    expect(review.required_gate_ids).not.toContain('DELIVERABLE_QUALITY');
  });

  it('selects specialist reviewer roles by artifact, mission class, and risk', () => {
    const code = resolveArtifactReviewerProfile({
      artifactKind: 'code',
      missionClass: 'code_change',
      riskProfile: 'high_stakes',
    });
    expect(code.required_reviewer_roles).toEqual(
      expect.arrayContaining(['code-reviewer', 'security-reviewer'])
    );
    expect(code.required_reviewer_capabilities).toEqual(
      expect.arrayContaining(['review', 'code', 'testing', 'security', 'analysis'])
    );
    expect(code.independence_required).toBe(true);

    const customerDeck = resolveArtifactReviewerProfile({
      artifactKind: 'deck',
      missionClass: 'customer_engagement',
      riskProfile: 'review_required',
    });
    expect(customerDeck.required_reviewer_roles).toEqual(
      expect.arrayContaining([
        'content-reviewer',
        'brand-reviewer',
        'fact-reviewer',
        'privacy-reviewer',
      ])
    );
  });

  it('aggregates gate verdicts with strictest priority', () => {
    const summary = summarizeReviewGateVerdicts({
      reviewMode: 'strict',
      results: [
        { gate_id: 'CONTRACT_VALID', verdict: 'ready' },
        { gate_id: 'QA_READY', verdict: 'concerns' },
        { gate_id: 'SECURITY_READY', verdict: 'blocked' },
      ],
    });

    expect(summary.overall_verdict).toBe('blocked');
    expect(summary.review_mode).toBe('strict');
  });

  it('evaluates artifact bundle readiness with approval consistency', () => {
    expect(
      evaluateArtifactBundleGate({
        bundle_id: 'BND-1',
        mission_id: 'MSN-1',
        status: 'assembling',
        items: [],
        fulfills_outcome_ids: [],
        required_artifact_kinds: [],
        approval: { status: 'pending' },
        created_at: '2026-06-05T00:00:00.000Z',
        updated_at: '2026-06-05T00:00:00.000Z',
      })
    ).toMatchObject({ verdict: 'concerns' });

    expect(
      evaluateArtifactBundleGate({
        bundle_id: 'BND-2',
        mission_id: 'MSN-1',
        status: 'approved',
        items: [{ artifact_id: 'ART-1', kind: 'markdown', storage_class: 'artifact_store' }],
        fulfills_outcome_ids: ['OUT-1'],
        required_artifact_kinds: ['markdown'],
        approval: { status: 'approved' },
        created_at: '2026-06-05T00:00:00.000Z',
        updated_at: '2026-06-05T00:00:00.000Z',
      })
    ).toMatchObject({ verdict: 'ready' });
  });

  it('maps intent drift snapshots into a blocking review gate when the origin baseline diverges', () => {
    const summary = summarizeReviewGateVerdicts({
      reviewMode: 'standard',
      results: [
        {
          gate_id: 'CONTRACT_VALID',
          verdict: 'ready',
        },
        {
          gate_id: 'INTENT_DRIFT',
          verdict: 'blocked',
          reason: 'intent drift blocks progression (score=80, threshold=50)',
        },
      ],
    });

    expect(summary.overall_verdict).toBe('blocked');
    expect(summary.gate_results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gate_id: 'INTENT_DRIFT',
          verdict: 'blocked',
        }),
      ])
    );
  });

  it('evaluates intent drift as a review gate result', () => {
    const gate = evaluateIntentDriftReviewGate('MSN-UNKNOWN');

    expect(gate).toMatchObject({
      gate_id: 'INTENT_DRIFT',
      verdict: 'ready',
    });
  });
});
