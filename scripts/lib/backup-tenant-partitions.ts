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
import { pathResolver } from '@agent/core/path-resolver';
import { isRecord, nowIso, parseSafeJsonInput, readTextFile } from '@agent/core/foundation';
import { writeJson } from '@agent/core/foundation/json';
import {
  TENANT_LEDGER_FILE,
  verifyLedgerIntegrityDetailed,
  verifyTenantLedgerIntegrity,
} from '@agent/core/ledger';
import {
  safeExecResult,
  safeExistsSync,
  safeRmSync,
  safeLstat,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeWriteFile,
} from '@agent/core/secure-io';
import {
  TENANT_RUNTIME_PARTITION_ROOTS,
  tenantRuntimePartitionOf,
  tenantStoreLedgerPartitionOf,
  type TenantRuntimePartitionPath,
} from '@agent/core/storage-layout';

export function normalizeArchiveMember(member: string): string {
  const normalized = member.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`Backup archive contains an unsafe member path: ${member}`);
  }
  return normalized;
}

function listArchive(plainArchive: string, flags: string): string[] {
  const result = safeExecResult('tar', [flags, plainArchive], {
    timeoutMs: 120000,
    maxOutputMB: 50,
  });
  if (result.status !== 0) {
    throw new Error(
      `backup archive listing failed: ${result.stderr || result.stdout || result.error?.message || 'command failed'}`
    );
  }
  return result.stdout.split('\n').filter((line) => line.trim());
}

/**
 * Archive member names, failing closed on anything but regular files and
 * directories: a symlink or hard link could point extraction outside its
 * partition. The verbose listing (same order) carries the type character.
 */
export function archiveMembers(plainArchive: string): string[] {
  const names = listArchive(plainArchive, '-tzf');
  const verbose = listArchive(plainArchive, '-tvzf');
  if (names.length !== verbose.length) {
    throw new Error('Backup archive listing is inconsistent; refusing to restore it.');
  }
  verbose.forEach((line, index) => {
    const type = line.trimStart().charAt(0);
    // bsdtar and GNU tar mark hard links `h` and append ` link to <name>`;
    // both are refused (fails closed for a file name containing that text).
    if ((type !== '-' && type !== 'd') || line.includes(' link to ')) {
      throw new Error(
        `[BACKUP_ARCHIVE_MEMBER_TYPE] backup archive member is not a regular file or directory (type '${type}') | next: recreate the backup without links | evidence: ${names[index].trim()}`
      );
    }
  });
  return names.map((member) => member.trim()).map(normalizeArchiveMember);
}

/**
 * Run `fn` with a fresh `active/shared/tmp/<name>` directory that is removed
 * on every path, success or failure: backup and restore temp dirs hold
 * plaintext tenant data (decrypted payloads, staged partitions, bundles).
 */
