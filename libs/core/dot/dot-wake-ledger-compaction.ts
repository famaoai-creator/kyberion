/**
 * Replay-safe compaction of `dot-wake-ledger.jsonl`, on the shared parked
 * rewrite engine (`rewriteStoreLines` in append-only-store.ts).
 *
 * Fold rule (unchanged): a (dot_id, trigger_key) pair consumed by a terminal
 * row (`rejected`, or `delivered` without `trigger_retained`) keeps only its
 * last consuming row — the consumed set is identical. Keys still live keep
 * every row: backoff counts consecutive failures, so folding a live key would
 * reset its retry schedule. Rows without a usable key, malformed (torn) lines
 * and lines over the per-line guard pass through verbatim.
 *
 * The engine owns the race safety: the live file is parked aside, a writer
 * recreating it is merged only on EEXIST, and any other failure (torn bytes,
 * ENOSPC, a non-converging merge) restores the raw union — never drops it.
 * The pre-compaction union is archived next to the ledger
 * (`writeTimeArchiveDir`), which the dot writer role can write.
 */
import * as path from 'node:path';
import { createLogger } from '../logger.js';
import { withLockSync } from '../foundation/lock-utils.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import {
  rewriteStoreLines,
  rotatedSegmentStem,
  writeTimeArchiveDir,
  type StoreLineFilter,
  type StoreScanOptions,
} from '../append-only-store.js';
import { jsonlFileSize } from '../jsonl-read.js';
import { safeExistsSync } from '../secure-io.js';

/** Compact only when the ledger is large — hot sweeps stat once and skip. */
export const DOT_WAKE_LEDGER_COMPACT_MIN_BYTES = 8 * 1024 * 1024;
const DOT_LEDGER_COMPACT_LOCK = 'dot-wake-ledger-compact';
const logger = createLogger('dot-wake-ledger-compaction');

export interface DotWakeLedgerCompactionResult {
  compacted: boolean;
  before_lines: number;
  after_lines: number;
  merged_during_compaction: number;
  archive_path?: string;
}

function ledgerConsumedKey(row: Record<string, unknown>): string | undefined {
  if (typeof row?.dot_id !== 'string' || typeof row?.trigger_key !== 'string') return undefined;
  return `${row.dot_id} ${row.trigger_key}`;
}

function isConsumingLedgerRow(row: Record<string, unknown>): boolean {
  return (
    row.outcome === 'rejected' || (row.outcome === 'delivered' && row.trigger_retained !== true)
  );
}

function parseLedgerRow(text: string): Record<string, unknown> | undefined {
  try {
    const value = parseSafeJsonInput(text, 'dot wake-ledger row');
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined; // torn / malformed: kept verbatim
  }
}

/** The ledger fold as a line filter: last consuming index per consumed key. */
export function dotWakeLedgerFoldFilter(): StoreLineFilter {
  const lastConsumedAt = new Map<string, number>();
  return {
    observe(text, index) {
      const row = parseLedgerRow(text);
      const key = row && ledgerConsumedKey(row);
      if (row && key && isConsumingLedgerRow(row)) lastConsumedAt.set(key, index);
    },
    keep(text, index) {
      const row = parseLedgerRow(text);
      const key = row && ledgerConsumedKey(row);
      if (!key) return true;
      const last = lastConsumedAt.get(key);
      return last === undefined || index === last;
    },
  };
}

export function compactDotWakeLedgerAt(
  livePath: string,
  options: StoreScanOptions & { compactMinBytes?: number; now?: Date } = {}
): DotWakeLedgerCompactionResult {
  const skipped = {
    compacted: false,
    before_lines: 0,
    after_lines: 0,
    merged_during_compaction: 0,
  };
  return withLockSync(DOT_LEDGER_COMPACT_LOCK, () => {
    if (!safeExistsSync(livePath)) return skipped;
    if (jsonlFileSize(livePath) < (options.compactMinBytes ?? DOT_WAKE_LEDGER_COMPACT_MIN_BYTES))
      return skipped;
    const stamp = (options.now ?? new Date())
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\..*$/, '');
    const archivePath = path.join(
      writeTimeArchiveDir(livePath),
      `${rotatedSegmentStem(livePath)}.${stamp}Z-${process.pid}.jsonl`
    );
    const result = rewriteStoreLines(livePath, dotWakeLedgerFoldFilter(), {
      chunkBytes: options.chunkBytes,
      maxLineBytes: options.maxLineBytes,
      archivePath,
      label: 'wake-ledger compaction',
    });
    if (!result) return skipped;
    if (result.published) {
      logger.info(
        `[DOT] wake-ledger compacted: ${result.before} -> ${result.after} rows (${result.merged} live merge(s)), union archived to ${result.archivePath}`
      );
    }
    return {
      compacted: result.published,
      before_lines: result.before,
      after_lines: result.after,
      merged_during_compaction: result.merged,
      ...(result.archivePath ? { archive_path: result.archivePath } : {}),
    };
  });
}
