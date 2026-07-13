import * as path from 'node:path';
import {
  aggregateMarketingReviews,
  logger,
  pathResolver,
  requiredMarketingControls,
  safeExistsSync,
  safeReadFile,
  safeWriteFile,
  sha256,
  type ArtifactBinding,
  type MarketingReview,
  type MarketingRiskLevel,
} from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';

interface ReviewPackage {
  run_id: string;
  risk_level: MarketingRiskLevel;
  artifacts: Array<{ name: string; path: string; sha256: string }>;
}

function readJson<T>(filePath: string): T {
  return JSON.parse(
    safeReadFile(pathResolver.rootResolve(filePath), { encoding: 'utf8' }) as string
  ) as T;
}

export function runMarketingReviewAggregation(input: {
  reviewPackagePath: string;
  reviewPaths: string[];
  outputPath: string;
}): { ready_for_approval: boolean; output_path: string } {
  const reviewPackage = readJson<ReviewPackage>(input.reviewPackagePath);
  const artifacts: Record<string, ArtifactBinding> = Object.fromEntries(
    reviewPackage.artifacts
      .filter((artifact) => artifact.name !== 'completion-evidence.json')
      .map((artifact) => {
        const artifactPath = pathResolver.rootResolve(artifact.path);
        if (!safeExistsSync(artifactPath))
          throw new Error(`Review artifact is missing: ${artifact.name}`);
        return [
          artifact.name,
          { path: artifact.path, sha256: sha256(safeReadFile(artifactPath) as Buffer) },
        ];
      })
  );
  const reviews = input.reviewPaths.map((reviewPath) => readJson<MarketingReview>(reviewPath));
  const controls = requiredMarketingControls(reviewPackage.risk_level);
  const gate = aggregateMarketingReviews({
    artifacts,
    reviews,
    requiredReviewerRoles: controls.required_reviewers,
  });
  const outputPath = pathResolver.rootResolve(input.outputPath);
  const result = {
    run_id: reviewPackage.run_id,
    risk_level: reviewPackage.risk_level,
    gate,
    reviews,
    blocking_findings: reviews.flatMap((review) =>
      review.findings
        .filter((finding) => finding.severity === 'blocking')
        .map((finding) => ({ review_id: review.review_id, ...finding }))
    ),
    ready_for_approval: gate.status === 'passed',
    evidence: input.reviewPaths,
  };
  safeWriteFile(outputPath, JSON.stringify(result, null, 2));
  return { ready_for_approval: result.ready_for_approval, output_path: outputPath };
}

async function main(): Promise<void> {
  const argv = createStandardYargs()
    .option('review-package', { type: 'string', demandOption: true })
    .option('reviews', { type: 'string', demandOption: true })
    .option('output', { type: 'string', demandOption: true })
    .parseSync();
  const result = runMarketingReviewAggregation({
    reviewPackagePath: String(argv['review-package']),
    reviewPaths: String(argv.reviews)
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    outputPath: String(argv.output),
  });
  logger.success(JSON.stringify(result));
  if (!result.ready_for_approval) process.exitCode = 1;
}

if (process.argv[1] && /marketing_review_aggregate\.(ts|js)$/.test(process.argv[1])) {
  main().catch((error) => {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
