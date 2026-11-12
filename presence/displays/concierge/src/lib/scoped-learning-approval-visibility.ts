import type { ApprovalRequestRecord } from '@agent/core/governance/approval-store';
import {
  isScopedLearningApprovalRequest,
  resolveScopedLearningApprovalCandidate,
} from '@agent/core/knowledge/scoped-learning-approval-visibility';
import { memoryCandidateVisibleToViewer } from './memory-candidate-visibility';
import type { ViewerContext } from './ops/ops-viewer';

/**
 * A scoped-learning approval is visible only with its bound candidate (which
 * always carries its scope); any other approval is left to its own adapter.
 * One rule for the inbox and the operations console.
 */
export function scopedLearningApprovalVisibleToViewer(
  record: ApprovalRequestRecord,
  viewer?: ViewerContext,
  requestedTenant?: string
): boolean {
  if (!isScopedLearningApprovalRequest(record)) return true;
  if (!viewer) return false;
  const candidate = resolveScopedLearningApprovalCandidate(record);
  return Boolean(
    candidate && memoryCandidateVisibleToViewer(candidate, viewer, { requestedTenant })
  );
}
