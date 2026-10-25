/**
 * Tenant runtime partitions in backup and restore (scripts/backup.ts): the
 * pre-archive chain check, the append-only rollback guard, torn-tail trimming,
 * restored-chain verification (D2) and the revocable-state quarantine (D1).
 * See knowledge/product/architecture/runtime-storage-layout.md.
 */
import * as path from 'node:path';
import { withExecutionContext } from '@agent/core/authority';
import { getAuditChainKeyId } from '@agent/core/chain-integrity';
import { logger } from '@agent/core/core';
import { nowIso, readTextFile } from '@agent/core/foundation';
import { writeJson } from '@agent/core/foundation/json';
import {
  TENANT_LEDGER_FILE,
  tenantLedgerPath,
  verifyLedgerIntegrityDetailed,
  verifyTenantLedgerIntegrity,
} from '@agent/core/ledger';
import {
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeMoveSync,
  safeReaddir,
  safeWriteFile,
} from '@agent/core/secure-io';
import {
  TENANT_RUNTIME_PARTITION_ROOTS,
  tenantRuntimePartitionOf,
  tenantRuntimePartitionPaths,
  tenantStoreLedgerPartitionOf,
  type StorageDataTier,
  type TenantRuntimePartitionPath,
} from '@agent/core/storage-layout';

/** Key id of this host's audit chain key, or undefined when there is none (never the key). */
export function currentAuditChainKeyId(): string | undefined {
  try {
    return getAuditChainKeyId();
  } catch (error) {
    logger.debug(
      `[backup] audit chain key id unavailable — ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
}

/**
 * Pre-archive check of the tenant's hash-chained ledger partitions: an
 * archive of a broken chain could never be verified on restore.
 */
export function assertTenantLedgerPartitionsIntact(
  tenant: string,
  partitions: TenantRuntimePartitionPath[]
): void {
  for (const partition of partitions) {
    if (!partition.hashChained || partition.tier === 'public') continue;
    const report = verifyTenantLedgerIntegrity(partition.tier, tenant);
    if (!report.ok) {
      throw new Error(
        `[BACKUP_TENANT_LEDGER_CORRUPT] tenant ledger partition fails hash-chain verification — an archive of it could not be verified on restore | next: run pnpm audit:verify and repair the partition, then rerun the backup | evidence: ${partition.path} (${report.corrupted.length} corrupted of ${report.total})`
      );
    }
  }
}

const APPEND_ONLY_PARTITION_KEYS: ReadonlySet<string> = new Set(
  TENANT_RUNTIME_PARTITION_ROOTS.filter((entry) => entry.appendOnly).map((entry) => entry.key)
);

/**
 * Run `fn` as the dedicated store role of the tenant ledger / approval
 * partition `absolutePath` lies in (live checkout only); otherwise as the
 * caller. Those partitions admit no broad runtime write.
 */
function asPartitionStore<T>(absolutePath: string, fn: () => T): T {
  const store = tenantStoreLedgerPartitionOf(absolutePath);
  if (!store || !store.tenant) return fn();
  if (store.storeRole === 'tenant_ledger_store') {
    return withExecutionContext('tenant_ledger_store', fn, undefined, store.tenant);
  }
  if (store.storeRole === 'tenant_approval_store') {
    return withExecutionContext('tenant_approval_store', fn, undefined, store.tenant);
  }
  throw new Error(`[BACKUP_RESTORE_STORE_ROLE_UNKNOWN] ${store.storeRole}`);
}

/** Append-only runtime partitions (`<root>/<tier>/<tenant>`) the archive carries. */
function appendOnlyPartitionsIn(members: string[]): string[] {
  const partitions = new Set<string>();
  for (const member of members) {
    const partition = tenantRuntimePartitionOf(member);
    if (partition && APPEND_ONLY_PARTITION_KEYS.has(partition.key)) {
      partitions.add(`${partition.root}/${partition.tier}/${partition.tenant}`);
    }
  }
  return [...partitions].sort((a, b) => a.localeCompare(b));
}

function containsAnyFile(dir: string, depth = 0): boolean {
  if (!safeExistsSync(dir)) return false;
  const stat = safeLstat(dir);
  if (!stat.isDirectory()) return true;
  if (depth > 8) return true;
  return safeReaddir(dir).some((child) => containsAnyFile(path.join(dir, child), depth + 1));
}

/**
 * Fail closed BEFORE extraction when the target already holds files in an
 * append-only partition the archive carries: an older snapshot laid over a
 * longer live chain is a rollback no verification can detect.
 */
export function assertNoAppendOnlyConflict(target: string, members: string[]): void {
  const conflicts = appendOnlyPartitionsIn(members).filter((partition) => {
    const livePath = path.join(target, partition);
    try {
      return asPartitionStore(livePath, () => containsAnyFile(livePath));
    } catch {
      return true; // an unprobeable partition is treated as occupied
    }
  });
  if (conflicts.length > 0) {
    throw new Error(
      `[BACKUP_RESTORE_APPEND_ONLY_CONFLICT] restore target already holds append-only ledger partition(s) — an older snapshot over a longer live chain is an undetectable rollback | next: restore into an empty target and reconcile the ledgers there, or move the live partition aside after review | evidence: ${conflicts.join(', ')}`
    );
  }
}

/**
 * Trim each restored append-only `.jsonl` back to its last newline when its
 * final line is torn (restored copy only); returns the trimmed members.
 */
export function trimRestoredLedgerTails(target: string, members: string[]): string[] {
  const trimmed: string[] = [];
  for (const member of members) {
    if (!member.endsWith('.jsonl')) continue;
    const partition = tenantRuntimePartitionOf(member);
    if (!partition || !APPEND_ONLY_PARTITION_KEYS.has(partition.key)) continue;
    const restoredPath = path.join(target, member);
    asPartitionStore(restoredPath, () => {
      if (!safeExistsSync(restoredPath) || !safeLstat(restoredPath).isFile()) return;
      const content = readTextFile(restoredPath);
      if (!content || content.endsWith('\n')) return;
      safeWriteFile(restoredPath, content.slice(0, content.lastIndexOf('\n') + 1));
      trimmed.push(member);
    });
  }
  return trimmed;
}

export type RestoredLedgerVerification = 'not_applicable' | 'verified' | 'deferred_key_mismatch';

/**
 * D2: verify the restored tenant-ledger chains when this host's audit chain
 * key is the archive's (fail on corruption); otherwise defer and say how.
 */
export function verifyRestoredTenantLedgers(
  target: string,
  members: string[],
  archiveChainKeyId: string | undefined
): RestoredLedgerVerification {
  const ledgers = members.filter((member) => {
    const partition = tenantRuntimePartitionOf(member);
    return (
      partition?.key === 'tenant_ledger' &&
      member === `${partition.root}/${partition.tier}/${partition.tenant}/${TENANT_LEDGER_FILE}`
    );
  });
  if (ledgers.length === 0) return 'not_applicable';
  const keyId = currentAuditChainKeyId();
  if (!archiveChainKeyId || keyId !== archiveChainKeyId) {
    logger.warn(
      `[backup] restored tenant ledger verification deferred — this host's audit chain key is not the archive's | next: set KYBERION_AUDIT_CHAIN_KEY to the source host's chain key (key id ${archiveChainKeyId ?? 'not recorded'}) in the target environment and run pnpm audit:verify there | evidence: ${ledgers.length} restored tenant ledger partition(s)`
    );
    return 'deferred_key_mismatch';
  }
  for (const member of ledgers) {
    const partition = tenantRuntimePartitionOf(member);
    const restoredPath = path.join(target, member);
    const live =
      partition !== undefined &&
      path.resolve(restoredPath) ===
        path.resolve(tenantLedgerPath(partition.tier as StorageDataTier, partition.tenant));
    const report =
      live && partition
        ? verifyTenantLedgerIntegrity(partition.tier, partition.tenant)
        : verifyLedgerIntegrityDetailed(restoredPath);
    if (!report.ok) {
      throw new Error(
        `[BACKUP_RESTORE_LEDGER_CORRUPT] restored tenant ledger fails hash-chain verification | next: do not use this restore; inspect the archive and restore an earlier backup | evidence: ${member} (${report.corrupted.length} corrupted of ${report.total})`
      );
    }
  }
  return 'verified';
}