export function withPlaintextTempDir<T>(name: string, fn: (tempDir: string) => T): T {
  const tempDir = pathResolver.sharedTmp(name);
  safeMkdir(tempDir, { recursive: true });
  try {
    return fn(tempDir);
  } finally {
    try {
      safeRmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      logger.warn(
        `[backup] temp dir not removed — it may hold plaintext tenant data | next: delete it by hand | evidence: ${tempDir}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

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
 * Tenant runtime partitions a restore never extracts in place: every
 * append-only partition (trimmed and verified in staging first), and on a
 * tenant restore the revocable state (D1). Repo-relative `<root>/<tier>/<tenant>`.
 */
export interface StagedRestorePartitions {
  appendOnly: string[];
  revocable: string[];
}

const REVOCABLE_RESTORE_KEYS: ReadonlySet<string> = new Set([
  'customer_decision_invites',
  'grants',
]);
export const RESTORE_QUARANTINE_DIR = '.restore-quarantine';

export function stagedRestorePartitions(
  members: string[],
  tenantRestore: boolean
): StagedRestorePartitions {
  const revocable = new Set<string>();
  for (const member of members) {
    const partition = tenantRuntimePartitionOf(member);
    if (tenantRestore && partition && REVOCABLE_RESTORE_KEYS.has(partition.key)) {
      revocable.add(`${partition.root}/${partition.tier}/${partition.tenant}`);
    }
  }
  return {
    appendOnly: appendOnlyPartitionsIn(members),
    revocable: [...revocable].sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * Trim each staged append-only `.jsonl` whose final line is torn (does not
 * parse as JSON) back to its last newline; a complete final record without a
 * trailing newline is kept and only gets its newline. Returns trimmed members.
 */
export function trimRestoredLedgerTails(staging: string, members: string[]): string[] {
  const trimmed: string[] = [];
  for (const member of members) {
    if (!member.endsWith('.jsonl')) continue;
    const partition = tenantRuntimePartitionOf(member);
    if (!partition || !APPEND_ONLY_PARTITION_KEYS.has(partition.key)) continue;
    const stagedPath = path.join(staging, member);
    if (!safeExistsSync(stagedPath) || !safeLstat(stagedPath).isFile()) continue;
    const content = readTextFile(stagedPath);
    if (!content || content.endsWith('\n')) continue;
    const cut = content.lastIndexOf('\n') + 1;
    let complete = true;
    try {
      parseSafeJsonInput(content.slice(cut), 'restored ledger tail');
    } catch {
      complete = false;
    }
    if (complete) {
      safeWriteFile(stagedPath, `${content}\n`);
      continue;
    }
    safeWriteFile(stagedPath, content.slice(0, cut));
    trimmed.push(member);
  }
  return trimmed;
}

export type RestoredLedgerVerification = 'not_applicable' | 'verified' | 'deferred_key_mismatch';

/**
 * Entries of a staged ledger that are not keyed under the archive's chain key
 * (`chain_alg` other than `hmac-sha256`, or another `chain_key_id`): a keyless
 * sha256 chain verifies without the key, so it proves nothing.
 */
function unkeyedEntries(stagedPath: string, archiveChainKeyId: string): string[] {
  const findings: string[] = [];
  readTextFile(stagedPath)
    .split('\n')
    .forEach((line, index) => {
      if (!line.trim()) return;
      let entry: unknown;
      try {
        entry = parseSafeJsonInput(line, 'restored ledger entry');
      } catch {
        findings.push(`line:${index + 1}:parse_error`);
        return;
      }
      const record = isRecord(entry) ? entry : {};
      if (record.chain_alg !== 'hmac-sha256') findings.push(`line:${index + 1}:chain_alg`);
      else if (record.chain_key_id !== archiveChainKeyId)
        findings.push(`line:${index + 1}:chain_key_id`);
    });
  return findings;
}

/**
 * D2: verify the staged tenant-ledger chains BEFORE anything reaches the
 * target, when this host's audit chain key is the archive's: every entry
 * must be HMAC-chained under the archive's key id and the chain must verify
 * (else the restore fails). Otherwise defer and say how. Truncation of a
 * chain's tail is not detectable here (no head anchor); the pre-extraction
 * conflict check is the rollback guard.
 */
export function verifyRestoredTenantLedgers(
  staging: string,
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
    const stagedPath = path.join(staging, member);
    const unkeyed = unkeyedEntries(stagedPath, archiveChainKeyId);
    if (unkeyed.length > 0) {
      throw new Error(
        `[BACKUP_RESTORE_LEDGER_DOWNGRADED] restored tenant ledger has entries not HMAC-chained under the archive's key — nothing was restored to the target | next: do not use this archive; restore an earlier backup | evidence: ${member} (${unkeyed.slice(0, 5).join(', ')}${unkeyed.length > 5 ? ', …' : ''})`
      );
    }
    const report = verifyLedgerIntegrityDetailed(stagedPath);
    if (!report.ok) {
      throw new Error(
        `[BACKUP_RESTORE_LEDGER_CORRUPT] restored tenant ledger fails hash-chain verification — nothing was restored to the target | next: do not use this archive; inspect it and restore an earlier backup | evidence: ${member} (${report.corrupted.length} corrupted of ${report.total})`
      );
    }
  }
  return 'verified';
}

