/**
 * LC-10 (LOOP_CLOSURE_PLAN): shared vocabulary for "why was this rejected".
 * A closed category set (plus free-text note) keeps the learning loop
 * deterministic — dedup and same-shape-rejection detection key off the
 * category, not free text. Used by approval decisions and deliverable
 * review verdicts alike.
 */

export const REJECTION_REASON_CATEGORIES = [
  'incorrect_content',
  'wrong_direction',
  'quality',
  'scope',
  'other',
] as const;

export type RejectionReasonCategory = (typeof REJECTION_REASON_CATEGORIES)[number];

export function normalizeRejectionReasonCategory(
  value: unknown
): RejectionReasonCategory | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/[- ]/g, '_');
  return (REJECTION_REASON_CATEGORIES as readonly string[]).includes(normalized)
    ? (normalized as RejectionReasonCategory)
    : undefined;
}
