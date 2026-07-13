import { describe, expect, it } from 'vitest';
import {
  evaluateArtifactReviews,
  inferArtifactReviewKind,
  validateArtifactReviewReceipt,
  type ArtifactReviewReceipt,
} from './artifact-review.js';

function receipt(overrides: Partial<ArtifactReviewReceipt> = {}): ArtifactReviewReceipt {
  return {
    kind: 'artifact-review-receipt',
    version: '1.0.0',
    review_id: 'review-1',
    mission_id: 'MSN-1',
    review_task_id: 'task-review',
    review_target_task_id: 'task-implement',
    artifact: {
      path: 'evidence/change.patch',
      sha256: 'a'.repeat(64),
      kind: 'code',
    },
    reviewer: {
      agent_id: 'review-agent',
      team_role: 'reviewer',
      specialist_roles: ['code-reviewer'],
      independent_from: ['implementation-agent'],
      independence_verified: true,
    },
    verdict: 'approved',
    findings: [],
    acceptance_criteria: ['The change satisfies the contract.'],
    reviewed_at: '2026-07-13T00:00:00.000Z',
    ...overrides,
  };
}

describe('artifact review contract', () => {
  it('validates a hash-bound independent review receipt', () => {
    expect(validateArtifactReviewReceipt(receipt())).toMatchObject({ valid: true, errors: [] });
  });

  it('rejects malformed receipts', () => {
    const malformed = {
      ...receipt(),
      artifact: { path: 'out.patch', sha256: 'bad', kind: 'code' },
    };
    expect(validateArtifactReviewReceipt(malformed).valid).toBe(false);
  });

  it('invalidates review after artifact change', () => {
    const review = receipt();
    const result = evaluateArtifactReviews({
      artifacts: [{ path: review.artifact.path, sha256: 'b'.repeat(64) }],
      reviews: [
        {
          review_id: review.review_id,
          artifact_path: review.artifact.path,
          artifact_sha256: review.artifact.sha256,
          reviewer_role: 'code-reviewer',
          reviewer_agent_id: 'review-agent',
          independence_verified: true,
          verdict: review.verdict,
          findings: review.findings,
        },
      ],
      requiredReviewerRoles: ['code-reviewer'],
      implementerAgentIds: ['implementation-agent'],
      requireIndependence: true,
    });
    expect(result.ready).toBe(false);
    expect(result.reasons).toContain('review review-1 was invalidated by artifact change');
  });

  it('blocks missing specialist roles, implementation-agent review, and blocking findings', () => {
    const result = evaluateArtifactReviews({
      artifacts: [{ path: 'out.md', sha256: 'a'.repeat(64) }],
      reviews: [
        {
          review_id: 'review-2',
          artifact_path: 'out.md',
          artifact_sha256: 'a'.repeat(64),
          reviewer_role: 'content-reviewer',
          reviewer_agent_id: 'implementation-agent',
          independence_verified: false,
          verdict: 'changes_requested',
          findings: [
            {
              severity: 'blocking',
              category: 'accuracy',
              description: 'Unsupported assertion.',
            },
          ],
        },
      ],
      requiredReviewerRoles: ['fact-reviewer'],
      implementerAgentIds: ['implementation-agent'],
      requireIndependence: true,
    });
    expect(result.ready).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        'review review-2 has blocking findings',
        'review review-2 has no verified reviewer independence',
        'review review-2 was performed by an implementation agent',
        'required reviewer role is missing: fact-reviewer',
      ])
    );
  });

  it('infers review kind from common artifact extensions', () => {
    expect(inferArtifactReviewKind('src/app.ts')).toBe('code');
    expect(inferArtifactReviewKind('slides/pitch.pptx')).toBe('deck');
    expect(inferArtifactReviewKind('video/final.mp4')).toBe('media');
    expect(inferArtifactReviewKind('docs/report.md')).toBe('doc');
  });
});