/** Move a staged tree file by file into `dest` (written as the partition's store role when live). */
function placeStagedTree(source: string, dest: string, depth = 0): string[] {
  if (depth > 12) throw new Error(`[BACKUP_RESTORE_TREE_TOO_DEEP] ${source}`);
  const stat = safeLstat(source);
  if (stat.isDirectory()) {
    asPartitionStore(dest, () => {
      if (!safeExistsSync(dest)) safeMkdir(dest, { recursive: true });
    });
    return safeReaddir(source).flatMap((child) =>
      placeStagedTree(path.join(source, child), path.join(dest, child), depth + 1)
    );
  }
  if (!stat.isFile()) throw new Error(`[BACKUP_RESTORE_MEMBER_TYPE] ${source}`);
  const content = safeReadFile(source, { encoding: null }) as Buffer;
  asPartitionStore(dest, () => safeWriteFile(dest, content));
  return [dest];
}

/** Place the verified append-only partitions from staging into the target. */
export function placeStagedAppendOnlyPartitions(
  staging: string,
  target: string,
  partitions: string[]
): void {
  for (const partition of partitions) {
    const source = path.join(staging, partition);
    if (safeExistsSync(source)) placeStagedTree(source, path.join(target, partition));
  }
}

/**
 * D1: a tenant restore must not bring back customer decision invites or
 * standing grants revoked after the backup, and must not touch records issued
 * since. The archive's own records never reach the live partition: they go
 * from staging straight into `<partition>/.restore-quarantine/<stamp>/` (same
 * tier and tenant boundary; both stores read only top-level `*.json`), with a
 * manifest; live records are left as they are. Re-issue what is still due.
 */
export function quarantineStagedRevocableState(
  staging: string,
  target: string,
  partitions: string[],
  tenant: string,
  stampId: string
): { quarantinePaths: string[]; moved: string[] } {
  const quarantinePaths: string[] = [];
  const moved: string[] = [];
  for (const partition of partitions) {
    const source = path.join(staging, partition);
    if (!safeExistsSync(source)) continue;
    const children = safeReaddir(source).filter((child) => child !== RESTORE_QUARANTINE_DIR);
    if (children.length === 0) continue;
    const partitionDir = path.join(target, partition);
    const quarantineRoot = path.join(partitionDir, RESTORE_QUARANTINE_DIR);
    const quarantineDir = path.join(quarantineRoot, stampId);
    assertNotSymlinked(partitionDir, quarantineRoot, quarantineDir);
    safeMkdir(quarantineDir, { recursive: true });
    assertNotSymlinked(partitionDir, quarantineRoot, quarantineDir);
    for (const child of children)
      placeStagedTree(path.join(source, child), path.join(quarantineDir, child));
    writeJson(path.join(quarantineDir, 'quarantine-manifest.json'), {
      format: 'kyberion-restore-revocable-quarantine-v1',
      tenant,
      key: tenantRuntimePartitionOf(partition)?.key,
      created_at: nowIso(),
      reason: 'tenant_restore_must_not_revive_state_revoked_after_backup',
      moved: children,
    });
    quarantinePaths.push(path.relative(target, quarantineDir).split(path.sep).join('/'));
    moved.push(...children.map((child) => `${partition}/${child}`));
  }
  return { quarantinePaths, moved };
}

/** Every regular file under the given partitions of `root` (repo paths → bytes). */
function snapshotPartitions(root: string, partitions: string[]): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const walk = (dir: string, depth: number): void => {
    if (depth > 12 || !safeExistsSync(dir)) return;
    const stat = safeLstat(dir);
    if (stat.isDirectory()) {
      for (const child of safeReaddir(dir)) walk(path.join(dir, child), depth + 1);
    } else {
      files.set(
        dir,
        asPartitionStore(dir, () => safeReadFile(dir, { encoding: null }) as Buffer)
      );
    }
  };
  for (const partition of partitions) walk(path.join(root, partition), 0);
  return files;
}

/**
 * `--exclude` is fail-open, so prove it held: an append-only partition the
 * conflict check found empty must still hold no file, and a revocable
 * partition must be byte-identical to its pre-extraction state. On a breach
 * the partitions are put back (extracted files removed, originals rewritten)
 * and the restore fails.
 */
