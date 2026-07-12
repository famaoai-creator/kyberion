import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  pathResolver,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
  sha256,
  type MarketingReview,
} from '@agent/core';
import { runMarketingReviewAggregation } from './marketing_review_aggregate.js';

const roots: string[] = [];

function fixture(findingSeverity: 'blocking' | 'suggestion' = 'suggestion') {
  const root = pathResolver.shared(`tmp/marketing-review-tests/${randomUUID()}`);
  roots.push(root);
  safeMkdir(root, { recursive: true });
  const artifactPath = path.join(root, 'video.mp4');
  safeWriteFile(artifactPath, 'video-v1');
  const artifactHash = sha256(safeReadFile(artifactPath) as Buffer);
  const packagePath = path.join(root, 'review-package.json');
  safeWriteFile(
    packagePath,
    JSON.stringify({
      run_id: 'run-1',
      risk_level: 1,
      artifacts: [{ name: 'video', path: artifactPath, sha256: artifactHash }],
    })
  );
  const review: MarketingReview = {
    review_id: 'review-1',
    artifact_path: artifactPath,
    artifact_sha256: artifactHash,
    reviewer_role: 'content-reviewer',
    verdict: findingSeverity === 'blocking' ? 'changes_requested' : 'approved',
    findings: [
      {
        severity: findingSeverity,
        category: 'readability',
        description: 'Structured review finding',
      },
    ],
  };
  const reviewPath = path.join(root, 'review.json');
  safeWriteFile(reviewPath, JSON.stringify(review));
  return { root, artifactPath, packagePath, reviewPath };
}

afterEach(() => {
  for (const root of roots.splice(0)) safeRmSync(root, { recursive: true, force: true });
});

describe('marketing review aggregation', () => {
  it('allows suggestion-only review with the required role', () => {
    const input = fixture();
    const result = runMarketingReviewAggregation({
      reviewPackagePath: input.packagePath,
      reviewPaths: [input.reviewPath],
      outputPath: path.join(input.root, 'result.json'),
    });
    expect(result.ready_for_approval).toBe(true);
  });

  it('blocks a blocking finding', () => {
    const input = fixture('blocking');
    const result = runMarketingReviewAggregation({
      reviewPackagePath: input.packagePath,
      reviewPaths: [input.reviewPath],
      outputPath: path.join(input.root, 'result.json'),
    });
    expect(result.ready_for_approval).toBe(false);
  });

  it('invalidates review after artifact mutation', () => {
    const input = fixture();
    safeWriteFile(input.artifactPath, 'video-v2');
    const result = runMarketingReviewAggregation({
      reviewPackagePath: input.packagePath,
      reviewPaths: [input.reviewPath],
      outputPath: path.join(input.root, 'result.json'),
    });
    expect(result.ready_for_approval).toBe(false);
    expect(
      JSON.parse(safeReadFile(result.output_path, { encoding: 'utf8' }) as string).gate.reasons
    ).toContain('review review-1 was invalidated by artifact change');
  });

  it('blocks when a policy-required reviewer role is absent', () => {
    const input = fixture();
    const result = runMarketingReviewAggregation({
      reviewPackagePath: input.packagePath,
      reviewPaths: [],
      outputPath: path.join(input.root, 'result.json'),
    });
    expect(result.ready_for_approval).toBe(false);
  });
});
