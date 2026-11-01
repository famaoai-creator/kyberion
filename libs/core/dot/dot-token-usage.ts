/**
 * MSN-STORE-BOUNDS-2: dot-token-usage.jsonl — retention and the day reader.
 *
 * Every consumer (the dot daily token cap, the organization budget governor)
 * needs only the current UTC day's rows, so the ledger is read with a
 * backward scan that stops one margin before the day starts (cost follows
 * today's rows, not the history), and is windowed at write time to
 * {@link DOT_TOKEN_USAGE_RETENTION_MS}. The window is far longer than a day,
 * so retention can never drop a row of the day being enforced (no mid-day
 * rotation); dropped rows go to the compaction archive (accounting evidence).
 */
import {
  writeTimeArchiveDir,
  maintainStoreAfterAppend,
  type AppendOnlyStorePolicy,
  type MaintainStoreOutcome,
} from '../append-only-store.js';
import { readJsonLinesSince } from '../jsonl-read.js';

export const DOT_TOKEN_USAGE_PATH = 'active/shared/runtime/dot-token-usage.jsonl';

const HOUR_MS = 60 * 60 * 1000;
/** Rows older than this leave the live ledger (into the archive). */
export const DOT_TOKEN_USAGE_RETENTION_MS = 3 * 24 * HOUR_MS;
/** Ledger size that triggers write-time window retention. */
export const DOT_TOKEN_USAGE_RETENTION_MIN_BYTES = 8 * 1024 * 1024;
/**
 * The day reader scans back to this long before the UTC day starts, so a row
 * whose `recorded_at` lags its `day` bucket (clock skew between processes)
 * is still found; rows are then selected by their `day` field.
 */
export const DOT_TOKEN_USAGE_READ_MARGIN_MS = 6 * HOUR_MS;

export interface DotTokenUsageEntry {
  dot_id: string;
  accounting_id?: string;
  /** UTC day bucket (YYYY-MM-DD) the tokens accrue to. */
  day: string;
  tokens: number;
  recorded_at: string;
}

interface DotTokenUsageStoreTuning {
  /** Retention threshold (tests inject small values). */
  minBytes?: number;
  /** Range-read chunk size (tests inject small values). */
  chunkBytes?: number;
  /** Archive directory (tests point it at a scratch dir). */
  archiveDir?: string;
}
let storeTuning: DotTokenUsageStoreTuning = {};

/** Test seam: override threshold / chunking / archive; call with `{}` to reset. */
export function setDotTokenUsageStoreTuningForTests(tuning: DotTokenUsageStoreTuning): void {
  storeTuning = { ...tuning };
}

function recordedAtMs(record: unknown): number | undefined {
  const raw = (record as Record<string, unknown> | null)?.recorded_at;
  if (typeof raw !== 'string') return undefined;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : undefined;
}

/** Explicit write-time policy for the token-usage ledger. */
export function dotTokenUsageRetentionPolicy(filePath: string): AppendOnlyStorePolicy {
  return {
    action: 'window',
    minBytes: storeTuning.minBytes ?? DOT_TOKEN_USAGE_RETENTION_MIN_BYTES,
    windowMs: DOT_TOKEN_USAGE_RETENTION_MS,
    timeOf: recordedAtMs,
    archiveDir: storeTuning.archiveDir ?? writeTimeArchiveDir(filePath),
  };
}

/** Write-time retention; call right after an append. Never throws. */
export function maintainDotTokenUsageAfterAppend(
  filePath: string,
  now: Date
): MaintainStoreOutcome {
  return maintainStoreAfterAppend(filePath, dotTokenUsageRetentionPolicy(filePath), {
    now,
    chunkBytes: storeTuning.chunkBytes,
  });
}

/**
 * Usage rows whose `day` bucket is `day` (YYYY-MM-DD, UTC), in append order.
 * Torn or malformed lines are skipped; size never makes the read fail.
 */
export function readDotTokenUsageForDay<T extends { day?: string } = DotTokenUsageEntry>(
  filePath: string,
  day: string
): T[] {
  const dayStart = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(dayStart)) return [];
  return readJsonLinesSince<T>(filePath, {
    onMalformed: 'skip',
    sinceMs: dayStart - DOT_TOKEN_USAGE_READ_MARGIN_MS,
    timeOf: recordedAtMs,
    chunkBytes: storeTuning.chunkBytes,
  }).filter((row) => row?.day === day);
}