/**
 * D1: a tenant restore must not bring back customer decision invites or
 * standing grants revoked after the backup was taken. Move the restored
 * records into a stamped `.restore-quarantine/` inside the same tenant
 * partition (same tier and tenant boundary, ignored by both stores, which
 * read only top-level `*.json`), with a manifest; re-issue what is still due.
 */
const REVOCABLE_RESTORE_KEYS = ['customer_decision_invites', 'grants'] as const;
export const RESTORE_QUARANTINE_DIR = '.restore-quarantine';

export function quarantineRestoredRevocableState(
  target: string,
  tenant: string,
  stampId: string
): { quarantinePaths: string[]; moved: string[] } {
  const quarantinePaths: string[] = [];
  const moved: string[] = [];
  const exists = (repoPath: string) => safeExistsSync(path.join(target, repoPath));
  for (const partition of tenantRuntimePartitionPaths(tenant, exists)) {
    if (!(REVOCABLE_RESTORE_KEYS as readonly string[]).includes(partition.key)) continue;
    const partitionDir = path.join(target, partition.path);
    const children = safeReaddir(partitionDir).filter((child) => child !== RESTORE_QUARANTINE_DIR);
    if (children.length === 0) continue;
    const quarantineDir = path.join(partitionDir, RESTORE_QUARANTINE_DIR, stampId);
    safeMkdir(quarantineDir, { recursive: true });
    const partitionMoved: string[] = [];
    for (const child of children) {
      safeMoveSync(path.join(partitionDir, child), path.join(quarantineDir, child));
      partitionMoved.push(child);
    }
    writeJson(path.join(quarantineDir, 'quarantine-manifest.json'), {
      format: 'kyberion-restore-revocable-quarantine-v1',
      tenant,
      key: partition.key,
      created_at: nowIso(),
      reason: 'tenant_restore_must_not_revive_state_revoked_after_backup',
      moved: partitionMoved,
    });
    quarantinePaths.push(path.relative(target, quarantineDir).split(path.sep).join('/'));
    moved.push(...partitionMoved.map((child) => `${partition.path}/${child}`));
  }
  return { quarantinePaths, moved };
}