function assertExclusionsHeld(
  target: string,
  staged: StagedRestorePartitions,
  revocableBefore: Map<string, Buffer>
): void {
  const breached: string[] = [];
  for (const partition of staged.appendOnly) {
    for (const file of snapshotPartitions(target, [partition]).keys()) {
      asPartitionStore(file, () => safeRmSync(file, { force: true }));
      breached.push(file);
    }
  }
  const revocableAfter = snapshotPartitions(target, staged.revocable);
  for (const [file, content] of revocableAfter) {
    const before = revocableBefore.get(file);
    if (before && before.equals(content)) continue;
    if (before) safeWriteFile(file, before);
    else safeRmSync(file, { force: true });
    breached.push(file);
  }
  for (const [file, content] of revocableBefore) {
    if (revocableAfter.has(file)) continue;
    safeWriteFile(file, content);
    breached.push(file);
  }
  if (breached.length > 0) {
    throw new Error(
      `[BACKUP_RESTORE_EXCLUDE_FAILED] the main extraction wrote into staged partitions — they were put back; other archive members are already in the target | next: roll the target back, then restore with a tar that honours --exclude | evidence: ${breached
        .slice(0, 5)
        .map((file) => path.relative(target, file))
        .join(', ')}`
    );
  }
}

/** Refuse to place records through a symlinked partition or quarantine directory. */
function assertNotSymlinked(...paths: string[]): void {
  for (const candidate of paths) {
    if (safeExistsSync(candidate) && safeLstat(candidate).isSymbolicLink()) {
      throw new Error(
        `[BACKUP_RESTORE_SYMLINKED_PARTITION] restore will not write through a symlinked directory | next: replace the link with a real directory after review | evidence: ${candidate}`
      );
    }
  }
}

function runTar(args: string[], errorPrefix: string): void {
  const result = safeExecResult('tar', args, { timeoutMs: 120000, maxOutputMB: 50 });
  if (result.status !== 0) {
    throw new Error(
      `${errorPrefix}: ${result.stderr || result.stdout || result.error?.message || 'command failed'}`
    );
  }
}

/**
 * Extract an archive into `target` without ever extracting an append-only
 * partition or (tenant restore) revocable state in place: those land in
 * `staging` first, the ledgers are trimmed and verified there (a failure
 * leaves the target untouched), then the main extraction excludes them, the
 * ledgers move into their partitions and the revocable records into
 * quarantine.
 */
export function extractWithStagedPartitions(input: {
  plainArchive: string;
  target: string;
  staging: string;
  members: string[];
  archiveChainKeyId: string | undefined;
  tenant: string | undefined;
  stampId: string;
}): {
  trimmedTails: string[];
  ledgerVerification: RestoredLedgerVerification;
  quarantinePaths: string[];
} {
  const { plainArchive, target, staging, members } = input;
  const staged = stagedRestorePartitions(members, Boolean(input.tenant));
  const stagedPaths = [...staged.appendOnly, ...staged.revocable];
  let trimmedTails: string[] = [];
  let ledgerVerification: RestoredLedgerVerification = 'not_applicable';
  if (stagedPaths.length > 0) {
    safeMkdir(staging, { recursive: true });
    runTar(
      ['-xzf', plainArchive, '-C', staging, '--', ...stagedPaths],
      'backup restore staging failed'
    );
    trimmedTails = trimRestoredLedgerTails(staging, members);
    ledgerVerification = verifyRestoredTenantLedgers(staging, members, input.archiveChainKeyId);
  }
  safeMkdir(target, { recursive: true });
  const revocableBefore = snapshotPartitions(target, staged.revocable);
  runTar(
    [
      ...stagedPaths.flatMap((partition) => ['--exclude', partition]),
      '-xzf',
      plainArchive,
      '-C',
      target,
    ],
    'backup restore extraction failed'
  );
  assertExclusionsHeld(target, staged, revocableBefore);
  placeStagedAppendOnlyPartitions(staging, target, staged.appendOnly);
  const quarantinePaths = input.tenant
    ? quarantineStagedRevocableState(staging, target, staged.revocable, input.tenant, input.stampId)
        .quarantinePaths
    : [];
  if (stagedPaths.length > 0) safeRmSync(staging, { recursive: true, force: true });
  return { trimmedTails, ledgerVerification, quarantinePaths };
}
