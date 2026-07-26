#!/usr/bin/env node
/**
 * report_i18n_translation_coverage.ts — I18N-08: translation-ops instrument.
 *
 * **This is not a gate.** `pnpm check:catalogs`
 * (`scripts/check_catalog_integrity.ts`) already FAILS the build the moment
 * a key is missing an entry for any `required_locales` member — that is the
 * enforcement path, and it stays exactly where it is. This script answers a
 * different question that `check:catalogs` cannot: "how far along is a
 * locale, namespace by namespace, and which specific keys are still
 * missing?" That is the instrument you read when deciding whether a
 * still-growing locale (e.g. a pseudo-locale being built out towards
 * promotion) is ready to move from merely *present* in the catalog to
 * *required* — never a substitute for `pnpm check:catalogs` itself.
 *
 * The locale list is derived at runtime from the catalog (`required_locales`
 * unioned with every locale actually present in any entry) — never
 * hardcoded here — so a newly added locale (required or still being grown
 * out before promotion) shows up on the very next run with zero code
 * changes on this side.
 *
 * Two CLI modes:
 *
 *   pnpm report:i18n-coverage              — human-readable coverage report
 *   pnpm report:i18n-coverage -- --json     — machine-readable report object
 *
 *   pnpm report:i18n-coverage -- --alert-on-regression
 *     Additionally compares the current per-locale coverage percentage
 *     against the last recorded snapshot (`active/shared/tmp/
 *     i18n-drift-audit/coverage-history.json`) and, if any *required*
 *     locale's coverage dropped since that snapshot, records/dispatches an
 *     ops alert through the repository-managed alert sink (mirrors
 *     `scripts/watch_tenant_drift.ts`'s `--alert` convention) before
 *     recording the new snapshot. Intended for the scheduled
 *     `pipelines/i18n-drift-audit.json` run, not routine local use.
 */
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { withExecutionContext } from '@agent/core/governance';
import {
  loadVocabularyCatalog,
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
  sendOpsAlert,
  type OpsAlertInput,
  type VocabularyCatalogFile,
} from '@agent/core';

export interface NamespaceCoverageStat {
  namespace: string;
  key_count: number;
  translated_count: number;
  coverage_pct: number;
  missing_keys: string[];
}

export interface LocaleCoverageStat {
  locale: string;
  is_required: boolean;
  key_count: number;
  translated_count: number;
  coverage_pct: number;
  namespaces: NamespaceCoverageStat[];
}

export interface TranslationCoverageReport {
  /** Always `'ok'` — this report never fails a build. See the header
   *  comment above: `pnpm check:catalogs` is the gate, this is the
   *  instrument. Kept as a field (rather than omitted) so this report's
   *  shape still matches the neighbouring `check_*.ts` reports
   *  (`status` / `checked_at` / `violations`). */
  status: 'ok';
  checked_at: string;
  default_locale: string;
  required_locales: string[];
  total_keys: number;
  locales: LocaleCoverageStat[];
  /** Always empty — see `status`. */
  violations: string[];
}

export interface CoverageHistorySnapshot {
  recorded_at: string;
  locales: Record<string, number>;
}

function roundPct(translated: number, total: number): number {
  // A namespace with zero keys (e.g. `bridge`/`onboarding` are currently
  // empty placeholders in the catalog) is vacuously fully covered — there is
  // nothing to translate, so reporting 0% would be misleading noise.
  if (total === 0) return 100;
  return Math.round((translated / total) * 10000) / 100;
}

function collectAllLocales(catalog: VocabularyCatalogFile): string[] {
  const locales = new Set<string>(catalog.required_locales || []);
  for (const entries of Object.values(catalog.domains || {})) {
    for (const entry of Object.values(entries || {})) {
      for (const locale of Object.keys(entry || {})) locales.add(locale);
    }
  }
  return Array.from(locales).sort();
}

