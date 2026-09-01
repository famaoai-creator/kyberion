import { parseSafeJsonObjectInput } from '@agent/core/foundation';

export type JsonRecord = Record<string, unknown>;

export function isJsonRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parseJsonRecord(raw: string): JsonRecord | null {
  try {
    return parseSafeJsonObjectInput(raw, 'JSON record') ?? null;
  } catch {
    return null;
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
