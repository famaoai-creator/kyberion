/**
 * Retention expiry primitives shared by the storage janitor and scope
 * offboarding: the trash (soft delete + restore), the archive move, the
 * deletion audit, and expiring an audit chain day with its tenant mirrors.
 */
import * as nodePath from 'node:path';
import { appendJsonLine, readJsonLines } from './foundation/json.js';
import { nowIso } from './foundation/time.js';
import { rootDir, sharedLogsAudit } from './path-resolver.js';
import {
  safeReaddir,
  safeUnlinkSync,
  safeExistsSync,
  safeWriteFile,
  safeMkdir,
  safeMoveSync,
  safeRmSync,
} from './secure-io.js';
import { logger } from './core.js';
import { withAuditChainLock } from './governance/audit-chain.js';
import { isValidTenantSlug } from './entity-scope.js';
import {
  RETENTION_CATALOG_REPO_PATH,
  STORAGE_RETENTION_AUDIT_FILENAME,
  type RetentionCatalogEntry,
} from './storage-retention-catalog.js';

/** Repo-relative POSIX path under the (possibly test-overridden) root. */
export function repoRelativePosix(absolutePath: string): string {
  return nodePath.relative(rootDir(), absolutePath).split(nodePath.sep).join('/');
}

/** AL-04: soft-delete grace floor — see the catalog's `active/archive/.trash` entry. */
export const TRASH_REPO_SUBPATH = 'active/archive/.trash';

/**
 * MSN-LOG-STORE-HARDENING-20261016: archive floor for `action: 'archive'`
 * expiry — files land at `active/archive/<original-repo-relative-path>`.
 * `active/archive` is `review_required`, so archived evidence is never
 * auto-deleted.
 */
export const ARCHIVE_REPO_SUBPATH = 'active/archive';

/** Pre-compaction copies of keyed JSONL stores land under this archive subtree. */
export const COMPACTION_ARCHIVE_REPO_SUBPATH = 'active/archive/jsonl-compaction';

/**
 * `action: 'rotate'` defaults: an append-only file is rotated once it
 * exceeds this size (mtime can never age while it is appended, so size —
 * not age — is the trigger).
 */
export const DEFAULT_ROTATE_MIN_BYTES = 8 * 1024 * 1024;

/**
 * `action: 'compact'` default size trigger. Below this a versioned keyed
 * store is cheap enough to read whole; past it the per-read O(file) parse
 * cost justifies folding to latest-per-key.
 */
export const DEFAULT_COMPACT_MIN_BYTES = 4 * 1024 * 1024;

/** Rotated segments are named `<stem>-YYYYMMDD-HHmmss.jsonl`. */
export const ROTATED_SEGMENT_SUFFIX_PATTERN = /-\d{8}-\d{6}\.jsonl$/;

/** Grace applied to trashed files whose original path no longer has a covering catalog entry. */
export const DEFAULT_TRASH_GRACE_DAYS = 30;

export function trashRootDir(): string {
  return nodePath.join(rootDir(), ...TRASH_REPO_SUBPATH.split('/'));
}

/**
 * AL-04 trash index. A move preserves mtime, so an expired file arrives in
 * the trash ALREADY older than any grace — mtime cannot express "when it was
 * trashed". This append-only sidecar (one `{path, trashed_at}` record per
 * soft-delete, last record per path wins) is what the grace is measured
 * from; entries whose trash file is gone are pruned by the sweep. A file
 * with no index record falls back to mtime, so a hand-moved file is still
 * eventually reclaimed.
 */
export const TRASH_INDEX_FILENAME = '.trash-index.jsonl';

function trashIndexPath(): string {
  return nodePath.join(trashRootDir(), TRASH_INDEX_FILENAME);
}

