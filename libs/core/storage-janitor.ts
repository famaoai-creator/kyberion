import * as nodePath from 'node:path';
import { sharedTmp, shared } from './path-resolver.js';
import {
  safeReaddir,
  safeReadFile,
  safeStat,
  safeUnlinkSync,
  safeExistsSync,
  safeWriteFile,
} from './secure-io.js';
import { logger } from './core.js';

export const DEFAULT_TMP_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_LOG_RETENTION_DAYS = 30;

/**
 * Retention rules for governed runtime artifacts under active/shared/runtime/.
 * These directories are written by the browser-bridge / intent-driven automation
 * flow and previously had no TTL governance (review finding OP-M3).
 *  - browser-receipts: execution evidence — kept ~90d to align with audit retention.
 *  - procedure-deltas: self-repair artifacts — short-lived until promoted (~14d).
 */
const DAY_MS = 24 * 60 * 60 * 1000;
export const RUNTIME_RETENTION: ReadonlyArray<{ subdir: string; ttlMs: number }> = [
  { subdir: 'browser-receipts', ttlMs: 90 * DAY_MS },
  { subdir: 'procedure-deltas', ttlMs: 14 * DAY_MS },
];

export interface ScanTmpOptions {
  dryRun: boolean;
  ttlMs?: number;
}

export interface ScanTmpResult {
  expired: string[];
  deleted: string[];
}

export interface RotateLogsOptions {
  dryRun: boolean;
  retentionDays?: number;
}

export interface RotateLogsResult {
  expired: string[];
  rotated: string[];
}

export interface ScanDataVaultOptions {
  dryRun: boolean;
}

export interface ScanDataVaultResult {
  expired: string[];
  deleted: string[];
}

export interface ScanRuntimeResult {
  expired: string[];
  deleted: string[];
}

export interface JanitorReport {
  expiredTmp: number;
  deletedTmp: number;
  expiredLogs: number;
  rotatedLogs: number;
  expiredDataVault: number;
  deletedDataVault: number;
  expiredRuntime: number;
  deletedRuntime: number;
  errors: string[];
  timestamp: string;
  dryRun: boolean;
}

/** @deprecated Use JanitorReport */
export interface LegacyJanitorReport {
  scanned_tmp: unknown[];
  rotated_logs: unknown[];
  scanned_data_vault: unknown[];
  removed: number;
}

function collectFiles(dir: string): string[] {
  if (!safeExistsSync(dir)) return [];
  const results: string[] = [];
  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = safeReaddir(current);
    } catch {
      return;
    }
    for (const name of entries) {
      const fullPath = nodePath.join(current, name);
      try {
        const stat = safeStat(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath);
        } else {
          results.push(fullPath);
        }
      } catch {
        // skip unreadable entries
      }
    }
  };
  walk(dir);
  return results;
}

export function scanTmp(opts: ScanTmpOptions): ScanTmpResult {
  const ttlMs = opts.ttlMs ?? DEFAULT_TMP_TTL_MS;
  const dir = sharedTmp();
  const now = Date.now();
  const expired: string[] = [];
  const deleted: string[] = [];

  const files = collectFiles(dir);
  for (const filePath of files) {
    try {
      const stat = safeStat(filePath);
      if (now - stat.mtimeMs > ttlMs) {
        expired.push(filePath);
        if (!opts.dryRun) {
          safeUnlinkSync(filePath);
          deleted.push(filePath);
          logger.info(`[JANITOR] deleted tmp: ${filePath}`);
        }
      }
    } catch {
      // skip
    }
  }

  return { expired, deleted };
}

