import {
  evaluateConsentCoverage,
  type WorkInventoryConsent,
} from '@agent/core/workforce/work-inventory-consent';
import type { WorkInventoryObservationSummary } from '@agent/core/workforce/work-inventory-observation';
import type { ObservationReviewDigest } from './observation-review-types';

const REVIEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SUMMARIES = 100;

/** Count-only projection: personal content and actionable controls never cross this boundary. */
export function buildObservationReview(
  summaries: readonly WorkInventoryObservationSummary[],
  consents: readonly WorkInventoryConsent[],
  memberId: string,
  tenant: string,
  now: Date
): ObservationReviewDigest {
  const time = now.getTime();
  if (!Number.isFinite(time)) throw new Error('Invalid review time');
  const eligible = summaries
    .filter((summary) => {
      const start = Date.parse(summary.window.start);
      const end = Date.parse(summary.window.end);
      if (
        summary.member_id !== memberId ||
        summary.tenant_slug !== tenant ||
        summary.status !== 'pending_review' ||
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start > end ||
        end > time ||
        end < time - REVIEW_WINDOW_MS
      )
        return false;
      const original = consents.filter(
        (consent) => consent.member_id === memberId && consent.consent_id === summary.consent_id
      );
      return evaluateConsentCoverage(
        original,
        summary.source,
        [new Date(start), new Date(end), now],
        tenant
      ).ok;
    })
    .sort(
      (a, b) =>
        Date.parse(b.window.end) - Date.parse(a.window.end) ||
        a.summary_id.localeCompare(b.summary_id)
    );
  const bounded = eligible.slice(0, MAX_SUMMARIES);
  return {
    checkedAt: now.toISOString(),
    pendingCount: bounded.length,
    attentionCount: bounded.filter((summary) =>
      summary.proposed_steps.some((step) => step.requires_attention)
    ).length,
    limited: eligible.length > MAX_SUMMARIES,
  };
}
