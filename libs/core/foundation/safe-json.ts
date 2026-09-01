const JSON_DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface SafeJsonParseOptions {
  preserveParseError?: boolean;
}

function isSafeJsonValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(isSafeJsonValue);
  if (value === null || typeof value !== 'object') return true;
  return Object.entries(value).every(
    ([key, nested]) => !JSON_DANGEROUS_KEYS.has(key) && isSafeJsonValue(nested)
  );
}

export function parseSafeJsonInput(
  raw: string,
  label: string,
  options: SafeJsonParseOptions = {}
): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    if (options.preserveParseError) throw error;
    throw new Error(`${label} must be valid JSON`);
  }
  if (!isSafeJsonValue(parsed)) {
    throw new Error(`${label} contains a dangerous JSON key`);
  }
  return parsed;
}

export function parseSafeJsonObjectInput(
  raw: string | undefined,
  label: string
): Record<string, unknown> | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  return parseSafeJsonObjectValue(parseSafeJsonInput(raw, label), label);
}

export function parseSafeJsonObjectValue(value: unknown, label: string): Record<string, unknown> {
  if (!isSafeJsonValue(value)) {
    throw new Error(`${label} contains a dangerous JSON key`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}