export function readTrashIndex(): Map<string, number> {
  const indexPath = trashIndexPath();
  const trashedAt = new Map<string, number>();
  if (!safeExistsSync(indexPath)) return trashedAt;
  try {
    for (const record of readJsonLines<{ path?: unknown; trashed_at?: unknown }>(indexPath, {
      onMalformed: 'skip',
    })) {
      const ms = Date.parse(String(record.trashed_at ?? ''));
      if (typeof record.path === 'string' && Number.isFinite(ms)) {
        trashedAt.set(record.path, ms);
      }
    }
  } catch (err) {
    logger.warn(
      `[JANITOR] failed to read the trash index (falling back to mtime): ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return trashedAt;
}

function recordTrashEntry(originalRepoRelative: string): void {
  try {
    appendJsonLine(trashIndexPath(), {
      path: originalRepoRelative,
      trashed_at: nowIso(),
    });
  } catch (err) {
    // Losing the record only costs precision (mtime fallback), never data.
    logger.warn(
      `[JANITOR] failed to record trash index entry for ${originalRepoRelative}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Rewrite the index without records whose trash file no longer exists. */
export function pruneTrashIndex(trashedAt: Map<string, number>): void {
  const surviving: string[] = [];
  for (const [repoRel, ms] of trashedAt) {
    const filePath = nodePath.join(trashRootDir(), ...repoRel.split('/'));
    if (safeExistsSync(filePath)) {
      surviving.push(JSON.stringify({ path: repoRel, trashed_at: nowIso(new Date(ms)) }));
    }
  }
  try {
    if (surviving.length === 0) {
      if (safeExistsSync(trashIndexPath())) safeUnlinkSync(trashIndexPath());
      return;
    }
    safeWriteFile(trashIndexPath(), `${surviving.join('\n')}\n`);
  } catch (err) {
    logger.warn(
      `[JANITOR] failed to prune the trash index: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * AL-04 deletion audit — best-effort append to
 * `active/shared/logs/audit/storage-retention.jsonl`. An unwritable audit log
 * never blocks the janitor (the deletion/move already happened or is about
 * to; losing the audit line is logged, not fatal).
 */
export function appendRetentionAudit(record: Record<string, unknown>): void {
  try {
    appendJsonLine(sharedLogsAudit(STORAGE_RETENTION_AUDIT_FILENAME), {
      ts: nowIso(),
      ...record,
    });
  } catch (err) {
    logger.warn(
      `[JANITOR] failed to append retention audit record: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * AL-04 soft-delete: move a file or directory to
 * `active/archive/.trash/<original-repo-relative-path>` (structure preserved,
 * so {@link restoreFromTrash} and the trash sweep can both recover the
 * original location from the trash path alone). Returns the trash location.
 *
 * Shared primitive: the janitor's TTL expiry and the scope-linked GC of
 * `scope-offboarding.ts` both delete through here, so everything reclaimed
 * automatically has the same restore window.
 */
export function softDeleteToTrash(absolutePath: string): {
  trashPath: string;
  originalRepoRelative: string;
} {
  const repoRel = repoRelativePosix(absolutePath);
  const trashPath = nodePath.join(trashRootDir(), ...repoRel.split('/'));
  const trashDir = nodePath.dirname(trashPath);
  if (!safeExistsSync(trashDir)) safeMkdir(trashDir, { recursive: true });
  if (safeExistsSync(trashPath)) safeRmSync(trashPath, { recursive: true, force: true });
  safeMoveSync(absolutePath, trashPath);
  recordTrashEntry(repoRel);
  return { trashPath, originalRepoRelative: repoRel };
}

/**
 * AL-04 restore: move a soft-deleted path back from the trash to its original
 * repo-relative location (the inverse of {@link softDeleteToTrash}). Returns
 * `restored: false` when the trash holds nothing for that path — restoring an
 * already-purged or never-trashed path is a no-op, never an error.
 */
export function restoreFromTrash(originalRepoRelativePath: string): {
  restored: boolean;
  path: string;
} {
  const segments = originalRepoRelativePath.split('/').filter(Boolean);
  const restoredPath = nodePath.join(rootDir(), ...segments);
  const trashPath = nodePath.join(trashRootDir(), ...segments);
  if (!safeExistsSync(trashPath)) return { restored: false, path: restoredPath };
  const parent = nodePath.dirname(restoredPath);
  if (!safeExistsSync(parent)) safeMkdir(parent, { recursive: true });
  if (safeExistsSync(restoredPath)) safeRmSync(restoredPath, { recursive: true, force: true });
  safeMoveSync(trashPath, restoredPath);
  appendRetentionAudit({
    event: 'RETENTION_RESTORED',
    path: originalRepoRelativePath,
    trash_path: `${TRASH_REPO_SUBPATH}/${originalRepoRelativePath}`,
    policy_ref: RETENTION_CATALOG_REPO_PATH,
    reason: 'operator restore from soft-delete grace',
  });
  return { restored: true, path: restoredPath };
}

/** Files whose expiry moved them into `active/archive/` rather than unlinking. */
export interface ExpiryOutcome {
  deleted: string[];
  softDeleted: string[];
  archived: string[];
}

/**
 * AL-04: apply a catalog entry's expiry action to one expired file.
 *
 *  - `action: 'archive'` → move to `active/archive/<original-repo-relative-path>`
 *    (structure preserved); the archive tree itself is `review_required`,
 *    so archived evidence is never auto-deleted. Always audited.
 *  - `soft_delete_days` declared → move to
 *    `active/archive/.trash/<original-repo-relative-path>` (structure
 *    preserved) so the trash sweep can purge it after the grace period.
 *  - otherwise → hard delete (unchanged pre-AL-04 behavior).
 *  - `audit: true` (or any soft-delete, which needs a restore trail) → an
 *    audit JSONL record of what/why/policy ref.
 */
export function expireFilePerPolicy(
  filePath: string,
  entry: RetentionCatalogEntry | null,
  outcome: ExpiryOutcome,
  /** WI-16: extra audit fields (e.g. status-rule id/status) merged into the audit record when written. */
  auditExtra?: Record<string, unknown>
): void {
  const repoRel = repoRelativePosix(filePath);
  const archive = entry?.action === 'archive';
  const softDelete = !archive && entry?.soft_delete_days !== undefined;
  if (archive) {
    const archivePath = nodePath.join(rootDir(), ARCHIVE_REPO_SUBPATH, repoRel);
    safeMkdir(nodePath.dirname(archivePath), { recursive: true });
    safeMoveSync(filePath, archivePath);
    outcome.archived.push(filePath);
    logger.info(`[JANITOR] archived: ${filePath} -> ${archivePath}`);
  } else if (softDelete) {
    softDeleteToTrash(filePath);
    outcome.softDeleted.push(filePath);
    logger.info(`[JANITOR] soft-deleted (trash): ${filePath}`);
  } else {
    safeUnlinkSync(filePath);
    outcome.deleted.push(filePath);
    logger.info(`[JANITOR] deleted: ${filePath}`);
  }
  if (entry?.audit || softDelete || archive || auditExtra) {
    appendRetentionAudit({
      event: archive
        ? 'RETENTION_ARCHIVE'
        : softDelete
          ? 'RETENTION_SOFT_DELETE'
          : 'RETENTION_DELETE',
      path: repoRel,
      ...(archive ? { archive_path: `${ARCHIVE_REPO_SUBPATH}/${repoRel}` } : {}),
      ...(softDelete
        ? {
            trash_path: `${TRASH_REPO_SUBPATH}/${repoRel}`,
            soft_delete_days: entry?.soft_delete_days,
          }
        : {}),
      policy_path: entry?.path,
      artifact_class: entry?.artifact_class,
      ttl_days: entry?.ttl_days,
      policy_ref: RETENTION_CATALOG_REPO_PATH,
      reason: 'retention TTL elapsed (storage janitor)',
      ...auditExtra,
    });
  }
}

const AUDIT_CHAIN_DAY_FILE_RE = /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/;

/** A day file of the hash-chained master audit log (not storage-retention.jsonl). */
export function isAuditChainDayFile(filePath: string): boolean {
  return (
    nodePath.dirname(filePath) === nodePath.resolve(sharedLogsAudit()) &&
    AUDIT_CHAIN_DAY_FILE_RE.test(nodePath.basename(filePath))
  );
}

/** Each tenant mirror's file for a master audit day, listed before any lock is taken. */
export function auditChainDayMirrors(dayFile: string): string[] {
  const customersDir = nodePath.join(rootDir(), 'customer');
  if (!safeExistsSync(customersDir)) return [];
  return safeReaddir(customersDir)
    .filter(isValidTenantSlug)
    .sort()
    .map((slug) => nodePath.join(customersDir, slug, 'logs', 'audit', dayFile))
    .filter((mirrorFile) => safeExistsSync(mirrorFile));
}

/**
 * Expire one day of the master audit chain together with every tenant mirror's
 * file for the same day. Master and mirror name a day file by the entries'
 * own date, so they hold the same day: expiring only the master would leave
 * mirror entries with no live master copy, which mirror reconcile reports as
 * drift. It all runs under the audit chain lock, so no append lands between
 * the moves, and it is all or nothing: if any move fails, the files already
 * moved are moved back and the day stays live. A day is only ever archived or
 * soft-deleted, never unlinked, so every move can be undone.
 */
export function expireAuditChainDay(
  filePath: string,
  entry: RetentionCatalogEntry,
  outcome: ExpiryOutcome
): void {
  const archive = entry.action === 'archive';
  if (!archive && entry.soft_delete_days === undefined) {
    throw new Error(
      `[JANITOR] audit chain day ${repoRelativePosix(filePath)} not expired — its catalog entry would unlink it | declare action "archive" or soft_delete_days for ${entry.path}`
    );
  }
  const masterRef = repoRelativePosix(filePath);
  withAuditChainLock(() => {
    const moved: string[] = [];
    const attempt: ExpiryOutcome = { deleted: [], softDeleted: [], archived: [] };
    try {
      // Listed under the lock: a tenant rename moves a mirror only while
      // holding it, so the list cannot miss a mirror that just moved.
      for (const mirrorFile of auditChainDayMirrors(nodePath.basename(filePath))) {
        expireFilePerPolicy(mirrorFile, entry, attempt, { audit_master_day: masterRef });
        moved.push(mirrorFile);
      }
      expireFilePerPolicy(filePath, entry, attempt);
    } catch (err) {
      // Every moved file is tried, so one that cannot come back does not
      // strand the rest; the first error stays the reason reported.
      const stranded: string[] = [];
      for (const original of moved.reverse()) {
        const repoRel = repoRelativePosix(original);
        try {
          if (archive) {
            safeMoveSync(nodePath.join(rootDir(), ARCHIVE_REPO_SUBPATH, repoRel), original);
          } else {
            restoreFromTrash(repoRel);
          }
        } catch (rollbackErr) {
          stranded.push(
            `${repoRel} (${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)})`
          );
          continue;
        }
        appendRetentionAudit({
          event: 'RETENTION_ROLLED_BACK',
          path: repoRel,
          policy_ref: RETENTION_CATALOG_REPO_PATH,
          reason: `audit chain day ${masterRef} could not be expired as a whole`,
        });
      }
      if (stranded.length === 0) throw err;
      throw new Error(
        `${err instanceof Error ? err.message : String(err)} — and ${stranded.length} moved file(s) could not be moved back: ${stranded.join('; ')} | restore them from ${archive ? ARCHIVE_REPO_SUBPATH : TRASH_REPO_SUBPATH} before the next run`
      );
    }
    outcome.deleted.push(...attempt.deleted);
    outcome.softDeleted.push(...attempt.softDeleted);
    outcome.archived.push(...attempt.archived);
  });
}
