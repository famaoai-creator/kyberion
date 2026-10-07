/** Shared bounded parser for runtime concurrency settings. */
export interface InflightLimitResult {
  value: number;
  invalid: boolean;
}

export function parseInflightLimit(
  raw: string | undefined,
  fallback: number,
  maximum = 256
): InflightLimitResult {
  if (raw === undefined || raw.trim() === '') return { value: fallback, invalid: false };
  const parsed = Number(raw);
  if (Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum) {
    return { value: parsed, invalid: false };
  }
  return { value: fallback, invalid: true };
}
