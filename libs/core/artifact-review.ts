import { createHash } from 'node:crypto';
import { Ajv, type ValidateFunction } from 'ajv';
import { compileSchemaFromPath } from './schema-loader.js';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import type { DeliverableKind } from './deliverable-quality.js';

export type ArtifactReviewVerdict = 'approved' | 'changes_requested' | 'rejected';

export interface ArtifactReviewBinding {
  path: string;
  sha256: string;
  kind?: DeliverableKind;
}

export interface ArtifactReviewFinding {
  severity: 'blocking' | 'suggestion';
  category: string;
  description: string;
  required_action?: string;
  location?: string;
}

export interface ArtifactReviewDecision {
  review_id: string;
  artifact_path: string;
  artifact_sha256: string;
  reviewer_role: string;
  reviewer_roles?: string[];
  reviewer_agent_id?: string;
  independence_verified?: boolean;
  verdict: ArtifactReviewVerdict;
  findings: ArtifactReviewFinding[];
}

export interface ArtifactReviewReceipt {
  kind: 'artifact-review-receipt';
  version: '1.0.0';
  review_id: string;
  mission_id: string;
  review_task_id: string;
  review_target_task_id: string;
  artifact: ArtifactReviewBinding & { kind: DeliverableKind };
  reviewer: {
    agent_id: string;
    team_role: 'reviewer' | 'qa';
    specialist_roles: string[];
    independent_from: string[];
    independence_verified: boolean;
  };
  verdict: ArtifactReviewVerdict;
  findings: ArtifactReviewFinding[];
  acceptance_criteria: string[];
  reviewed_at: string;
}

export interface ArtifactReviewEvaluation {
  ready: boolean;
  reasons: string[];
  review_ids: string[];
}

export interface ArtifactReviewReceiptInput {
  reviewId: string;
  missionId: string;
  reviewTaskId: string;
  reviewTargetTaskId: string;
  artifact: ArtifactReviewBinding & { kind: DeliverableKind };
  reviewerAgentId: string;
  reviewerTeamRole: 'reviewer' | 'qa';
  specialistRoles: string[];
  independentFrom: string[];
  findings: ArtifactReviewFinding[];
  acceptanceCriteria: string[];
  reviewedAt?: string;
}

const ajv = new Ajv({ allErrors: true });
const RECEIPT_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/artifact-review-receipt.schema.json'
);
let receiptValidator: ValidateFunction | null = null;

function getReceiptValidator(): ValidateFunction {
  if (!receiptValidator) receiptValidator = compileSchemaFromPath(ajv, RECEIPT_SCHEMA_PATH);
  return receiptValidator;
}

export function artifactReviewSha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashArtifactForReview(path: string): string {
  return artifactReviewSha256(safeReadFile(path) as Buffer);
}

export function inferArtifactReviewKind(path: string): DeliverableKind {
  const extension = path.toLowerCase().split('.').pop() || '';
  if (
    ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'yaml', 'yml', 'patch', 'diff'].includes(
      extension
    )
  ) {
    return 'code';
  }
  if (['ppt', 'pptx', 'key'].includes(extension)) return 'deck';
  if (
    ['png', 'jpg', 'jpeg', 'gif', 'svg', 'mp4', 'webm', 'wav', 'mp3', 'vtt'].includes(extension)
  ) {
    return 'media';
  }
  return 'doc';
}

export function buildArtifactReviewReceipt(
  input: ArtifactReviewReceiptInput
): ArtifactReviewReceipt {
  const independentFrom = Array.from(
    new Set(input.independentFrom.map((agentId) => String(agentId || '').trim()).filter(Boolean))
  );
  const findings = input.findings.map((finding) => ({ ...finding }));
  const blocking = findings.some((finding) => finding.severity === 'blocking');
  return {
    kind: 'artifact-review-receipt',
    version: '1.0.0',
    review_id: input.reviewId,
    mission_id: input.missionId,
    review_task_id: input.reviewTaskId,
    review_target_task_id: input.reviewTargetTaskId,
    artifact: { ...input.artifact },
    reviewer: {
      agent_id: input.reviewerAgentId,
      team_role: input.reviewerTeamRole,
      specialist_roles: Array.from(new Set(input.specialistRoles)),
      independent_from: independentFrom,
      independence_verified:
        independentFrom.length > 0 && !independentFrom.includes(input.reviewerAgentId),
    },
    verdict: blocking ? 'changes_requested' : 'approved',
    findings,
    acceptance_criteria: [...input.acceptanceCriteria],
    reviewed_at: input.reviewedAt || new Date().toISOString(),
  };
}

