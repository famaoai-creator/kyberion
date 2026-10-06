/**
 * `pnpm kyberion learning harvest` — read every runtime log registered with the
 * learning-signal adapter, cluster recurring failures, and propose them into
 * the governed organization learning queue (plus runtime knowledge hints for
 * tenant-free clusters). Baseline runs the same harvest; this command is the
 * manual and dry-run entry point.
 */
import {
  builtinLearningSignalSources,
  harvestLearningSignals,
  type LearningHarvestReport,
} from '@agent/core';
import { defineScript, isDirectScript } from './lib/harness.js';

export function formatLearningHarvestReport(report: LearningHarvestReport): string[] {
  const lines = [
    `Learning-signal harvest at ${report.harvested_at}${report.dry_run ? ' (dry run)' : ''}`,
    `Proposed signals: ${report.signals}  Hints persisted: ${report.hints}`,
  ];
  for (const source of report.sources) {
    const status = source.error ? `error: ${source.error}` : `${source.observed} observed`;
    lines.push(
      `  - ${source.source}: ${status}, ${source.clusters} cluster(s), ${source.proposed.length} proposed` +
        (source.skipped_scope ? `, ${source.skipped_scope} outside the active tenant` : '')
    );
    for (const cluster of source.proposed) {
      lines.push(`      * ${cluster.title} — ${cluster.total} total (${cluster.new_count} new)`);
    }
  }
  return lines;
}

/** `--lookback-days N` or `--lookback-days=N`; undefined when absent or invalid. */
export function parseLookbackDays(argv: string[]): number | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const raw = arg.startsWith('--lookback-days=')
      ? arg.slice('--lookback-days='.length)
      : arg === '--lookback-days'
        ? argv[index + 1]
        : undefined;
    if (raw === undefined) continue;
    const days = Number(raw);
    return Number.isFinite(days) && days > 0 ? days : undefined;
  }
  return undefined;
}

export const runLearningSignals = defineScript({
  name: 'learning-harvest',
  flags: ['json', 'dry-run', 'quiet'],
  run: ({ argv, print, json, dryRun }) => {
    const lookbackDays = parseLookbackDays(argv);
    const report = harvestLearningSignals({
      sources: builtinLearningSignalSources(),
      dryRun,
      ...(lookbackDays ? { initialLookbackDays: lookbackDays } : {}),
    });
    if (json) {
      print(report);
      return;
    }
    print(formatLearningHarvestReport(report).join('\n'));
  },
});

if (
  isDirectScript(import.meta.url, 'learning_signals.ts') ||
  isDirectScript(import.meta.url, 'learning_signals.js')
) {
  void runLearningSignals();
}
