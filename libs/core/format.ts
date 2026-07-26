/**
 * I18N-05: Locale/timezone-aware date, number, currency, and relative-time
 * formatting — the single place implementation code should route through
 * instead of calling `Date#toLocaleString()` / `Intl.NumberFormat` directly
 * with implicit (environment-dependent) locale/timeZone.
 *
 * `locale` and `timeZone` are REQUIRED, not optional, on every entry point
 * here: the whole point of this module is to make environment-implicit
 * formatting impossible to write by accident. Callers that don't yet have a
 * resolved locale/timeZone should thread one in from the nearest caller that
 * does (see call sites) rather than falling back to a default inside this
 * module.
 *
 * `libs/core/locale.ts` (owned by a different workstream, I18N-01) is the
 * place `resolveLocale()` will eventually live; this module has no
 * dependency on it and never will — it only *consumes* a locale string.
 *
 * Intl.DateTimeFormat / Intl.NumberFormat / Intl.RelativeTimeFormat
 * construction is expensive, so formatter instances are cached by a key
 * derived from their options (this module runs inside render loops such as
 * MissionIntelligence's per-second dashboard tick).
 */
import * as path from 'node:path';
import { resolveActiveProfileRoot } from './profile-root.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';

export type DateTimeFormatStyle = 'date' | 'time' | 'datetime' | 'short' | 'long';

export interface FormatDateTimeOptions {
  /** BCP-47 locale tag, e.g. 'ja-JP' or 'en-US'. Required — no implicit default. */
  locale: string;
  /** IANA timeZone, e.g. 'Asia/Tokyo'. Required — no implicit default. */
  timeZone: string;
  /**
   * 'date' — numeric y/m/d.
   * 'time' — 2-digit h/m.
   * 'datetime' (default) — numeric y/m/d + 2-digit h/m.
   * 'short' — locale-conventional short date + short time.
   * 'long' — locale-conventional long date + medium time.
   */
  style?: DateTimeFormatStyle;
}

export interface FormatNumberOptions extends Omit<Intl.NumberFormatOptions, 'style' | 'currency'> {
  locale: string;
}

export interface FormatCurrencyOptions extends Omit<
  Intl.NumberFormatOptions,
  'style' | 'currency'
> {
  locale: string;
  /** ISO 4217 currency code, e.g. 'JPY' or 'USD'. Required. */
  currency: string;
}

export interface FormatRelativeTimeOptions {
  locale: string;
  /** Reference "now" instant. Defaults to `new Date()` — inject a fixed value in tests. */
  now?: Date;
}

const DEFAULT_TIMEZONE = 'Asia/Tokyo';

// ─── Formatter caches (keyed by a stable serialization of their options) ───

const dateTimeFormatterCache = new Map<string, Intl.DateTimeFormat>();
const numberFormatterCache = new Map<string, Intl.NumberFormat>();
const relativeTimeFormatterCache = new Map<string, Intl.RelativeTimeFormat>();

/** Test-only: clears all formatter caches so tests don't leak state across runs. */
export function _resetFormatCachesForTests(): void {
  dateTimeFormatterCache.clear();
  numberFormatterCache.clear();
  relativeTimeFormatterCache.clear();
}

/**
 * Test-only: exposes cache sizes so tests can assert that repeated calls
 * with identical options reuse a formatter (size stays flat) while calls
 * with different options grow the cache (size increases) — without having
 * to monkeypatch the native `Intl.*` constructors.
 */
export function _getFormatCacheSizesForTests(): {
  dateTime: number;
  number: number;
  relativeTime: number;
} {
  return {
    dateTime: dateTimeFormatterCache.size,
    number: numberFormatterCache.size,
    relativeTime: relativeTimeFormatterCache.size,
  };
}

function stableSerialize(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

function toDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

function assertValidDate(date: Date, source: unknown, fnName: string): void {
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`${fnName}: invalid date value: ${String(source)}`);
  }
}

function dateTimeFormatOptionsForStyle(
  style: DateTimeFormatStyle | undefined
): Intl.DateTimeFormatOptions {
  switch (style) {
    case 'date':
      return { year: 'numeric', month: '2-digit', day: '2-digit' };
    case 'time':
      return { hour: '2-digit', minute: '2-digit' };
    case 'short':
      return { dateStyle: 'short', timeStyle: 'short' };
    case 'long':
      return { dateStyle: 'long', timeStyle: 'medium' };
    case 'datetime':
    default:
      return {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      };
  }
}

function getDateTimeFormatter(
  locale: string,
  timeZone: string,
  style: DateTimeFormatStyle | undefined
): Intl.DateTimeFormat {
  const key = `${locale}|${timeZone}|${style ?? 'datetime'}`;
  let formatter = dateTimeFormatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      timeZone,
      ...dateTimeFormatOptionsForStyle(style),
    });
    dateTimeFormatterCache.set(key, formatter);
  }
  return formatter;
}

