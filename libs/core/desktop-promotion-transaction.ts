import path from 'node:path';
import { createHash } from 'node:crypto';
import { readJson } from './foundation/json.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeCreateExclusiveFileSync,
  safeExistsSync,
  safeLstat,
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
const TRANSACTION_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/desktop-promotion-transaction.schema.json'
);
const LOCK_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/desktop-promotion-lock.schema.json'
);

const transactionCatalog = defineCatalog<DesktopPromotionTransaction>({
  id: 'desktop-promotion-transaction',
  path: TRANSACTION_SCHEMA_PATH,
  schema: TRANSACTION_SCHEMA_PATH,
});

interface DesktopPromotionLock {
  pid: number;
  created_at: number;
}

const lockCatalog = defineCatalog<DesktopPromotionLock>({
  id: 'desktop-promotion-lock',
  path: LOCK_SCHEMA_PATH,
  schema: LOCK_SCHEMA_PATH,
});

function serializedPromotionLock(): string {
  const lock = lockCatalog.validate({ pid: process.pid, created_at: Date.now() }, LOCK_PATH);
  return JSON.stringify(lock);
}

function transactionPath(procedureId: string): string {
  const safeId = procedureId.replace(/[^a-zA-Z0-9._-]/g, '_');
  return assertSafeRepositoryPath(path.join(TRANSACTION_DIR, `${safeId}.json`), {
    allowMissingLeaf: true,
  });
}

function backupPath(procedureId: string, target: 'pipeline' | 'catalog'): string {
  return assertSafeRepositoryPath(
    path.join(TRANSACTION_DIR, `${procedureId.replace(/[^a-zA-Z0-9._-]/g, '_')}.${target}.bak`),
    { allowMissingLeaf: true }
  );
}

function fileHash(filePath: string): string | null {
  if (!filePath) return null;
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (!safeExistsSync(safeFilePath)) return null;
  return createHash('sha256')
    .update(safeReadFile(safeFilePath, { encoding: null }) as Buffer)
    .digest('hex');
}

export function loadDesktopPromotionTransactionAtPath(
  filePath: string,
  expectedProcedureId?: string
): DesktopPromotionTransaction {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (!safeLstat(safeFilePath).isFile()) {
    throw new Error(`[DESKTOP_PROMOTION] transaction must be a regular file: ${filePath}`);
  }
  const marker = transactionCatalog.validate(readJson<unknown>(safeFilePath), safeFilePath);
  if (expectedProcedureId !== undefined && marker.procedure_id !== expectedProcedureId) {
    throw new Error(
      `[DESKTOP_PROMOTION_SCOPE_MISMATCH] transaction belongs to ${marker.procedure_id}, expected ${expectedProcedureId}`
    );
  }
  return marker;
}

function loadDesktopPromotionLockAtPath(filePath: string): DesktopPromotionLock {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (!safeLstat(safeFilePath).isFile()) {
    throw new Error(`[DESKTOP_PROMOTION] lock must be a regular file: ${filePath}`);
  }
  return lockCatalog.validate(readJson<unknown>(safeFilePath), safeFilePath);
}

function readMarker(procedureId: string): DesktopPromotionTransaction | null {
  try {
    return loadDesktopPromotionTransactionAtPath(transactionPath(procedureId), procedureId);
  } catch {
    return null;
  }
}

export function acquireDesktopPromotionLock(): void {
  safeMkdir(path.dirname(LOCK_PATH), { recursive: true });
  try {
    safeCreateExclusiveFileSync(LOCK_PATH, serializedPromotionLock());
  } catch {
    try {
      const lock = loadDesktopPromotionLockAtPath(LOCK_PATH);
      if (Date.now() - lock.created_at > 10 * 60_000) {
        safeRmSync(LOCK_PATH, { force: true });
        safeCreateExclusiveFileSync(LOCK_PATH, serializedPromotionLock());
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
    const lock = loadDesktopPromotionLockAtPath(LOCK_PATH);
    return Date.now() - lock.created_at <= 10 * 60_000;
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
  const pipelineMatches = fileHash(marker.pipeline_path) === marker.pipeline_sha256;
  const catalogMatches = fileHash(marker.catalog_path) === marker.catalog_sha256;
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
    if (!targetPath) return true;
    const safeTargetPath = assertSafeRepositoryPath(targetPath, { allowMissingLeaf: true });
    if (fileHash(safeTargetPath) !== expectedHash) return true;
    if (backup) {
      const safeBackupPath = assertSafeRepositoryPath(backup, { allowMissingLeaf: true });
      if (safeExistsSync(safeBackupPath)) {
        safeWriteFile(safeTargetPath, safeReadFile(safeBackupPath, { encoding: null }) as Buffer);
      } else if (existed === false) {
        safeRmSync(safeTargetPath, { force: true });
      } else {
        return false;
      }
    } else if (existed === false) {
      safeRmSync(safeTargetPath, { force: true });
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
  const validated = transactionCatalog.validate(marker, markerPath);
  safeWriteFile(markerPath, `${JSON.stringify(validated, null, 2)}\n`);
  return markerPath;
}

export function clearDesktopPromotionTransaction(procedureId: string): void {
  safeRmSync(transactionPath(procedureId), { force: true });
  safeRmSync(backupPath(procedureId, 'pipeline'), { force: true });
  safeRmSync(backupPath(procedureId, 'catalog'), { force: true });
}
