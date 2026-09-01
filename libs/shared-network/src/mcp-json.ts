const JSON_DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isSafeJsonTree(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(isSafeJsonTree);
  if (value === null || typeof value !== 'object') return true;
  return Object.entries(value).every(
    ([key, nested]) => !JSON_DANGEROUS_KEYS.has(key) && isSafeJsonTree(nested)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseSafeJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || Array.isArray(parsed) || !isSafeJsonTree(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function parseMcpTextPayload(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return isSafeJsonTree(parsed) ? parsed : text;
  } catch {
    return text;
  }
}