/**
 * Formats a date/time value for a specific locale and timeZone. Both are
 * required arguments — there is no environment-implicit fallback.
 *
 * Throws `RangeError` if `value` does not parse to a valid Date.
 */
export function formatDateTime(value: Date | string | number, opts: FormatDateTimeOptions): string {
  const date = toDate(value);
  assertValidDate(date, value, 'formatDateTime');
  return getDateTimeFormatter(opts.locale, opts.timeZone, opts.style).format(date);
}

function getNumberFormatter(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${stableSerialize(options as Record<string, unknown>)}`;
  let formatter = numberFormatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, options);
    numberFormatterCache.set(key, formatter);
  }
  return formatter;
}

/** Formats a number for a specific locale. `locale` is required. */
export function formatNumber(value: number, opts: FormatNumberOptions): string {
  const { locale, ...rest } = opts;
  return getNumberFormatter(locale, rest).format(value);
}

/** Formats a currency amount for a specific locale/currency. Both are required. */
export function formatCurrency(value: number, opts: FormatCurrencyOptions): string {
  const { locale, currency, ...rest } = opts;
  return getNumberFormatter(locale, { ...rest, style: 'currency', currency }).format(value);
}

type RelativeTimeUnit = Intl.RelativeTimeFormatUnit;

const RELATIVE_TIME_THRESHOLDS: Array<{ unit: RelativeTimeUnit; ms: number }> = [
  { unit: 'year', ms: 365 * 24 * 60 * 60 * 1000 },
  { unit: 'month', ms: 30 * 24 * 60 * 60 * 1000 },
  { unit: 'week', ms: 7 * 24 * 60 * 60 * 1000 },
  { unit: 'day', ms: 24 * 60 * 60 * 1000 },
  { unit: 'hour', ms: 60 * 60 * 1000 },
  { unit: 'minute', ms: 60 * 1000 },
];

function getRelativeTimeFormatter(locale: string): Intl.RelativeTimeFormat {
  let formatter = relativeTimeFormatterCache.get(locale);
  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    relativeTimeFormatterCache.set(locale, formatter);
  }
  return formatter;
}

/**
 * Formats a Date relative to `opts.now` (defaults to `new Date()` — inject a
 * fixed value in tests) as a locale-appropriate relative-time string, e.g.
 * "3 days ago" / "3日前".
 */
export function formatRelativeTime(
  value: Date | string | number,
  opts: FormatRelativeTimeOptions
): string {
  const date = toDate(value);
  assertValidDate(date, value, 'formatRelativeTime');
  const now = opts.now ?? new Date();
  const diffMs = date.getTime() - now.getTime();
  const absMs = Math.abs(diffMs);
  const formatter = getRelativeTimeFormatter(opts.locale);

  for (const { unit, ms } of RELATIVE_TIME_THRESHOLDS) {
    if (absMs >= ms) {
      return formatter.format(Math.round(diffMs / ms), unit);
    }
  }
  return formatter.format(Math.round(diffMs / 1000), 'second');
}

export interface ResolveTimeZoneContext {
  /** Explicit override — wins over everything else. Use this to inject a fixed value in tests. */
  explicit?: string;
  /** Override the onboarding identity file path (test injection). */
  identityPath?: string;
}

/**
 * Resolves the timeZone to use for formatting. Precedence:
 *   1. `ctx.explicit`
 *   2. onboarding identity's `timeZone` field (`my-identity.json`), if present
 *      — as of I18N-05 the identity schema does not yet define this field,
 *      so this step is a no-op until a future schema revision adds it; the
 *      read is defensive/forward-compatible and never throws.
 *   3. `process.env.KYBERION_TIMEZONE`
 *   4. `'Asia/Tokyo'`
 */
export function resolveTimeZone(ctx?: ResolveTimeZoneContext): string {
  if (ctx?.explicit) return ctx.explicit;

  try {
    const identityPath =
      ctx?.identityPath ?? path.join(resolveActiveProfileRoot(), 'my-identity.json');
    if (safeExistsSync(identityPath)) {
      const parsed = JSON.parse(String(safeReadFile(identityPath, { encoding: 'utf8' }) || '{}'));
      const timeZone = String(parsed?.timeZone || parsed?.timezone || '').trim();
      if (timeZone) return timeZone;
    }
  } catch {
    // Fall through to env/default below.
  }

  const envTimeZone = process.env.KYBERION_TIMEZONE?.trim();
  if (envTimeZone) return envTimeZone;

  return DEFAULT_TIMEZONE;
}