export function computeTranslationCoverageReport(
  options: { catalog?: VocabularyCatalogFile | null; now?: Date } = {}
): TranslationCoverageReport {
  const now = options.now ?? new Date();
  const catalog = options.catalog !== undefined ? options.catalog : loadVocabularyCatalog();
  if (!catalog) {
    return {
      status: 'ok',
      checked_at: now.toISOString(),
      default_locale: '',
      required_locales: [],
      total_keys: 0,
      locales: [],
      violations: [],
    };
  }

  const requiredLocales = catalog.required_locales || [];
  const allLocales = collectAllLocales(catalog);
  const namespaceNames = Object.keys(catalog.domains || {}).sort();

  const locales: LocaleCoverageStat[] = allLocales.map((locale) => {
    const namespaces: NamespaceCoverageStat[] = namespaceNames.map((namespace) => {
      const entries = catalog.domains?.[namespace] || {};
      const keys = Object.keys(entries).sort();
      const missingKeys = keys.filter((key) => !entries[key]?.[locale]);
      const translatedCount = keys.length - missingKeys.length;
      return {
        namespace,
        key_count: keys.length,
        translated_count: translatedCount,
        coverage_pct: roundPct(translatedCount, keys.length),
        missing_keys: missingKeys.map((key) => `${namespace}:${key}`),
      };
    });
    const keyCount = namespaces.reduce((sum, ns) => sum + ns.key_count, 0);
    const translatedCount = namespaces.reduce((sum, ns) => sum + ns.translated_count, 0);
    return {
      locale,
      is_required: requiredLocales.includes(locale),
      key_count: keyCount,
      translated_count: translatedCount,
      coverage_pct: roundPct(translatedCount, keyCount),
      namespaces,
    };
  });

  const totalKeys = namespaceNames.reduce(
    (sum, namespace) => sum + Object.keys(catalog.domains?.[namespace] || {}).length,
    0
  );

  return {
    status: 'ok',
    checked_at: now.toISOString(),
    default_locale: catalog.default_locale || '',
    required_locales: requiredLocales,
    total_keys: totalKeys,
    locales,
    violations: [],
  };
}

function printHumanReport(report: TranslationCoverageReport): void {
  console.log(
    `[report:i18n-coverage] ${report.total_keys} key(s) across ${report.locales.length} locale(s) seen ` +
      `(default=${report.default_locale || 'n/a'}, required=${report.required_locales.join(', ') || 'none'})`
  );
  console.log(
    '[report:i18n-coverage] this is a coverage instrument, not a gate — pnpm check:catalogs is the gate.'
  );
  for (const locale of report.locales) {
    const tag = locale.is_required ? 'required' : 'not required yet (candidate)';
    console.log(
      `\n${locale.locale} (${tag}): ${locale.translated_count}/${locale.key_count} keys (${locale.coverage_pct}%)`
    );
    for (const ns of locale.namespaces) {
      if (ns.key_count === 0) continue;
      console.log(
        `  ${ns.namespace}: ${ns.translated_count}/${ns.key_count} (${ns.coverage_pct}%)`
      );
      for (const key of ns.missing_keys) {
        console.log(`    missing: ${key}`);
      }
    }
  }
}

function defaultHistoryPath(): string {
  // NOT active/shared/tmp/: that is a 24h-TTL consumables floor by contract,
  // and this audit runs weekly. The janitor would delete the history between
  // runs, so every run would find no prior snapshot and the regression
  // comparison would silently never fire — the audit would look healthy
  // precisely because it had lost the ability to detect anything.
  //
  // active/shared/runtime/reports is the declared home for generated reports
  // (storage-retention-catalog: artifact_class "report", 90d TTL, audited
  // deletes, 14d trash grace), which comfortably outlives a weekly cadence.
  // Deliberately not under knowledge/ either: this file is rewritten on every
  // run, and knowledge/ writes invalidate the generated knowledge index, so
  // each audit would leave the tree dirty and fail check:catalogs.
  return pathResolver.rootResolve('active/shared/runtime/reports/i18n-coverage-history.json');
}

function loadHistory(historyPath: string): CoverageHistorySnapshot | null {
  if (!safeExistsSync(historyPath)) return null;
  try {
    return JSON.parse(
      String(safeReadFile(historyPath, { encoding: 'utf8' }))
    ) as CoverageHistorySnapshot;
  } catch {
    return null;
  }
}

