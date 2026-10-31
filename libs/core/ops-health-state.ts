/**
 * ops-health-state — the small runtime-state receipts the ops-health
 * evaluator (ops-health.ts) reads. All live under
 * `active/shared/runtime/state/` (retention: review_required, see
 * storage-retention-catalog.json) and are validated through governed schemas.
 *
 * - backup-drill-last.json       written by the restore drill (success, failure, no-archive skip)
 * - <daemon>-starts.json         rolling 24h start history → restarts_1h / restarts_24h
 * - janitor-last-failure.json    written when a baseline-submitted janitor run exits non-zero
 */
import { defineCatalog } from './foundation/governed-catalog.js';
import { knowledge, shared } from './path-resolver.js';
import { safeExistsSync, safeLstat, safeMkdir } from './secure-io.js';
import { writeJson } from './foundation/json.js';
import * as nodePath from 'node:path';
import type { BackupDrillReceipt, JanitorFailureMarker } from './ops-health.js';

export const BACKUP_DRILL_RECEIPT_SUBPATH = 'runtime/state/backup-drill-last.json';
export const JANITOR_FAILURE_MARKER_SUBPATH = 'runtime/state/janitor-last-failure.json';
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function catalog<T>(id: string, schema: string, filePath: string) {
  return defineCatalog<T>({
    id,
    path: filePath,
    schema: knowledge(`product/schemas/${schema}`),
  });
}

function readState<T>(id: string, schema: string, filePath: string): T | null {
  if (!safeExistsSync(filePath)) return null;
  try {
    if (!safeLstat(filePath).isFile()) return null;
    return catalog<T>(id, schema, filePath).load();
  } catch {
    return null;
  }
}

function writeState<T>(id: string, schema: string, filePath: string, value: T): T {
  const validated = catalog<T>(id, schema, filePath).validate(value, filePath);
  safeMkdir(nodePath.dirname(filePath), { recursive: true });
  writeJson(filePath, validated);
  return validated;
}

export function backupDrillReceiptPath(): string {
  return shared(BACKUP_DRILL_RECEIPT_SUBPATH);
}

export function readBackupDrillReceipt(
  filePath = backupDrillReceiptPath()
): BackupDrillReceipt | null {
  return readState<BackupDrillReceipt>(
    'backup-drill-receipt',
    'backup-drill-receipt.schema.json',
    filePath
  );
}

export function writeBackupDrillReceipt(
  receipt: BackupDrillReceipt,
  filePath = backupDrillReceiptPath()
): BackupDrillReceipt {
  return writeState('backup-drill-receipt', 'backup-drill-receipt.schema.json', filePath, receipt);
}

export function janitorFailureMarkerPath(): string {
  return shared(JANITOR_FAILURE_MARKER_SUBPATH);
}

export function readJanitorFailureMarker(
  filePath = janitorFailureMarkerPath()
): JanitorFailureMarker | null {
  return readState<JanitorFailureMarker>(
    'janitor-failure-marker',
    'janitor-failure-marker.schema.json',
    filePath
  );
}

export function writeJanitorFailureMarker(
  marker: JanitorFailureMarker,
  filePath = janitorFailureMarkerPath()
): JanitorFailureMarker {
  return writeState(
    'janitor-failure-marker',
    'janitor-failure-marker.schema.json',
    filePath,
    marker
  );
}

export interface DaemonStartHistory {
  daemon_id: string;
  starts: string[];
}

export interface DaemonStartSummary {
  started_at: string;
  restarts_1h: number;
  restarts_24h: number;
}

export function daemonStartHistoryPath(daemonId: string): string {
  const safeId = daemonId.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return shared(`runtime/state/${safeId}-starts.json`);
}

/**
 * Pure: append `now` to the start history, keep the trailing 24h, and count
 * restarts (starts other than the current one) in the trailing 1h / 24h.
 */
export function appendDaemonStart(
  history: readonly string[],
  now: Date
): { starts: string[]; summary: DaemonStartSummary } {
  const nowMs = now.getTime();
  const kept = history.filter((entry) => {
    const ms = Date.parse(entry);
    return Number.isFinite(ms) && ms <= nowMs && nowMs - ms <= DAY_MS;
  });
  const starts = [...kept, now.toISOString()];
  const within = (windowMs: number) =>
    kept.filter((entry) => nowMs - Date.parse(entry) <= windowMs).length;
  return {
    starts,
    summary: {
      started_at: now.toISOString(),
      restarts_1h: within(HOUR_MS),
      restarts_24h: kept.length,
    },
  };
}

/**
 * Record one daemon start and return the restart counters to embed in its
 * heartbeat. Never throws — a failed write only loses crash-loop visibility.
 */
export function recordDaemonStart(
  daemonId: string,
  now = new Date(),
  filePath = daemonStartHistoryPath(daemonId)
): DaemonStartSummary {
  const previous =
    readState<DaemonStartHistory>(
      'daemon-start-history',
      'daemon-start-history.schema.json',
      filePath
    )?.starts ?? [];
  const { starts, summary } = appendDaemonStart(previous, now);
  try {
    writeState<DaemonStartHistory>(
      'daemon-start-history',
      'daemon-start-history.schema.json',
      filePath,
      { daemon_id: daemonId, starts }
    );
  } catch {
    // best effort
  }
  return summary;
}
