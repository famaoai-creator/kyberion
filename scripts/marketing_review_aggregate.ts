import {
  aggregateMarketingReviews,
  loadMarketingReviewAtPath,
  loadMarketingReviewPackageAtPath,
  requiredMarketingControls,
  sha256,
  type ArtifactBinding,
  type MarketingReviewPackage,
} from '@agent/core/marketing-workload';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReadFile,
  safeWriteFile,
} from '@agent/core/secure-io';
import { createStandardYargs } from '@agent/core/cli-utils';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

function resolveMarketingReviewPath(
  value: unknown,
  label: string,
  allowMissingLeaf = false
): string {
  const requested = String(value ?? '').trim();
  if (!requested) throw new Error(`${label} is required`);
  return assertSafeRepositoryPath(pathResolver.resolve(requested), { allowMissingLeaf });
}

function requireRegularMarketingInput(filePath: string, label: string): string {
  if (!safeLstat(filePath).isFile()) {
    throw new Error(`${label} must be a regular file: ${filePath}`);
  }
  return filePath;
}

export function runMarketingReviewAggregation(input: {
  reviewPackagePath: string;
  reviewPaths: string[];
  outputPath: string;
}): { ready_for_approval: boolean; output_path: string } {
  const reviewPackagePath = resolveMarketingReviewPath(
    input.reviewPackagePath,
    'review package path'
  );
  const reviewPackage: MarketingReviewPackage = loadMarketingReviewPackageAtPath(reviewPackagePath);
  const packageHashMismatches: string[] = [];
  const artifacts: Record<string, ArtifactBinding> = Object.fromEntries(
    reviewPackage.artifacts
      .filter((artifact) => artifact.name !== 'completion-evidence.json')
      .map((artifact) => {
        const artifactPath = resolveMarketingReviewPath(
          artifact.path,
          `review artifact ${artifact.name}`
        );
        if (!safeExistsSync(artifactPath))
          throw new Error(`Review artifact is missing: ${artifact.name}`);
        requireRegularMarketingInput(artifactPath, `review artifact ${artifact.name}`);
        const actualSha256 = sha256(safeReadFile(artifactPath) as Buffer);
        if (artifact.sha256 !== actualSha256) {
          packageHashMismatches.push(artifact.name);
        }
        return [artifact.name, { path: artifact.path, sha256: actualSha256 }];
      })
  );
  const reviews = input.reviewPaths.map((reviewPath) => {
    const resolvedReviewPath = resolveMarketingReviewPath(reviewPath, 'review path');
    return loadMarketingReviewAtPath(resolvedReviewPath);
  });
  const controls = requiredMarketingControls(reviewPackage.risk_level);
  const gate = aggregateMarketingReviews({
    artifacts,
    reviews,
    requiredReviewerRoles: controls.required_reviewers,
  });
  if (packageHashMismatches.length > 0) {
    gate.status = 'failed';
    gate.reasons.push(
      ...packageHashMismatches.map((name) => `review package artifact hash mismatch: ${name}`)
    );
  }
  const outputPath = resolveMarketingReviewPath(input.outputPath, 'output path', true);
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

export async function main(
  args: string[] = []
): Promise<{ ready_for_approval: boolean; output_path: string }> {
  const argv = createStandardYargs(['node', 'marketing_review_aggregate', ...args])
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
  return result;
}

export const runMarketingReviewAggregationScript = defineScript({
  name: 'marketing:review-aggregate',
  flags: [],
  run: async (context) => {
    const result = await main(context.argv);
    context.print(result);
    if (!result.ready_for_approval) {
      throw new ScriptExitError(1, 'marketing review aggregation is not ready for approval');
    }
    return result;
  },
});

if (
  isDirectScript(import.meta.url, 'marketing_review_aggregate.ts') ||
  isDirectScript(import.meta.url, 'marketing_review_aggregate.js')
)
  void runMarketingReviewAggregationScript();
