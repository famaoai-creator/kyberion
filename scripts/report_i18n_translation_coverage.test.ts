import { afterEach, describe, expect, it, vi } from 'vitest';

const sendOpsAlertMock = vi.hoisted(() => vi.fn());

vi.mock('@agent/core', async () => {
  const actual = await vi.importActual<typeof import('@agent/core')>('@agent/core');
  return {
    ...actual,
    sendOpsAlert: sendOpsAlertMock,
  };
});

vi.mock('@agent/core/ops-alert', async () => {
  const actual =
    await vi.importActual<typeof import('@agent/core/ops-alert')>('@agent/core/ops-alert');
  return { ...actual, sendOpsAlert: sendOpsAlertMock };
});

import { pathResolver, safeExistsSync, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core';
import type { VocabularyCatalogFile } from '@agent/core';
import {
  computeTranslationCoverageReport,
  detectCoverageRegressions,
  formatHumanReport,
  main,
  runAlertOnRegression,
  runReportI18nTranslationCoverage,
} from './report_i18n_translation_coverage.js';

const FIXTURE_DIR = pathResolver.sharedTmp('report-i18n-coverage-test');

function fixtureCatalog(): VocabularyCatalogFile {
  return {
    version: '1.0',
    default_locale: 'en',
    required_locales: ['en', 'ja'],
    domains: {
      cli: {
        cli_hello: { en: 'Hello', ja: 'こんにちは' },
        cli_bye: { en: 'Bye', ja: 'さようなら' },
      },
      chronos: {
        // ja missing here on purpose — this key is the one `missing_keys`
        // must surface for the `ja` locale.
        chronos_only_en: { en: 'Only English' },
      },
      // An empty namespace (mirrors the real catalog's `bridge`/`onboarding`
      // placeholders) — must report as vacuously 100% covered, not NaN/0%.
      empty_namespace: {},
    },
  };
}

describe('computeTranslationCoverageReport', () => {
  it('reports per-locale, per-namespace key/translated counts and missing keys', () => {
    const report = computeTranslationCoverageReport({
      catalog: fixtureCatalog(),
      now: new Date('2026-07-26T00:00:00.000Z'),
    });

    expect(report.status).toBe('ok');
    expect(report.total_keys).toBe(3); // cli_hello + cli_bye + chronos_only_en (empty_namespace contributes 0)
    expect(report.required_locales).toEqual(['en', 'ja']);

    const en = report.locales.find((l) => l.locale === 'en')!;
    expect(en.is_required).toBe(true);
    expect(en.key_count).toBe(3);
    expect(en.translated_count).toBe(3);
    expect(en.coverage_pct).toBe(100);

    const ja = report.locales.find((l) => l.locale === 'ja')!;
    expect(ja.is_required).toBe(true);
    expect(ja.key_count).toBe(3);
    expect(ja.translated_count).toBe(2);
    expect(ja.coverage_pct).toBeCloseTo(66.67, 1);
    const jaChronos = ja.namespaces.find((n) => n.namespace === 'chronos')!;
    expect(jaChronos.missing_keys).toEqual(['chronos:chronos_only_en']);
    const jaEmpty = ja.namespaces.find((n) => n.namespace === 'empty_namespace')!;
    expect(jaEmpty.key_count).toBe(0);
    expect(jaEmpty.coverage_pct).toBe(100);
    expect(jaEmpty.missing_keys).toEqual([]);
  });

  it('includes a locale present in entries but not yet in required_locales, flagged as not required', () => {
    const catalog = fixtureCatalog();
    catalog.domains.cli.cli_hello['qps-ploc'] = 'Ɥȩŀŀő';
    const report = computeTranslationCoverageReport({ catalog, now: new Date() });

    const candidate = report.locales.find((l) => l.locale === 'qps-ploc')!;
    expect(candidate).toBeDefined();
    expect(candidate.is_required).toBe(false);
    // Only cli_hello has a qps-ploc entry; cli_bye and chronos_only_en do not.
    expect(candidate.translated_count).toBe(1);
    expect(candidate.key_count).toBe(3);
  });

  it('returns an empty-but-valid report when the catalog cannot be loaded', () => {
    const report = computeTranslationCoverageReport({ catalog: null, now: new Date() });
    expect(report.status).toBe('ok');
    expect(report.total_keys).toBe(0);
    expect(report.locales).toEqual([]);
  });

  it('hand-verified against the real repository catalog (status namespace)', () => {
    // Cross-checked by hand against
    // knowledge/product/orchestration/user-facing-vocabulary.json: every
    // `status.*` key defines both `en` and `ja` (check:catalogs enforces
    // this for every required locale), so both must read back as fully
    // covered for that one namespace regardless of how many keys exist —
    // a loose count assertion (not a hardcoded total) so this test does not
    // flake if another in-flight change adds a status key.
    const report = computeTranslationCoverageReport();
    const en = report.locales.find((l) => l.locale === 'en');
    const ja = report.locales.find((l) => l.locale === 'ja');
    expect(en).toBeDefined();
    expect(ja).toBeDefined();
    const enStatus = en!.namespaces.find((n) => n.namespace === 'status')!;
    const jaStatus = ja!.namespaces.find((n) => n.namespace === 'status')!;
    expect(enStatus.key_count).toBeGreaterThan(0);
    expect(enStatus.key_count).toBe(enStatus.translated_count);
    expect(enStatus.missing_keys).toEqual([]);
    expect(jaStatus.key_count).toBe(enStatus.key_count);
    expect(jaStatus.key_count).toBe(jaStatus.translated_count);
    expect(jaStatus.missing_keys).toEqual([]);
  });
});

describe('detectCoverageRegressions', () => {
  const report = computeTranslationCoverageReport({
    catalog: fixtureCatalog(),
    now: new Date('2026-07-26T00:00:00.000Z'),
  });

  it('returns no regressions when there is no prior snapshot', () => {
    expect(detectCoverageRegressions(report, null)).toEqual([]);
  });

  it('returns no regressions for a locale newly seen (not in the prior snapshot)', () => {
    const previous = { recorded_at: '2026-07-01T00:00:00.000Z', locales: { en: 100 } };
    expect(detectCoverageRegressions(report, previous)).toEqual([]);
  });

  it('flags a locale whose coverage decreased since the prior snapshot', () => {
    const previous = {
      recorded_at: '2026-07-01T00:00:00.000Z',
      locales: { en: 100, ja: 100 },
    };
    const regressions = detectCoverageRegressions(report, previous);
    expect(regressions).toEqual([
      {
        locale: 'ja',
        previous_pct: 100,
        current_pct: report.locales.find((l) => l.locale === 'ja')!.coverage_pct,
      },
    ]);
  });

  it('does not flag a locale whose coverage held steady or improved', () => {
    const previous = { recorded_at: '2026-07-01T00:00:00.000Z', locales: { en: 100, ja: 0 } };
    expect(detectCoverageRegressions(report, previous)).toEqual([]);
  });
});

describe('runAlertOnRegression', () => {
  afterEach(() => {
    if (safeExistsSync(FIXTURE_DIR)) {
      safeRmSync(FIXTURE_DIR, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  it('records a fresh snapshot and does not alert when no prior snapshot exists', async () => {
    const { sendOpsAlert } = await import('@agent/core');
    const historyPath = pathResolver.sharedTmp('report-i18n-coverage-test/history.json');
    const report = computeTranslationCoverageReport({
      catalog: fixtureCatalog(),
      now: new Date('2026-07-26T00:00:00.000Z'),
    });

    const regressions = runAlertOnRegression(report, historyPath);

    expect(regressions).toEqual([]);
    expect(sendOpsAlert).not.toHaveBeenCalled();
    expect(safeExistsSync(historyPath)).toBe(true);
    const written = JSON.parse(String(safeReadFile(historyPath, { encoding: 'utf8' })));
    expect(written.locales.ja).toBeCloseTo(66.67, 1);
  });

  it('dispatches an ops alert and still records the new snapshot when coverage regressed', async () => {
    const { sendOpsAlert } = await import('@agent/core');
    const historyPath = pathResolver.sharedTmp('report-i18n-coverage-test/history.json');
    const firstReport = computeTranslationCoverageReport({
      catalog: fixtureCatalog(),
      now: new Date('2026-07-26T00:00:00.000Z'),
    });
    // Seed a snapshot where `ja` was fully covered.
    runAlertOnRegression(
      {
        ...firstReport,
        locales: firstReport.locales.map((l) =>
          l.locale === 'ja' ? { ...l, coverage_pct: 100 } : l
        ),
      },
      historyPath
    );
    vi.clearAllMocks();

    // Second run: `ja` is back down to its real (partial) coverage — a regression.
    const regressions = runAlertOnRegression(firstReport, historyPath);

    expect(regressions).toEqual([
      {
        locale: 'ja',
        previous_pct: 100,
        current_pct: firstReport.locales.find((l) => l.locale === 'ja')!.coverage_pct,
      },
    ]);
    expect(sendOpsAlert).toHaveBeenCalledTimes(1);
    expect(sendOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'warning',
        dedupe_key: 'i18n-translation-coverage-regression',
      })
    );
  });
});

describe('shared report output boundary', () => {
  afterEach(() => {
    if (safeExistsSync(FIXTURE_DIR)) {
      safeRmSync(FIXTURE_DIR, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  it('formats the report and regression details without writing to stdout directly', () => {
    const report = computeTranslationCoverageReport({
      catalog: fixtureCatalog(),
      now: new Date('2026-07-26T00:00:00.000Z'),
    });
    const output = formatHumanReport(
      report,
      [{ locale: 'ja', previous_pct: 100, current_pct: 66.67 }],
      true
    );

    expect(output).toContain('[report:i18n-coverage]');
    expect(output).toContain('ja: 100% -> 66.67%');
  });

  it('keeps alert history read-only for a dry-run and check invocation', async () => {
    const historyPath = pathResolver.sharedTmp('report-i18n-coverage-test/read-only.json');
    const original = JSON.stringify({ recorded_at: '2026-07-01T00:00:00.000Z', locales: {} });
    safeWriteFile(historyPath, original);
    const result = main(['--alert-on-regression'], {
      writeSideEffects: false,
      historyPath,
    });

    expect(result.alert_on_regression).toBe(true);
    expect(result.regressions).toEqual([]);
    expect(sendOpsAlertMock).not.toHaveBeenCalled();
    expect(String(safeReadFile(historyPath, { encoding: 'utf8' }))).toBe(original);
  });

  it('returns structured results through the shared harness', async () => {
    const result = await runReportI18nTranslationCoverage(['--json', '--dry-run', '--quiet']);

    expect(result?.report.status).toBe('ok');
    expect(result?.alert_on_regression).toBe(false);
  });
});
