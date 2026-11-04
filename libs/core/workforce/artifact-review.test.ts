import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertValidArtifactReviewReceipt,
  buildArtifactReviewReceipt,
  evaluateArtifactReviews,
  hashArtifactForReview,
  inferArtifactReviewKind,
  loadArtifactReviewReceipt,
  receiptToArtifactReviewDecision,
  validateArtifactReviewReceipt,
  type ArtifactReviewReceipt,
  type ArtifactReviewIndependencePolicy,
} from './artifact-review.js';
import * as pathResolver from '../path-resolver.js';
import { safeRmSync, safeWriteFile } from '../secure-io.js';

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
  const evaluate = (options: Partial<Parameters<typeof evaluateArtifactReviews>[0]> = {}) => {
    const value = receipt();
    return evaluateArtifactReviews({
      artifacts: [value.artifact],
      reviews: [receiptToArtifactReviewDecision(value)],
      requiredReviewerRoles: ['code-reviewer'],
      implementerAgentIds: ['implementation-agent'],
      requireIndependence: true,
      ...options,
    });
  };

  it('preserves legacy receipt readability and admission without claiming authenticated assurance', () => {
    const legacy = JSON.parse(JSON.stringify(receipt()));
    expect(validateArtifactReviewReceipt(legacy).valid).toBe(true);
    expect(evaluate({ reviews: [receiptToArtifactReviewDecision(legacy)] })).toMatchObject({
      ready: true,
      reasons: [],
      independence_assurance: 'legacy_actor_claim',
    });
    expect(evaluate({ independencePolicy: 'legacy_actor_claim' })).toEqual(evaluate());
  });

  it.each([undefined, false, true])(
    'strict policy fails closed regardless of requireIndependence=%s',
    (requireIndependence) => {
      expect(
        evaluate({ independencePolicy: 'authenticated_execution', requireIndependence })
      ).toMatchObject({
        ready: false,
        reasons: ['authenticated reviewer execution provenance is unavailable'],
        independence_assurance: 'unverified',
      });
    }
  );

  it.each(['unknown', '', null])(
    'rejects unsupported policy %s instead of falling back',
    (policy) => {
      expect(
        evaluate({
          independencePolicy: policy as ArtifactReviewIndependencePolicy,
          requireIndependence: false,
        })
      ).toMatchObject({
        ready: false,
        reasons: ['unsupported artifact review independence policy'],
        independence_assurance: 'unverified',
      });
    }
  );

  it('does not vacuously grant strict independence for empty evidence', () => {
    expect(
      evaluate({
        artifacts: [],
        reviews: [],
        requiredReviewerRoles: [],
        independencePolicy: 'authenticated_execution',
      })
    ).toMatchObject({ ready: false, independence_assurance: 'unverified' });
    expect(evaluate({ artifacts: [], reviews: [], requiredReviewerRoles: [] })).toMatchObject({
      independence_assurance: 'unverified',
    });
  });

  it('labels non-independent and independence-not-requested evaluations accurately', () => {
    const decision = receiptToArtifactReviewDecision(receipt());
    expect(evaluate({ reviews: [{ ...decision, independence_verified: false }] })).toMatchObject({
      ready: false,
      independence_assurance: 'unverified',
    });
    expect(
      evaluate({ reviews: [{ ...decision, reviewer_agent_id: 'implementation-agent' }] })
    ).toMatchObject({ ready: false, independence_assurance: 'unverified' });
    expect(evaluate({ requireIndependence: false })).toMatchObject({
      ready: true,
      independence_assurance: 'not_required',
    });
  });

  it.each([
    ['alias-a', 'alias-b', 'runtime-shared'],
    ['kyberion://agent/fixture/producer', 'kyberion://agent/fixture/reviewer', 'runtime-shared'],
    ['kyberion://agent/fixture/actor', 'kyberion://agent/fixture/actor', 'runtime-new'],
    ['kyberion://agent/fixture/producer', 'kyberion://agent/fixture/reviewer', undefined],
  ])(
    'never upgrades actor or runtime claims to proof (%s, %s, %s)',
    (producer, reviewer, runtime) => {
      const decision = {
        ...receiptToArtifactReviewDecision(receipt()),
        reviewer_agent_id: reviewer,
        independence_verified: true,
        // Extra JS input fields must not become a trusted attestation pathway.
        independence_assurance: 'authenticated_execution',
        execution_provenance: {
          authenticated: true,
          canonical_actor_id: reviewer,
          runtime_id: runtime,
          accountable_human_id: 'user:shared-owner',
          session_id: 'claimed-session',
        },
      };
      expect(
        evaluate({
          reviews: [decision],
          implementerAgentIds: [producer],
          independencePolicy: 'authenticated_execution',
        })
      ).toMatchObject({ ready: false, independence_assurance: 'unverified' });
    }
  );

  it('builds verdict and reviewer independence from structured findings', () => {
    const built = buildArtifactReviewReceipt({
      reviewId: 'review-built',
      missionId: 'MSN-1',
      reviewTaskId: 'task-review',
      reviewTargetTaskId: 'task-implement',
      artifact: { path: 'src/change.ts', sha256: 'a'.repeat(64), kind: 'code' },
      reviewerAgentId: 'review-agent',
      reviewerTeamRole: 'reviewer',
      specialistRoles: ['code-reviewer'],
      independentFrom: ['implementation-agent'],
      findings: [
        {
          severity: 'blocking',
          category: 'correctness',
          description: 'The error path is not handled.',
          required_action: 'Handle the error path.',
        },
      ],
      acceptanceCriteria: ['All error paths are handled.'],
      reviewedAt: '2026-07-13T00:00:00.000Z',
    });

    expect(built).toMatchObject({
      verdict: 'changes_requested',
      reviewer: { independence_verified: true },
    });
    expect(validateArtifactReviewReceipt(built).valid).toBe(true);
  });

  it('refuses to record findings the receipt schema would reject (severity "major" is not blocking)', () => {
    // A free-form severity used to be written anyway: verdict computed as
    // approved, receipt unloadable, review task silently never satisfied.
    const invalid = receipt({
      findings: [{ severity: 'major', summary: 'stale output collected' }] as never,
    });
    expect(() => assertValidArtifactReviewReceipt(invalid)).toThrow(
      /ARTIFACT_REVIEW_INVALID[\s\S]*findings\/0\/severity[\s\S]*"severity":"blocking"\|"suggestion"/
    );
    expect(() =>
      assertValidArtifactReviewReceipt(
        receipt({
          findings: [{ severity: 'suggestion', category: 'tests', description: 'Add a case.' }],
        })
      )
    ).not.toThrow();
  });

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

  it('blocks when any artifact lacks a hash-matching review', () => {
    const result = evaluateArtifactReviews({
      artifacts: [
        { path: 'video.mp4', sha256: 'a'.repeat(64) },
        { path: 'thumbnail.png', sha256: 'b'.repeat(64) },
      ],
      reviews: [
        {
          review_id: 'review-video',
          artifact_path: 'video.mp4',
          artifact_sha256: 'a'.repeat(64),
          reviewer_role: 'content-reviewer',
          verdict: 'approved',
          findings: [],
        },
      ],
      requiredReviewerRoles: ['content-reviewer'],
    });

    expect(result.ready).toBe(false);
    expect(result.reasons).toContain('artifact has no current review: thumbnail.png');
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

  it('rejects symlinked artifact and receipt paths before reading them', () => {
    const boundaryRoot = pathResolver.sharedTmp('artifact-review-boundary');
    const targetRoot = nodePath.join(boundaryRoot, 'target');
    const linkedRoot = nodePath.join(boundaryRoot, 'linked');
    const artifactPath = nodePath.join(targetRoot, 'artifact.txt');
    const receiptPath = nodePath.join(targetRoot, 'receipt.json');
    fs.mkdirSync(targetRoot, { recursive: true });
    safeWriteFile(artifactPath, 'artifact');
    safeWriteFile(receiptPath, JSON.stringify(receipt()));
    fs.symlinkSync(targetRoot, linkedRoot, 'dir');

    try {
      expect(() => hashArtifactForReview(nodePath.join(linkedRoot, 'artifact.txt'))).toThrow(
        '[RESOURCE_PATH_SYMLINK]'
      );
      expect(() => loadArtifactReviewReceipt(nodePath.join(linkedRoot, 'receipt.json'))).toThrow(
        '[RESOURCE_PATH_SYMLINK]'
      );
      expect(fs.existsSync(artifactPath)).toBe(true);
    } finally {
      safeRmSync(boundaryRoot, { recursive: true, force: true });
    }
  });

  it('rejects directory artifact and receipt paths before reading them', () => {
    const boundaryRoot = pathResolver.sharedTmp('artifact-review-directory-boundary');
    const artifactDir = nodePath.join(boundaryRoot, 'artifact');
    const receiptDir = nodePath.join(boundaryRoot, 'receipt.json');
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.mkdirSync(receiptDir, { recursive: true });

    try {
      expect(() => hashArtifactForReview(artifactDir)).toThrow(
        '[ARTIFACT_REVIEW_RESOURCE] artifact must be a regular file'
      );
      expect(() => loadArtifactReviewReceipt(receiptDir)).toThrow(
        '[ARTIFACT_REVIEW_RESOURCE] receipt must be a regular file'
      );
    } finally {
      safeRmSync(boundaryRoot, { recursive: true, force: true });
    }
  });
});
