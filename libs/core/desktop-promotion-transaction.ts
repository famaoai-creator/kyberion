import path from 'node:path';
import { createHash } from 'node:crypto';
import { readJson } from './foundation/json.js';
import { pathResolver } from './path-resolver.js';
import {
  safeCreateExclusiveFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from './secure-io.js';

export interface DesktopPromotionTransaction {
  schema_version: 'desktop-promotion-transaction.v1';
  status: 'prepared' | 'committed';
  procedure_id: string;
  pipeline_path: string;
  catalog_path: string;
  pipeline_sha256: string;
  catalog_sha256: string;
  pipeline_backup_path?: string;
  catalog_backup_path?: string;
  pipeline_existed?: boolean;
  catalog_existed?: boolean;
}

const TRANSACTION_DIR = pathResolver.shared('runtime/state/desktop-promotion-transactions');
const LOCK_PATH = pathResolver.shared('runtime/state/desktop-promotion.lock');

function transactionPath(procedureId: string): string {
  const safeId = procedureId.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(TRANSACTION_DIR, `${safeId}.json`);
}

function backupPath(procedureId: string, target: 'pipeline' | 'catalog'): string {
  return path.join(
    TRANSACTION_DIR,
    `${procedureId.replace(/[^a-zA-Z0-9._-]/g, '_')}.${target}.bak`
  );
}

function fileHash(filePath: string): string | null {
  if (!safeExistsSync(filePath)) return null;
  return createHash('sha256')
    .update(safeReadFile(filePath, { encoding: null }) as Buffer)
    .digest('hex');
}

function readMarker(procedureId: string): Partial<DesktopPromotionTransaction> | null {
  try {
    return readJson<Partial<DesktopPromotionTransaction>>(transactionPath(procedureId));
  } catch {
    return null;
  }
}

export function acquireDesktopPromotionLock(): void {
  safeMkdir(path.dirname(LOCK_PATH), { recursive: true });
  try {
    safeCreateExclusiveFileSync(
      LOCK_PATH,
      JSON.stringify({ pid: process.pid, created_at: Date.now() })
    );
  } catch {
    try {
      const lock = readJson<{ created_at?: number }>(LOCK_PATH);
      if (typeof lock.created_at === 'number' && Date.now() - lock.created_at > 10 * 60_000) {
        safeRmSync(LOCK_PATH, { force: true });
        safeCreateExclusiveFileSync(
          LOCK_PATH,
          JSON.stringify({ pid: process.pid, created_at: Date.now() })
        );
        return;
      }
    } catch {
      // An unreadable lock remains fail-closed.
    }
    throw new Error('another desktop promotion is in progress; retry after it completes');
  }
}

function activeDesktopPromotionLock(): boolean {
  if (!safeExistsSync(LOCK_PATH)) return false;
  try {
    const lock = readJson<{ created_at?: number }>(LOCK_PATH);
    return typeof lock.created_at === 'number' && Date.now() - lock.created_at <= 10 * 60_000;
  } catch {
    return true;
  }
}

export function releaseDesktopPromotionLock(): void {
  safeRmSync(LOCK_PATH, { force: true });
}

/** Reconcile a prepared marker after a process interruption. */
export function reconcileDesktopPromotionTransaction(
  procedureId: string,
  options: { lockHeld?: boolean } = {}
): 'none' | 'committed' | 'rolled_back' | 'pending' {
  if (!options.lockHeld && activeDesktopPromotionLock()) return 'pending';
  if (!safeExistsSync(transactionPath(procedureId))) return 'none';
  const marker = readMarker(procedureId);
  if (!marker) return 'pending';
  if (marker.status !== 'prepared') {
    clearDesktopPromotionTransaction(procedureId);
    return 'committed';
  }
  const pipelineMatches = fileHash(marker.pipeline_path || '') === marker.pipeline_sha256;
  const catalogMatches = fileHash(marker.catalog_path || '') === marker.catalog_sha256;
  if (pipelineMatches && catalogMatches) {
    clearDesktopPromotionTransaction(procedureId);
    return 'committed';
  }
  if (!pipelineMatches && !catalogMatches) {
    clearDesktopPromotionTransaction(procedureId);
    return 'rolled_back';
  }
  const restore = (
    targetPath: string | undefined,
    expectedHash: string | undefined,
    backup: string | undefined,
    existed: boolean | undefined
  ): boolean => {
    if (!targetPath || fileHash(targetPath) !== expectedHash) return true;
    if (backup && safeExistsSync(backup)) {
      safeWriteFile(targetPath, safeReadFile(backup, { encoding: null }) as Buffer);
    } else if (existed === false) {
      safeRmSync(targetPath, { force: true });
    } else {
      return false;
    }
    return true;
  };
  const restored =
    restore(
      marker.pipeline_path,
      marker.pipeline_sha256,
      marker.pipeline_backup_path,
      marker.pipeline_existed
    ) &&
    restore(
      marker.catalog_path,
      marker.catalog_sha256,
      marker.catalog_backup_path,
      marker.catalog_existed
    );
  if (!restored) return 'pending';
  clearDesktopPromotionTransaction(procedureId);
  return 'rolled_back';
}

export function isDesktopPromotionPending(procedureId: string): boolean {
  const state = reconcileDesktopPromotionTransaction(procedureId);
  return state === 'pending';
}

export function assertNoPendingDesktopPromotion(
  procedureId: string,
  options: { lockHeld?: boolean } = {}
): void {
  if (!options.lockHeld && activeDesktopPromotionLock()) {
    throw new Error('another desktop promotion is in progress; retry after it completes');
  }
  const state = options.lockHeld
    ? reconcileDesktopPromotionTransaction(procedureId, { lockHeld: true })
    : isDesktopPromotionPending(procedureId);
  if (state === 'pending') {
    throw new Error(
      `desktop promotion has an incomplete transaction for procedure_id "${procedureId}"; repair the transaction before retrying`
    );
  }
}

export function writeDesktopPromotionTransaction(marker: DesktopPromotionTransaction): string {
  const markerPath = transactionPath(marker.procedure_id);
  safeWriteFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
  return markerPath;
}

export function clearDesktopPromotionTransaction(procedureId: string): void {
  safeRmSync(transactionPath(procedureId), { force: true });
  safeRmSync(backupPath(procedureId, 'pipeline'), { force: true });
  safeRmSync(backupPath(procedureId, 'catalog'), { force: true });
}
