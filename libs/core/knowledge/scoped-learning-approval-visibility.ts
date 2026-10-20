/** Read-side adapter seam: request identity never substitutes for candidate visibility. */
import type { ApprovalRequestRecord } from '../governance/approval-store.js';
import {
  listMemoryPromotionCandidates,
  memoryPromotionScopeKey,
  type MemoryCandidate,
} from './memory-promotion-queue.js';
import { assertScopedLearningApprovalBinding } from './scoped-learning-approval-verifier.js';

export function isScopedLearningApprovalRequest(record: ApprovalRequestRecord): boolean {
  return Boolean(
    record.accountability?.effectBinding?.startsWith('scoped-learning:') ||
    record.correlationId?.startsWith('scoped-learning:') ||
    record.threadTs?.startsWith('scoped-learning-')
  );
}

/** Missing, duplicate, changed or malformed candidates are unavailable, never legacy approvals. */
export function resolveScopedLearningApprovalCandidate(
  record: ApprovalRequestRecord
): MemoryCandidate | null {
  if (!isScopedLearningApprovalRequest(record) || !record.scope || !record.source?.taskId)
    return null;
  try {
    const scopeKey = memoryPromotionScopeKey(record.scope);
    const matches = listMemoryPromotionCandidates(record.scope).filter(
      (candidate) =>
        candidate.candidate_id === record.source!.taskId &&
        memoryPromotionScopeKey(candidate.scope) === scopeKey
    );
    if (matches.length !== 1) return null;
    assertScopedLearningApprovalBinding(record, matches[0]!);
    return matches[0]!;
  } catch {
    return null;
  }
}
