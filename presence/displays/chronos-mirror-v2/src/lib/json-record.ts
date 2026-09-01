export type JsonRecord = Record<string, unknown>;

const JSON_DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isSafeJsonValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(isSafeJsonValue);
  if (value === null || typeof value !== 'object') return true;
  return Object.entries(value).every(
    ([key, nested]) => !JSON_DANGEROUS_KEYS.has(key) && isSafeJsonValue(nested)
  );
}

export function isJsonRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parseJsonRecord(raw: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isJsonRecord(parsed) && isSafeJsonValue(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseJsonValue(raw: string): unknown | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isSafeJsonValue(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function recordField(value: unknown): JsonRecord {
  return isJsonRecord(value) ? value : {};
}

export function stringField(record: JsonRecord, key: string, fallback = ''): string {
  const value = record[key];
  return typeof value === 'string' && value ? value : fallback;
}

export function optionalStringField(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value ? value : undefined;
}

export function numberField(record: JsonRecord, key: string, fallback = 0): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
