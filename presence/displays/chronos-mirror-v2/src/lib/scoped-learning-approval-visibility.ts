import type { ApprovalRequestRecord } from '@agent/core/governance/approval-store';
import {
  isScopedLearningApprovalRequest,
  resolveScopedLearningApprovalCandidate,
} from '@agent/core/knowledge/scoped-learning-approval-visibility';
import { memoryCandidateVisibleToViewer } from './knowledge-scope';
import type { ViewerContext } from './viewer-context';

export function scopedLearningApprovalVisibleToViewer(
  record: ApprovalRequestRecord,
  viewer?: ViewerContext,
  requestedTenant?: string
): boolean {
  if (!isScopedLearningApprovalRequest(record)) return true;
  if (!viewer) return false;
  const candidate = resolveScopedLearningApprovalCandidate(record);
  return Boolean(candidate && memoryCandidateVisibleToViewer(candidate, viewer, requestedTenant));
}
