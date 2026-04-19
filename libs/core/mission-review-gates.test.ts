import { describe, expect, it } from 'vitest';
import { resolveMissionReviewDesign, summarizeReviewGateVerdicts } from './mission-review-gates.js';

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
});
