import type { ApprovalRequestRecord } from '@agent/core/governance/approval-store';
import {
  isScopedLearningApprovalRequest,
  resolveScopedLearningApprovalCandidate,
} from '@agent/core/knowledge/scoped-learning-approval-visibility';
import { memoryCandidateVisibleToViewer } from './memory-candidate-visibility';
import type { ConciergeViewerContext } from './viewer-context';

export function scopedLearningApprovalVisibleToViewer(
  record: ApprovalRequestRecord,
  viewer: ConciergeViewerContext
): boolean {
  if (!isScopedLearningApprovalRequest(record)) return true;
  const candidate = resolveScopedLearningApprovalCandidate(record);
  return Boolean(candidate && memoryCandidateVisibleToViewer(candidate, viewer));
}
