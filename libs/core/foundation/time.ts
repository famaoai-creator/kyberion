import { getClock } from './clock.js';

export function nowIso(date = new Date(getClock().now())): string {
  return date.toISOString();
}

export function parseIso(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid ISO timestamp: ${value}`);
  return parsed;
}

/** Is `value` a real calendar date written `YYYY-MM-DD`? (rejects 2026-02-30 and timestamps) */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

export function normalizeIso(value: string | Date | undefined, fallback = nowIso()): string {
  return value === undefined
    ? fallback
    : nowIso(typeof value === 'string' ? parseIso(value) : value);
}
