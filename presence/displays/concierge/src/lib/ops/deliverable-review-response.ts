import { isRecord } from '@agent/core/foundation/primitives';

export type ClientDeliverableReviewResponse = {
  ok: true;
  state: { current_artifact_id: string };
};

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function hasSafeTree(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasSafeTree);
  if (!isRecord(value)) return true;
  return Object.entries(value).every(
    ([key, nested]) => !DANGEROUS_KEYS.has(key) && hasSafeTree(nested)
  );
}

export function parseDeliverableReviewResponse(
  value: unknown
): ClientDeliverableReviewResponse | undefined {
  if (
    !isRecord(value) ||
    !hasSafeTree(value) ||
    value.ok !== true ||
    !isRecord(value.state) ||
    typeof value.state.current_artifact_id !== 'string' ||
    !value.state.current_artifact_id.trim()
  ) {
    return undefined;
  }
  return {
    ok: true,
    state: { current_artifact_id: value.state.current_artifact_id },
  };
}
