import { verifyScopedLearningApprovalRef } from './scoped-learning-approval-verifier.js';
import {
  approvedLearningPayloadDigest,
  type ScopedLearningApproval,
} from './scoped-learning-contract.js';
import type { MemoryCandidate } from './memory-promotion-queue.js';
export function assertScopedLearningApproval(candidate: MemoryCandidate): ScopedLearningApproval {
  const receipt = candidate.learning_approval;
  if (
    !receipt ||
    receipt.version !== 1 ||
    receipt.channel !== 'steward' ||
    receipt.decided_by.kind !== 'human' ||
    !/^user:[a-z][a-z0-9-]{1,30}$/.test(receipt.decided_by.id) ||
    !receipt.approved_at ||
    (candidate.status !== 'approved' && candidate.status !== 'promoted') ||
    receipt.payload_digest !== approvedLearningPayloadDigest(candidate)
  )
    throw new Error('[LEARNING_APPROVAL_REQUIRED] Exact human-approved payload is required');
  const verified = verifyScopedLearningApprovalRef(candidate, receipt.approval_ref);
  if (
    verified.payload_digest !== receipt.payload_digest ||
    verified.approval_ref !== receipt.approval_ref ||
    verified.approved_at !== receipt.approved_at ||
    verified.decided_by.id !== receipt.decided_by.id ||
    verified.channel !== receipt.channel
  )
    throw new Error(
      '[LEARNING_APPROVAL_REQUIRED] Approval receipt differs from canonical decision'
    );
  return receipt;
}
