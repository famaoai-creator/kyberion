import {
  normalizeRejectionReasonCategory,
  type RejectionReasonCategory,
} from '@agent/core/rejection-reason';
import type { DeliverableVerdict } from '../../../lib/deliverable-review';

const VERDICTS = new Set<DeliverableVerdict>(['accept', 'reject', 'request-changes']);
const SAFE_ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface DeliverableReviewRequestInput {
  artifactId: string;
  verdict: DeliverableVerdict;
  comment: string;
  reasonCategory?: RejectionReasonCategory;
  tenant?: string;
}

export function parseDeliverableReviewInput(
  value: Record<string, unknown>
): DeliverableReviewRequestInput {
  const unexpected = Object.keys(value).find(
    (key) => !['artifactId', 'verdict', 'comment', 'reasonCategory', 'tenant'].includes(key)
  );
  if (unexpected) throw new Error(`unexpected deliverable review field: ${unexpected}`);

  const artifactId = value.artifactId;
  if (typeof artifactId !== 'string' || !SAFE_ARTIFACT_ID.test(artifactId.trim())) {
    throw new Error('artifactId must be a safe non-empty string');
  }
  const verdict = value.verdict;
  if (typeof verdict !== 'string' || !VERDICTS.has(verdict as DeliverableVerdict)) {
    throw new Error('verdict must be accept, reject, or request-changes');
  }
  const comment = value.comment;
  if (comment !== undefined && (typeof comment !== 'string' || comment.length > 20_000)) {
    throw new Error('comment must be a string up to 20000 characters');
  }
  const rawReasonCategory = value.reasonCategory;
  let reasonCategory: RejectionReasonCategory | undefined;
  if (rawReasonCategory !== undefined) {
    if (typeof rawReasonCategory !== 'string') {
      throw new Error('reasonCategory must be a string');
    }
    reasonCategory = normalizeRejectionReasonCategory(rawReasonCategory);
    if (!reasonCategory) throw new Error('reasonCategory is invalid');
  }
  const tenant = value.tenant;
  if (tenant !== undefined && (typeof tenant !== 'string' || tenant.length > 128)) {
    throw new Error('tenant must be a string up to 128 characters');
  }

  return {
    artifactId: artifactId.trim(),
    verdict: verdict as DeliverableVerdict,
    comment: comment ?? '',
    ...(reasonCategory ? { reasonCategory } : {}),
    ...(typeof tenant === 'string' && tenant.trim() ? { tenant: tenant.trim() } : {}),
  };
}