export function rotateLogs(opts: RotateLogsOptions): RotateLogsResult {
  const retentionMs = (opts.retentionDays ?? DEFAULT_LOG_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
  const logsDir = shared('logs');
  const now = Date.now();
  const expired: string[] = [];
  const rotated: string[] = [];

  const files = collectFiles(logsDir);
  for (const filePath of files) {
    try {
      const stat = safeStat(filePath);
      if (now - stat.mtimeMs > retentionMs) {
        expired.push(filePath);
        if (!opts.dryRun) {
          safeUnlinkSync(filePath);
          rotated.push(filePath);
          logger.info(`[JANITOR] rotated log: ${filePath}`);
        }
      }
    } catch {
      // skip
    }
  }

  return { expired, rotated };
}

export function scanDataVault(opts: ScanDataVaultOptions): ScanDataVaultResult {
  const dir = shared('data-vault');
  const expired: string[] = [];
  const deleted: string[] = [];

  const files = collectFiles(dir);
  for (const filePath of files) {
    if (!filePath.endsWith('.json')) continue;
    try {
      if (!safeExistsSync(filePath)) continue;
      const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
      const entry = JSON.parse(raw);
      if (entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now()) {
        expired.push(filePath);
        if (!opts.dryRun) {
          safeUnlinkSync(filePath);
          deleted.push(filePath);
        }
      }
    } catch {
      // skip malformed entries
    }
  }

  return { expired, deleted };
}

export function scanRuntime(opts: { dryRun: boolean }): ScanRuntimeResult {
  const now = Date.now();
  const expired: string[] = [];
  const deleted: string[] = [];

  for (const rule of RUNTIME_RETENTION) {
    const dir = shared(`runtime/${rule.subdir}`);
    for (const filePath of collectFiles(dir)) {
      try {
        const stat = safeStat(filePath);
        if (now - stat.mtimeMs > rule.ttlMs) {
          expired.push(filePath);
          if (!opts.dryRun) {
            safeUnlinkSync(filePath);
            deleted.push(filePath);
            logger.info(`[JANITOR] deleted runtime artifact: ${filePath}`);
          }
        }
      } catch {
        // skip
      }
    }
  }

  return { expired, deleted };
}

export function runJanitor(opts: { dryRun: boolean }): JanitorReport {
  const errors: string[] = [];

  let tmpResult: ScanTmpResult = { expired: [], deleted: [] };
  try {
    tmpResult = scanTmp({ dryRun: opts.dryRun });
  } catch (err: any) {
    errors.push(`tmp: ${err?.message ?? String(err)}`);
  }

  let logResult: RotateLogsResult = { expired: [], rotated: [] };
  try {
    logResult = rotateLogs({ dryRun: opts.dryRun });
  } catch (err: any) {
    errors.push(`logs: ${err?.message ?? String(err)}`);
  }

  let vaultResult: ScanDataVaultResult = { expired: [], deleted: [] };
  try {
    vaultResult = scanDataVault({ dryRun: opts.dryRun });
  } catch (err: any) {
    errors.push(`data-vault: ${err?.message ?? String(err)}`);
  }

  let runtimeResult: ScanRuntimeResult = { expired: [], deleted: [] };
  try {
    runtimeResult = scanRuntime({ dryRun: opts.dryRun });
  } catch (err: any) {
    errors.push(`runtime: ${err?.message ?? String(err)}`);
  }

  const report: JanitorReport = {
    expiredTmp: tmpResult.expired.length,
    deletedTmp: tmpResult.deleted.length,
    expiredLogs: logResult.expired.length,
    rotatedLogs: logResult.rotated.length,
    expiredDataVault: vaultResult.expired.length,
    deletedDataVault: vaultResult.deleted.length,
    expiredRuntime: runtimeResult.expired.length,
    deletedRuntime: runtimeResult.deleted.length,
    errors,
    timestamp: new Date().toISOString(),
    dryRun: opts.dryRun,
  };

  if (!opts.dryRun) {
    try {
      safeWriteFile(
        shared(JANITOR_MARKER_SUBPATH),
        JSON.stringify({ completed_at: report.timestamp, errors: errors.length }, null, 2)
      );
    } catch (err: any) {
      // The marker only powers the staleness gate; a real run without a marker
      // just means the next session re-runs the janitor.
      logger.warn(`[JANITOR] failed to persist last-run marker: ${err?.message ?? String(err)}`);
    }
  }

  return report;
}

const JANITOR_MARKER_SUBPATH = 'runtime/state/janitor-last-run.json';

export function readJanitorLastRunMs(): number | null {
  const markerPath = shared(JANITOR_MARKER_SUBPATH);
  if (!safeExistsSync(markerPath)) return null;
  try {
    const parsed = JSON.parse(String(safeReadFile(markerPath, { encoding: 'utf8' })));
    const ts = Date.parse(parsed?.completed_at);
    return Number.isFinite(ts) ? ts : null;
  } catch {
    return null;
  }
}

/**
 * KM-01 fallback: sessions without a resident chronos daemon still get TTL GC.
 * Runs the janitor only when the last completed run is older than maxAgeMs.
 */
export function runJanitorIfStale(
  opts: { maxAgeMs?: number; dryRun?: boolean } = {}
): JanitorReport | null {
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_TMP_TTL_MS;
  const last = readJanitorLastRunMs();
  if (last !== null && Date.now() - last < maxAgeMs) return null;
  return runJanitor({ dryRun: opts.dryRun ?? false });
}
