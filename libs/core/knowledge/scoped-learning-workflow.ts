/** Shared curation → canonical human approval → verified publication facade. */
import {
  listMemoryPromotionCandidates,
  memoryPromotionScopeKey,
  updateMemoryPromotionCandidateStatus,
  withScopedLearningCandidateReview,
  type MemoryCandidate,
} from './memory-promotion-queue.js';
import { assertMemoryScope, type MemoryScopeEnvelope } from './memory-scope.js';
import type { ApprovalRequesterInput } from '../governance/approval-requester.js';
import { isApprovalRequestExpired } from '../governance/approval-store-reader.js';
import {
  approvedLearningPayloadDigest,
  assertScopedLearningScope,
  isScopedLearningCandidate,
  type ScopedLearningPublicationIdentity,
} from './scoped-learning-domain.js';
import {
  assertScopedLearningApprovalBinding,
  findScopedLearningApprovalRequest,
  verifyScopedLearningApprovalRef,
} from './scoped-learning-approval-verifier.js';
import { requestScopedLearningApproval } from './scoped-learning-approval.js';
import { verifyScopedLearningPublication } from './scoped-learning-publication.js';
import { promoteMemoryCandidateToKnowledge } from './memory-promotion-workflow.js';
import {
  assertMemoryPromotionReviewReady,
  reviewMemoryPromotionCandidate,
} from './memory-promotion-review.js';

export interface ScopedLearningReview {
  candidate: MemoryCandidate;
  learning: {
    state:
      | 'unsupported'
      | 'draft'
      | 'pending'
      | 'approved'
      | 'rejected'
      | 'expired'
      | 'revoked'
      | 'published'
      | 'error';
    payloadDigest?: string;
    approvalRef?: string;
    publication?: ScopedLearningPublicationIdentity;
    reason?: string;
  };
}
type CandidateAddress = { candidateId: string; scope: MemoryScopeEnvelope };
type ExpectedCandidate = CandidateAddress & { expectedPayloadDigest: string };
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function loadExact(input: CandidateAddress): MemoryCandidate {
  const scope = assertMemoryScope(input.scope);
  const rows = listMemoryPromotionCandidates(scope).filter(
    (candidate) =>
      candidate.candidate_id === input.candidateId &&
      memoryPromotionScopeKey(candidate.scope) === memoryPromotionScopeKey(scope)
  );
  if (rows.length !== 1)
    throw new Error('[LEARNING_CANDIDATE_CONFLICT] Expected exactly one scoped candidate');
  return rows[0]!;
}
function assertExpected(candidate: MemoryCandidate, expected: string): void {
  if (!expected || expected !== approvedLearningPayloadDigest(candidate))
    throw new Error('[LEARNING_STALE_PAYLOAD] Candidate changed; reload before continuing');
}
function assertReady(candidate: MemoryCandidate, operation: 'approve' | 'promote'): void {
  const rows = reviewMemoryPromotionCandidate(candidate.candidate_id, candidate.scope);
  if (rows.length !== 1)
    throw new Error('[LEARNING_CANDIDATE_CONFLICT] Expected exactly one scoped review');
  assertMemoryPromotionReviewReady(rows[0]!, operation);
}

/** Read-only projection. Status labels and caller-supplied human labels never prove approval. */
export function inspectScopedLearningReview(candidate: MemoryCandidate): ScopedLearningReview {
  const result: ScopedLearningReview = { candidate, learning: { state: 'unsupported' } };
  try {
    if (!candidate.scope || !isScopedLearningCandidate(candidate)) {
      result.learning.reason = 'Only exact confidential organization SOP candidates are supported.';
      return result;
    }
    assertScopedLearningScope(candidate.scope);
    approvedLearningPayloadDigest(candidate);
  } catch (error) {
    result.learning.reason = reasonOf(error);
    return result;
  }
  try {
    candidate = loadExact({ candidateId: candidate.candidate_id, scope: candidate.scope! });
    result.candidate = candidate;
    result.learning = { state: 'draft', payloadDigest: approvedLearningPayloadDigest(candidate) };
    const record = findScopedLearningApprovalRequest(candidate);
    if (record) {
      result.learning.approvalRef = 'terminal:' + record.id;
      assertScopedLearningApprovalBinding(record, candidate);
    }
    if (candidate.status === 'rejected') {
      result.learning.state = 'rejected';
      result.learning.reason =
        'The candidate was rejected; revised content requires a new candidate.';
      return result;
    }
    if (record?.revocation) {
      result.learning.state = 'revoked';
      result.learning.reason = record.revocation.reason || 'The canonical approval was revoked.';
      return result;
    }
    if (candidate.status === 'promoted') {
      const publication = verifyScopedLearningPublication(candidate);
      if (!publication)
        throw new Error('[LEARNING_PUBLICATION_INVALID] Stored publication proof does not verify');
      result.learning.state = 'published';
      result.learning.publication = publication;
      return result;
    }
    if (!record) {
      if (candidate.status === 'approved' || candidate.learning_approval)
        throw new Error('[LEARNING_APPROVAL_REQUIRED] Canonical review record is missing');
      return result;
    }
    if (record.status === 'rejected' || record.status === 'cancelled') {
      result.learning.state = 'rejected';
      result.learning.reason = 'Canonical review is ' + record.status + '; use a new candidate.';
      return result;
    }
    if (isApprovalRequestExpired(record)) {
      result.learning.state = 'expired';
      result.learning.reason = 'The exact review expired before verified publication.';
      return result;
    }
    if (record.status === 'pending') {
      result.learning.state = 'pending';
      return result;
    }
    if (record.status !== 'approved')
      throw new Error('[LEARNING_APPROVAL_REQUIRED] Canonical review is not approved');
    if (
      record.applyClaim ||
      record.applyResult ||
      (record.consumption && record.consumption.consumer !== 'scoped_learning_publication')
    )
      throw new Error('[LEARNING_APPROVAL_CONFLICT] Canonical approval was used by another effect');
    verifyScopedLearningApprovalRef(candidate, result.learning.approvalRef!);
    result.learning.state = 'approved';
    return result;
  } catch (error) {
    result.learning.state = 'error';
    result.learning.reason = reasonOf(error);
    return result;
  }
}