export function validateArtifactReviewReceipt(value: unknown): {
  valid: boolean;
  errors: string[];
  receipt?: ArtifactReviewReceipt;
} {
  const validate = getReceiptValidator();
  if (validate(value)) {
    return { valid: true, errors: [], receipt: value as ArtifactReviewReceipt };
  }
  return {
    valid: false,
    errors: (validate.errors || []).map(
      (error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`
    ),
  };
}

export function loadArtifactReviewReceipt(path: string): ArtifactReviewReceipt {
  const value = JSON.parse(String(safeReadFile(path, { encoding: 'utf8' }))) as unknown;
  const validation = validateArtifactReviewReceipt(value);
  if (!validation.valid || !validation.receipt) {
    throw new Error(`Invalid artifact review receipt ${path}: ${validation.errors.join('; ')}`);
  }
  return validation.receipt;
}

export function receiptToArtifactReviewDecision(
  receipt: ArtifactReviewReceipt
): ArtifactReviewDecision {
  return {
    review_id: receipt.review_id,
    artifact_path: receipt.artifact.path,
    artifact_sha256: receipt.artifact.sha256,
    reviewer_role: receipt.reviewer.specialist_roles[0] || receipt.reviewer.team_role,
    reviewer_roles: receipt.reviewer.specialist_roles,
    reviewer_agent_id: receipt.reviewer.agent_id,
    independence_verified: receipt.reviewer.independence_verified,
    verdict: receipt.verdict,
    findings: receipt.findings,
  };
}

export function evaluateArtifactReviews(input: {
  artifacts: ArtifactReviewBinding[];
  reviews: ArtifactReviewDecision[];
  requiredReviewerRoles: string[];
  implementerAgentIds?: string[];
  requireIndependence?: boolean;
}): ArtifactReviewEvaluation {
  const reasons: string[] = [];
  const currentHashes = new Map(
    input.artifacts.map((artifact) => [artifact.path, artifact.sha256])
  );
  const implementers = new Set(input.implementerAgentIds || []);

  for (const review of input.reviews) {
    if (currentHashes.get(review.artifact_path) !== review.artifact_sha256) {
      reasons.push(`review ${review.review_id} was invalidated by artifact change`);
    }
    if (review.findings.some((finding) => finding.severity === 'blocking')) {
      reasons.push(`review ${review.review_id} has blocking findings`);
    }
    if (review.verdict !== 'approved') {
      reasons.push(`review ${review.review_id} is ${review.verdict}`);
    }
    if (input.requireIndependence) {
      if (!review.independence_verified) {
        reasons.push(`review ${review.review_id} has no verified reviewer independence`);
      }
      if (review.reviewer_agent_id && implementers.has(review.reviewer_agent_id)) {
        reasons.push(`review ${review.review_id} was performed by an implementation agent`);
      }
    }
  }

  for (const artifact of input.artifacts) {
    const covered = input.reviews.some(
      (review) =>
        review.artifact_path === artifact.path && review.artifact_sha256 === artifact.sha256
    );
    if (!covered) reasons.push(`artifact has no current review: ${artifact.path}`);
  }

  const reviewerRoles = new Set(
    input.reviews.flatMap((review) => review.reviewer_roles || [review.reviewer_role])
  );
  for (const role of input.requiredReviewerRoles) {
    if (!reviewerRoles.has(role)) reasons.push(`required reviewer role is missing: ${role}`);
  }

  return {
    ready: reasons.length === 0,
    reasons,
    review_ids: input.reviews.map((review) => review.review_id),
  };
}
