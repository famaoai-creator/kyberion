export interface ObservationReviewDigest {
  checkedAt: string;
  pendingCount: number;
  attentionCount: number;
  limited: boolean;
}

export function parseObservationReview(value: unknown): ObservationReviewDigest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid review');
  const record = value as Record<string, unknown>;
  const count = (input: unknown): input is number =>
    typeof input === 'number' && Number.isInteger(input) && input >= 0 && input <= 100;
  if (
    record.ok !== true ||
    typeof record.checkedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.checkedAt)) ||
    !count(record.pendingCount) ||
    !count(record.attentionCount) ||
    record.attentionCount > record.pendingCount ||
    typeof record.limited !== 'boolean'
  )
    throw new Error('Invalid review');
  return {
    checkedAt: record.checkedAt,
    pendingCount: record.pendingCount,
    attentionCount: record.attentionCount,
    limited: record.limited,
  };
}
