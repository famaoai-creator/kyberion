/**
 * WI-07: `pnpm inventory harvest` — collect Kyberion usage demand signals
 * and attach them to matching entries (optionally draft suggestions for
 * unmatched, frequent, on-demand signals).
 */
import {
  listWorkInventoryEntries,
  saveWorkInventoryEntry,
  type WorkInventoryEntry,
} from '@agent/core/work-inventory';
import {
  attachDemandSignals,
  collectKyberionDemandSignals,
  matchSignalsToEntries,
  suggestEntriesFromSignals,
  type DemandSignal,
} from '@agent/core/work-inventory-harvest';
import {
  formatTable,
  hasFlag,
  parseDaysFlag,
  resolveScope,
  truncate,
} from './work-inventory-cli-shared.js';
import type { WorkInventoryCliOptions } from './work-inventory-cli-entries.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface HarvestResult {
  signals: DemandSignal[];
  entries_updated: WorkInventoryEntry[];
  suggested: WorkInventoryEntry[];
  dry_run: boolean;
}

export function runHarvest(
  argv: string[],
  options: WorkInventoryCliOptions & { dryRun: boolean; now?: Date }
): HarvestResult {
  const scope = resolveScope(argv);
  const rootDir = options.rootDir;
  const now = options.now ?? new Date();
  const days = parseDaysFlag(argv);
  const includeUnscoped = hasFlag(argv, '--include-unscoped');
  const suggest = hasFlag(argv, '--suggest');

  const signals = collectKyberionDemandSignals({
    rootDir,
    now,
    since: new Date(now.getTime() - days * MS_PER_DAY),
    until: now,
    ...(scope.tenant_slug ? { tenantSlug: scope.tenant_slug } : {}),
    includeUnscoped,
  });

  const entries = listWorkInventoryEntries(scope, { rootDir });
  const matched = matchSignalsToEntries(entries, signals);
  const entriesUpdated: WorkInventoryEntry[] = [];
  for (const entry of entries) {
    const entrySignals = matched.get(entry.entry_id);
    if (!entrySignals || entrySignals.length === 0) continue;
    const updated = attachDemandSignals(entry, entrySignals, now);
    entriesUpdated.push(options.dryRun ? updated : saveWorkInventoryEntry(updated, { rootDir }));
  }

  let suggested: WorkInventoryEntry[] = [];
  if (suggest) {
    suggested = suggestEntriesFromSignals(signals, entries, { scope, now });
    if (!options.dryRun) {
      suggested = suggested.map((entry) => saveWorkInventoryEntry(entry, { rootDir }));
    }
  }

  return { signals, entries_updated: entriesUpdated, suggested, dry_run: options.dryRun };
}

export function formatHarvest(result: HarvestResult): string {
  const lines = [
    `${result.dry_run ? '(dry-run) ' : ''}signals: ${result.signals.length}`,
    `entries updated: ${result.entries_updated.length}`,
    `suggested drafts: ${result.suggested.length}`,
  ];
  if (result.signals.length > 0) {
    lines.push(
      '',
      formatTable(
        ['signature', 'kind', 'count', 'per_week', 'origin'],
        result.signals
          .slice(0, 20)
          .map((signal) => [
            truncate(signal.signature, 48),
            signal.kind,
            String(signal.count),
            signal.per_week.toFixed(2),
            signal.origin ?? 'unknown',
          ])
      )
    );
  }
  return lines.join('\n');
}
