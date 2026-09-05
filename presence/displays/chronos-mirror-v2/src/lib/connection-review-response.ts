import { isRecord } from '@agent/core/foundation/primitives';

export type ClientConnectionReviewResponse = {
  ok: true;
  review: {
    action: 'approve' | 'hold' | 'delete' | 'modify';
    note?: string;
    reviewed_at: string;
  };
};

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ACTIONS = new Set(['approve', 'hold', 'delete', 'modify']);

function hasSafeTree(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasSafeTree);
  if (!isRecord(value)) return true;
  return Object.entries(value).every(
    ([key, nested]) => !DANGEROUS_KEYS.has(key) && hasSafeTree(nested)
  );
}

export function parseConnectionReviewResponse(
  value: unknown
): ClientConnectionReviewResponse | undefined {
  if (!isRecord(value) || !hasSafeTree(value) || value.ok !== true || !isRecord(value.review)) {
    return undefined;
  }
  if (
    typeof value.review.action !== 'string' ||
    !ACTIONS.has(value.review.action) ||
    (value.review.note !== undefined && typeof value.review.note !== 'string') ||
    typeof value.review.reviewed_at !== 'string' ||
    !value.review.reviewed_at.trim()
  ) {
    return undefined;
  }
  return {
    ok: true,
    review: {
      action: value.review.action,
      ...(value.review.note !== undefined ? { note: value.review.note } : {}),
      reviewed_at: value.review.reviewed_at,
    },
  };
}
