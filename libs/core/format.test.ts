import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from './secure-io.js';
import { getAllFiles } from './fs-utils.js';
import { pathResolver } from './path-resolver.js';
import {
  _getFormatCacheSizesForTests,
  _resetFormatCachesForTests,
  formatCurrency,
  formatDateTime,
  formatNumber,
  formatRelativeTime,
  resolveTimeZone,
} from './format.js';

const testRoot = pathResolver.sharedTmp('format-test');

function fixturePath(name: string): string {
  return `${testRoot}/${name}`;
}

function writeIdentityFixture(name: string, content: unknown): string {
  if (!safeExistsSync(testRoot)) safeMkdir(testRoot, { recursive: true });
  const p = fixturePath(name);
  safeWriteFile(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return p;
}

const savedTimeZone = process.env.KYBERION_TIMEZONE;

beforeEach(() => {
  delete process.env.KYBERION_TIMEZONE;
  _resetFormatCachesForTests();
});

afterEach(() => {
  if (savedTimeZone === undefined) delete process.env.KYBERION_TIMEZONE;
  else process.env.KYBERION_TIMEZONE = savedTimeZone;
  if (safeExistsSync(testRoot)) safeRmSync(testRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// A fixed instant, deliberately not on a day/hour boundary, so ja/en golden
// strings are unambiguous regardless of when this test runs.
const FIXED_INSTANT = '2026-03-15T04:30:00.000Z'; // 2026-03-15 13:30 JST / 2026-03-15 00:30 EDT

describe('formatDateTime', () => {
  it('produces a ja-JP golden string for a fixed timeZone', () => {
    const result = formatDateTime(FIXED_INSTANT, { locale: 'ja-JP', timeZone: 'Asia/Tokyo' });
    expect(result).toBe('2026/03/15 13:30');
  });

  it('produces an en-US golden string for a fixed timeZone', () => {
    const result = formatDateTime(FIXED_INSTANT, { locale: 'en-US', timeZone: 'Asia/Tokyo' });
    expect(result).toBe('03/15/2026, 01:30 PM');
  });

  it('accepts a Date instance and a numeric epoch, producing identical output', () => {
    const asDate = new Date(FIXED_INSTANT);
    const asNumber = asDate.getTime();
    const opts = { locale: 'ja-JP', timeZone: 'Asia/Tokyo' } as const;
    expect(formatDateTime(asDate, opts)).toBe(formatDateTime(asNumber, opts));
    expect(formatDateTime(FIXED_INSTANT, opts)).toBe(formatDateTime(asDate, opts));
  });

  it('supports the date/time/short/long style variants without throwing', () => {
    const opts = { locale: 'en-US', timeZone: 'Asia/Tokyo' } as const;
    expect(formatDateTime(FIXED_INSTANT, { ...opts, style: 'date' })).toMatch(/2026/);
    expect(formatDateTime(FIXED_INSTANT, { ...opts, style: 'time' })).toMatch(/01:30 PM/);
    expect(typeof formatDateTime(FIXED_INSTANT, { ...opts, style: 'short' })).toBe('string');
    expect(typeof formatDateTime(FIXED_INSTANT, { ...opts, style: 'long' })).toBe('string');
  });

  it('renders the same instant differently across timeZones (DST edge)', () => {
    // 2026-03-08 07:30 UTC is *after* the US spring-forward transition
    // (2026-03-08 02:00 America/New_York local time), so this exercises the
    // DST boundary: America/New_York should show EDT (UTC-4), not EST (UTC-5).
    const dstInstant = '2026-03-08T07:30:00.000Z';
    const nyResult = formatDateTime(dstInstant, {
      locale: 'en-US',
      timeZone: 'America/New_York',
      style: 'time',
    });
    // 07:30 UTC - 4h (EDT) = 03:30 local.
    expect(nyResult).toMatch(/03:30/);
  });

  it('throws RangeError for an invalid date value', () => {
    expect(() => formatDateTime('not-a-date', { locale: 'en-US', timeZone: 'Asia/Tokyo' })).toThrow(
      RangeError
    );
    expect(() => formatDateTime(Number.NaN, { locale: 'en-US', timeZone: 'Asia/Tokyo' })).toThrow(
      RangeError
    );
  });

  it('caches formatter instances by (locale, timeZone, style) key', () => {
    const opts = { locale: 'ja-JP', timeZone: 'Asia/Tokyo', style: 'date' } as const;
    formatDateTime(FIXED_INSTANT, opts);
    formatDateTime(FIXED_INSTANT, opts);
    formatDateTime(FIXED_INSTANT, opts);
    expect(_getFormatCacheSizesForTests().dateTime).toBe(1);

    // A different style must not reuse the same cached formatter (correctness,
    // not just "some" caching): different options must yield different output
    // AND grow the cache.
    const dateOnly = formatDateTime(FIXED_INSTANT, opts);
    const withTime = formatDateTime(FIXED_INSTANT, { ...opts, style: 'datetime' });
    expect(dateOnly).not.toBe(withTime);
    expect(_getFormatCacheSizesForTests().dateTime).toBe(2);
  });
});

describe('formatNumber', () => {
  it('formats with locale-specific grouping', () => {
    expect(formatNumber(1234567.891, { locale: 'en-US', maximumFractionDigits: 2 })).toBe(
      '1,234,567.89'
    );
  });

  it('respects explicit NumberFormatOptions', () => {
    expect(
      formatNumber(0.4321, { locale: 'en-US', style: 'percent', maximumFractionDigits: 1 })
    ).toBe('43.2%');
  });

  it('caches formatter instances by (locale, options) key', () => {
    const opts = { locale: 'en-US', maximumFractionDigits: 1 } as const;
    formatNumber(1, opts);
    formatNumber(2, opts);
    expect(_getFormatCacheSizesForTests().number).toBe(1);
    formatNumber(3, { locale: 'en-US', maximumFractionDigits: 2 });
    expect(_getFormatCacheSizesForTests().number).toBe(2);
  });
});

describe('formatCurrency', () => {
  it('formats JPY with no fraction digits by default (ja-JP convention)', () => {
    expect(formatCurrency(1500, { locale: 'ja-JP', currency: 'JPY' })).toBe('￥1,500');
  });

  it('formats USD with two fraction digits by default (en-US convention)', () => {
    expect(formatCurrency(19.5, { locale: 'en-US', currency: 'USD' })).toBe('$19.50');
  });
});

describe('formatRelativeTime', () => {
  const now = new Date('2026-07-26T12:00:00.000Z');

  it('formats a past instant in the past tense', () => {
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    expect(formatRelativeTime(threeDaysAgo, { locale: 'en-US', now })).toBe('3 days ago');
    expect(formatRelativeTime(threeDaysAgo, { locale: 'ja-JP', now })).toBe('3 日前');
  });

  it('formats a future instant in the future tense', () => {
    const inTwoHours = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    expect(formatRelativeTime(inTwoHours, { locale: 'en-US', now })).toBe('in 2 hours');
  });

  it('defaults `now` to the current time when not supplied', () => {
    const almostNow = new Date(Date.now() - 5000);
    expect(formatRelativeTime(almostNow, { locale: 'en-US' })).toMatch(/second/);
  });

  it('throws RangeError for an invalid date value', () => {
    expect(() => formatRelativeTime('not-a-date', { locale: 'en-US', now })).toThrow(RangeError);
  });
});

describe('resolveTimeZone', () => {
  it('honors the explicit override above everything', () => {
    process.env.KYBERION_TIMEZONE = 'America/New_York';
    expect(resolveTimeZone({ explicit: 'Europe/London' })).toBe('Europe/London');
  });

  it('falls back to KYBERION_TIMEZONE when no explicit override and no identity timeZone', () => {
    process.env.KYBERION_TIMEZONE = 'America/New_York';
    const identityPath = writeIdentityFixture('identity-no-tz.json', { name: 'test' });
    expect(resolveTimeZone({ identityPath })).toBe('America/New_York');
  });

  it('prefers an identity-file timeZone field over the env var, if present', () => {
    process.env.KYBERION_TIMEZONE = 'America/New_York';
    const identityPath = writeIdentityFixture('identity-with-tz.json', {
      name: 'test',
      timeZone: 'Europe/Paris',
    });
    expect(resolveTimeZone({ identityPath })).toBe('Europe/Paris');
  });

  it('defaults to Asia/Tokyo when nothing else resolves', () => {
    const identityPath = fixturePath('does-not-exist.json');
    expect(resolveTimeZone({ identityPath })).toBe('Asia/Tokyo');
  });

  it('tolerates a malformed identity file and falls through', () => {
    const identityPath = writeIdentityFixture('identity-malformed.json', '{not json');
    expect(resolveTimeZone({ identityPath })).toBe('Asia/Tokyo');
  });

  it('ignores an identity file reached through a symlink', () => {
    const targetPath = writeIdentityFixture('identity-outside.json', {
      timeZone: 'America/New_York',
    });
    const linkedPath = fixturePath('identity-linked.json');
    safeSymlinkSync(targetPath, linkedPath);
    expect(resolveTimeZone({ identityPath: linkedPath })).toBe('Asia/Tokyo');
  });
});

describe('Intl ICU data availability', () => {
  it('has full ICU (named timeZones resolve to non-UTC offsets)', () => {
    // With small-icu builds, Intl.DateTimeFormat silently ignores non-UTC
    // timeZones or throws; this assertion fails loudly if that regresses.
    const tokyo = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tokyo',
      timeZoneName: 'short',
    }).format(new Date(FIXED_INSTANT));
    expect(tokyo).toMatch(/GMT\+9|JST/);
  });
});

const EXCLUDED_HARDCODING_PATH_SEGMENTS = [
  '/node_modules/',
  '/dist/',
  '/.next/',
  '/coverage/',
  '/native-pptx-engine/examples/',
  '/native-xlsx-engine/examples/',
  '/tools/adf-replay-extension/',
  '/tools/meet-copilot-extension/',
];

function isArgumentLessLocaleCallGuardScope(relPath: string): boolean {
  if (!/\.(ts|tsx)$/.test(relPath)) return false;
  if (/\.test\.tsx?$/.test(relPath)) return false;
  if (EXCLUDED_HARDCODING_PATH_SEGMENTS.some((segment) => relPath.includes(segment))) {
    return false;
  }
  return (
    relPath.startsWith('libs/') ||
    relPath.startsWith('scripts/') ||
    relPath.startsWith('satellites/') ||
    relPath.startsWith('presence/')
  );
}

describe('I18N-05 ratchet: no argument-less toLocaleString()/toLocaleTimeString()', () => {
  it('finds zero argument-less calls in implementation code', () => {
    const rootDir = pathResolver.rootDir();
    const pattern = /\.toLocaleString\(\)|\.toLocaleTimeString\(\)/;

    const offenders = getAllFiles(rootDir)
      .map((absPath) => path.relative(rootDir, absPath).split(path.sep).join('/'))
      .filter((relPath) => isArgumentLessLocaleCallGuardScope(relPath))
      .filter((relPath) => {
        const content = String(safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }));
        return pattern.test(content);
      });

    expect(offenders).toEqual([]);
  });
});
