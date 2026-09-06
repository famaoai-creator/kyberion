const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export type ConciergeMutationResponse = {
  message?: string;
  result?: { message: string };
  sample?: { sample_ref: string };
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasSafeTree(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasSafeTree);
  if (!isRecord(value)) return true;
  return Object.entries(value).every(
    ([key, nested]) => !DANGEROUS_KEYS.has(key) && hasSafeTree(nested)
  );
}

export function parseConciergeMutationResponse(
  value: unknown
): ConciergeMutationResponse | undefined {
  if (!isRecord(value) || value.ok !== true || !hasSafeTree(value)) return undefined;
  if (value.message !== undefined && typeof value.message !== 'string') return undefined;
  if (
    value.result !== undefined &&
    (!isRecord(value.result) || typeof value.result.message !== 'string')
  ) {
    return undefined;
  }
  if (
    value.sample !== undefined &&
    (!isRecord(value.sample) || typeof value.sample.sample_ref !== 'string')
  ) {
    return undefined;
  }
  return {
    ...(value.message === undefined ? {} : { message: value.message }),
    ...(value.result === undefined
      ? {}
      : { result: { message: (value.result as JsonRecord).message as string } }),
    ...(value.sample === undefined
      ? {}
      : { sample: { sample_ref: (value.sample as JsonRecord).sample_ref as string } }),
  };
}