export function inspectScopedLearningCandidate(input: CandidateAddress): ScopedLearningReview {
  return inspectScopedLearningReview(loadExact(input));
}

export function curateScopedLearningCandidate(
  input: ExpectedCandidate & {
    curation: NonNullable<MemoryCandidate['curation']>;
  }
): ScopedLearningReview {
  if (!input.expectedPayloadDigest)
    throw new Error('[LEARNING_STALE_PAYLOAD] An expected payload digest is required');
  const candidate = withScopedLearningCandidateReview(input, (current) => current);
  return inspectScopedLearningReview(candidate);
}

export function requestScopedLearningCandidateApproval(
  input: ExpectedCandidate & {
    requester: ApprovalRequesterInput;
  }
): ScopedLearningReview {
  const candidate = loadExact(input);
  assertExpected(candidate, input.expectedPayloadDigest);
  const before = inspectScopedLearningReview(candidate);
  if (
    before.learning.state !== 'draft' &&
    before.learning.state !== 'pending' &&
    before.learning.state !== 'approved' &&
    before.learning.state !== 'published'
  )
    throw new Error(
      before.learning.reason || '[LEARNING_REVIEW_REQUIRED] Candidate is not reviewable'
    );
  assertReady(candidate, 'approve');
  requestScopedLearningApproval({
    candidate,
    requester: input.requester,
    expectedPayloadDigest: input.expectedPayloadDigest,
  });
  return inspectScopedLearningCandidate(input);
}

export async function publishScopedLearningCandidate(
  input: ExpectedCandidate & {
    executionRole?: 'chronos_gateway' | 'mission_controller';
  }
): Promise<ScopedLearningReview> {
  const candidate = loadExact(input);
  assertExpected(candidate, input.expectedPayloadDigest);
  const before = inspectScopedLearningReview(candidate);
  if (before.learning.state === 'published') return before;
  if (before.learning.state !== 'approved' || !before.learning.approvalRef)
    throw new Error(
      before.learning.reason || '[LEARNING_APPROVAL_REQUIRED] Exact approval is required'
    );
  assertReady(candidate, 'approve');
  let approved: MemoryCandidate | null;
  try {
    approved =
      candidate.status === 'approved'
        ? candidate
        : updateMemoryPromotionCandidateStatus({
            candidateId: input.candidateId,
            scope: input.scope,
            status: 'approved',
            expectedPayloadDigest: input.expectedPayloadDigest,
            learningApprovalRef: before.learning.approvalRef,
          });
  } catch (error) {
    // Another complete attempt may have won after this caller loaded its queued row.
    const observed = inspectScopedLearningCandidate(input);
    if (
      observed.learning.state === 'published' &&
      observed.learning.payloadDigest === input.expectedPayloadDigest
    )
      return observed;
    throw error;
  }
  if (!approved) throw new Error('[LEARNING_CANDIDATE_CONFLICT] Candidate disappeared');
  assertReady(approved, 'promote');
  await promoteMemoryCandidateToKnowledge({
    candidateId: input.candidateId,
    scope: input.scope,
    expectedPayloadDigest: input.expectedPayloadDigest,
    executionRole: input.executionRole || 'chronos_gateway',
  });
  const after = inspectScopedLearningCandidate(input);
  if (after.learning.state !== 'published' || !after.learning.publication)
    throw new Error(
      after.learning.reason || '[LEARNING_PUBLICATION_INVALID] Publication is not verified'
    );
  return after;
}
