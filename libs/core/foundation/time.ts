export function nowIso(date = new Date()): string {
  return date.toISOString();
}

export function parseIso(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid ISO timestamp: ${value}`);
  return parsed;
}

export function normalizeIso(value: string | Date | undefined, fallback = nowIso()): string {
  return value === undefined
    ? fallback
    : nowIso(typeof value === 'string' ? parseIso(value) : value);
}
