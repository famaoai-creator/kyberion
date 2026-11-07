import { createHash } from 'node:crypto';
import type { ValidateFunction } from 'ajv';
import { compileSchema } from '../foundation/ajv.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { nowIso } from '../foundation/time.js';
import { pathResolver } from '../path-resolver.js';
import { assertSafeRepositoryPath, safeLstat, safeReadFile } from '../secure-io.js';
import type { DeliverableKind } from '../task/deliverable-quality.js';

export type ArtifactReviewVerdict = 'approved' | 'changes_requested' | 'rejected';

/** Legacy claims remain usable during migration, but are never authentication proof. */
export type ArtifactReviewIndependencePolicy = 'legacy_actor_claim' | 'authenticated_execution';
export type ArtifactReviewIndependenceAssurance =
  'not_required' | 'legacy_actor_claim' | 'unverified';

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
  /** Historical actor-label comparison only; not authenticated execution provenance. */
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
    /** v1 compatibility field: unequal claimed actor IDs, not authenticated provenance. */
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
  /** Separates legacy admission from authenticated independence; never inferred from IDs. */
  independence_assurance: ArtifactReviewIndependenceAssurance;
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

const RECEIPT_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/artifact-review-receipt.schema.json'
);
let receiptValidator: ValidateFunction | null = null;

function getReceiptValidator(): ValidateFunction {
  if (!receiptValidator) receiptValidator = compileSchema(RECEIPT_SCHEMA_PATH);
  return receiptValidator;
}

function artifactReviewReceiptCatalog(filePath: string) {
  return defineCatalog<ArtifactReviewReceipt>({
    id: 'artifact-review-receipt',
    path: filePath,
    schema: RECEIPT_SCHEMA_PATH,
  });
}

export function artifactReviewSha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertRegularArtifactReviewFile(filePath: string, label: string): string {
  const safePath = assertSafeRepositoryPath(filePath);
  if (!safeLstat(safePath).isFile()) {
    throw new Error(`[ARTIFACT_REVIEW_RESOURCE] ${label} must be a regular file: ${safePath}`);
  }
  return safePath;
}

export function hashArtifactForReview(path: string): string {
  const safePath = assertRegularArtifactReviewFile(path, 'artifact');
  return artifactReviewSha256(safeReadFile(safePath, { encoding: null }) as Buffer);
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
    reviewed_at: input.reviewedAt || nowIso(),
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

export const ARTIFACT_REVIEW_FINDING_SHAPE =
  '{"severity":"blocking"|"suggestion","category":"<text>","description":"<text>","required_action"?:"<text>","location"?:"<text>"}';

/**
 * Fail before a receipt is written: an invalid receipt cannot be loaded, so the
 * review task would silently never be satisfied — and a free-form severity
 * (e.g. "major") would not count as blocking when the verdict is computed.
 */
export function assertValidArtifactReviewReceipt(receipt: ArtifactReviewReceipt): void {
  const validation = validateArtifactReviewReceipt(receipt);
  if (!validation.valid) {
    throw new Error(
      `[ARTIFACT_REVIEW_INVALID] receipt would be invalid: ${validation.errors.join('; ')}. ` +
        `Each finding must be ${ARTIFACT_REVIEW_FINDING_SHAPE}.`
    );
  }
}

export function loadArtifactReviewReceipt(path: string): ArtifactReviewReceipt {
  const safePath = assertRegularArtifactReviewFile(path, 'receipt');
  const value = artifactReviewReceiptCatalog(safePath).load();
  const validation = validateArtifactReviewReceipt(value);
  if (!validation.valid || !validation.receipt) {
    throw new Error(`Invalid artifact review receipt ${safePath}: ${validation.errors.join('; ')}`);
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
  /** Strict mode requires authenticated execution evidence even if requireIndependence is false.
   * No current receipt carries that evidence; strict mode therefore fails closed.
   * Omission preserves the v1 admission policy, not a claim of stronger assurance.
   */
  independencePolicy?: ArtifactReviewIndependencePolicy;
}): ArtifactReviewEvaluation {
  const reasons: string[] = [];
  const policy =
    input.independencePolicy === undefined ? 'legacy_actor_claim' : input.independencePolicy;
  const requireIndependence = input.requireIndependence || policy !== 'legacy_actor_claim';
  if (policy === 'authenticated_execution') {
    // Neither a canonical-looking actor ID, a caller-supplied boolean, nor a
    // mutable current runtime binding proves who produced/reviewed these bytes.
    // Do not add a caller-controlled proof flag here. A future verifier must
    // consume durable attestations minted at authenticated execution boundaries.
    reasons.push('authenticated reviewer execution provenance is unavailable');
  } else if (policy !== 'legacy_actor_claim') {
    reasons.push('unsupported artifact review independence policy');
  }
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
    if (requireIndependence) {
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
    independence_assurance: !requireIndependence
      ? 'not_required'
      : policy === 'legacy_actor_claim' &&
          input.reviews.length > 0 &&
          input.reviews.every(
            (review) =>
              review.independence_verified &&
              !(review.reviewer_agent_id && implementers.has(review.reviewer_agent_id))
          )
        ? 'legacy_actor_claim'
        : 'unverified',
  };
}