function writeHistory(historyPath: string, snapshot: CoverageHistorySnapshot): void {
  // Explicit persona context — the same ceremony check_i18n_hardcoding.ts
  // uses for i18n-baseline.json. Without it the write depends on whatever
  // authority the caller happens to carry: it succeeds inside a pipeline run
  // and throws when the script is invoked directly, which is the harder case
  // to notice because the weekly pipeline is the path that looks healthy.
  withExecutionContext('ecosystem_architect', () => {
    safeMkdir(path.dirname(historyPath), { recursive: true });
    safeWriteFile(historyPath, JSON.stringify(snapshot, null, 2));
  });
}

export interface CoverageRegression {
  locale: string;
  previous_pct: number;
  current_pct: number;
}

/**
 * Compares the current report's per-locale coverage against a prior
 * snapshot. A regression is only reported for a locale the snapshot already
 * knew about (a brand-new locale — nothing recorded yet — is growth, not
 * regression) and only when its percentage strictly decreased.
 */
export function detectCoverageRegressions(
  report: TranslationCoverageReport,
  previous: CoverageHistorySnapshot | null
): CoverageRegression[] {
  if (!previous) return [];
  const regressions: CoverageRegression[] = [];
  for (const locale of report.locales) {
    const previousPct = previous.locales[locale.locale];
    if (previousPct === undefined) continue;
    if (locale.coverage_pct < previousPct) {
      regressions.push({
        locale: locale.locale,
        previous_pct: previousPct,
        current_pct: locale.coverage_pct,
      });
    }
  }
  return regressions;
}

function buildRegressionAlert(
  report: TranslationCoverageReport,
  regressions: CoverageRegression[]
): OpsAlertInput {
  return {
    severity: 'warning',
    title: 'Translation coverage regressed for one or more locales',
    context: {
      checked_at: report.checked_at,
      regressions,
    },
    recommendation:
      'Run pnpm report:i18n-coverage -- --json to see the newly-missing keys per locale, then either restore the translations or confirm the regression was an intentional catalog restructure.',
    options: [
      'Run pnpm report:i18n-coverage locally to inspect the affected locale(s) and namespace(s)',
      'Check recent commits touching knowledge/product/orchestration/user-facing-vocabulary.json',
    ],
    dedupe_key: 'i18n-translation-coverage-regression',
  };
}

export function runAlertOnRegression(
  report: TranslationCoverageReport,
  historyPath: string = defaultHistoryPath()
): CoverageRegression[] {
  const previous = loadHistory(historyPath);
  const regressions = detectCoverageRegressions(report, previous);
  if (regressions.length > 0) {
    sendOpsAlert(buildRegressionAlert(report, regressions));
  }
  const snapshot: CoverageHistorySnapshot = {
    recorded_at: report.checked_at,
    locales: Object.fromEntries(
      report.locales.map((locale) => [locale.locale, locale.coverage_pct])
    ),
  };
  writeHistory(historyPath, snapshot);
  return regressions;
}

export function main(): void {
  const asJson = process.argv.includes('--json');
  const alertOnRegression = process.argv.includes('--alert-on-regression');
  const report = computeTranslationCoverageReport();

  let regressions: CoverageRegression[] = [];
  if (alertOnRegression) {
    regressions = runAlertOnRegression(report);
  }

  if (asJson) {
    console.log(JSON.stringify(alertOnRegression ? { ...report, regressions } : report, null, 2));
  } else {
    printHumanReport(report);
    if (alertOnRegression) {
      if (regressions.length === 0) {
        console.log('\n[report:i18n-coverage] no coverage regression since the last recorded run.');
      } else {
        console.warn(
          `\n[report:i18n-coverage] ${regressions.length} regression(s) detected and alerted:`
        );
        for (const regression of regressions) {
          console.warn(
            `  ${regression.locale}: ${regression.previous_pct}% -> ${regression.current_pct}%`
          );
        }
      }
    }
  }
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main();
}
