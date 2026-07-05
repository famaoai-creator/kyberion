import { describe, expect, it } from 'vitest';
import { loadArtifactRecord, saveArtifactRecord } from '@agent/core/artifact-record';
import { loadDeliverableReviewState, reviewDeliverable } from './deliverable-review';

describe('deliverable review', () => {
  it('creates a new version when request-changes is submitted', () => {
    const artifactId = `ART-REVIEW-${Date.now()}`;
    saveArtifactRecord({
      artifact_id: artifactId,
      mission_id: 'MSN-REVIEW',
      kind: 'report',
      storage_class: 'repo',
      preview_text: 'initial draft',
    });

    const result = reviewDeliverable({
      artifactId,
      verdict: 'request-changes',
      comment: 'tighten the scope',
      reviewer: 'tester',
      reviewRole: 'mission_controller',
    });
    const nextArtifactId = result.review.new_artifact_id!;
    const accepted = reviewDeliverable({
      artifactId: nextArtifactId,
      verdict: 'accept',
      reviewer: 'tester',
      reviewRole: 'mission_controller',
    });

    expect(result.review.verdict).toBe('request-changes');
    expect(result.review.new_artifact_id).toBeDefined();
    expect(result.state.latest_review_sequence).toBe(2);
    expect(result.state.latest_artifact_version).toBe(2);
    expect(result.state.latest_version).toBe(2);
    expect(accepted.state.latest_review_sequence).toBe(3);
    expect(accepted.state.latest_artifact_version).toBe(2);
    expect(loadArtifactRecord(nextArtifactId)).toBeTruthy();
    expect(loadDeliverableReviewState(artifactId)?.reviews).toHaveLength(2);
  });
});
