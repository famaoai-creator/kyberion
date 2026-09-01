import { appendJsonLine, readJson, readJsonLines } from './foundation/json.js';
import * as nodePath from 'node:path';
import { sharedTmp, shared, rootDir, sharedLogsAudit } from './path-resolver.js';
import {
  safeReaddir,
  safeExecResult,
  safeLstat,
  safeStat,
  safeUnlinkSync,
  safeExistsSync,
  safeWriteFile,
  safeMkdir,
  safeMoveSync,
  safeRmSync,
} from './secure-io.js';
import { logger } from './core.js';
import {
  loadRetentionCatalog,
  retentionTtlMsForPath,
  retentionTtlDaysForPath,
  retentionEntryForExactPath,
  retentionEntryForPath,
  reviewRequiredCatalogPaths,
  runtimeRetentionRules,
  eventStoreRetentionRules,
  coveredEventStoreDirs,
  coveredRuntimeSubdirs,
  EVENT_STORE_PREFIXES,
  BUILTIN_RETENTION_DEFAULTS,
  RETENTION_CATALOG_REPO_PATH,
  RETENTION_DAY_MS,
  STORAGE_RETENTION_AUDIT_FILENAME,
  type LoadedRetentionCatalog,
  type RetentionCatalogEntry,
} from './storage-retention-catalog.js';

export const DEFAULT_TMP_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_LOG_RETENTION_DAYS = 30;

/**
 * AL-01: TTL values are now derived from the governance retention catalog
 * (`knowledge/product/governance/storage-retention-catalog.json` via
 * `storage-retention-catalog.ts`). The constants in this file are the
 * last-resort fallback used when even the catalog loader's built-in defaults
 * are bypassed by explicit caller options — the catalog's built-in defaults
 * mirror these values exactly, so behavior is unchanged when the catalog is
 * missing or corrupt.
 *
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
  { subdir: 'a2a-conversations', ttlMs: 30 * DAY_MS },
];

export interface ScanTmpOptions {
  dryRun: boolean;
  ttlMs?: number;
  /** Preloaded retention catalog; loaded on demand when omitted. */
  catalog?: LoadedRetentionCatalog;
}

export interface ScanTmpResult {
  expired: string[];
  deleted: string[];
  /** AL-04: expired files moved to `active/archive/.trash/` instead of unlinked. */
  softDeleted: string[];
}

export interface RotateLogsOptions {
  dryRun: boolean;
  retentionDays?: number;
  /** Preloaded retention catalog; loaded on demand when omitted. */
  catalog?: LoadedRetentionCatalog;
}

export interface RotateLogsResult {
  expired: string[];
  rotated: string[];
  /** AL-04: expired files moved to `active/archive/.trash/` instead of unlinked. */
  softDeleted: string[];
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
  /** AL-04: expired files moved to `active/archive/.trash/` instead of unlinked. */
  softDeleted: string[];
}

/** AL-04 trash sweep result — see `sweepTrash`. */
export interface SweepTrashResult {
  expired: string[];
  purged: string[];
}

/**
 * XP-06 zombie sweep: shape mirrors (deliberately duplicated, not imported —
 * see the comment on `DELEGATION_CHILDREN_REGISTRY_SUBPATH` below)
 * `DelegationChildRecord` in `delegation-concurrency.ts`, the module that
 * writes this registry in real time as CLI delegations start/finish.
 */
export interface DelegationChildRecord {
  id: string;
  provider: string;
  pid?: number;
  startedAt: string;
  deadlineAt: string;
  budgetMs: number;
  /** OS process start time, used to prevent PID-reuse kills after a restart. */
  pidStartedAt?: string;
}

/**
 * Kept as a literal (not imported from `delegation-concurrency.ts`) so this
 * module's existing test-mocking convention (`vi.mock('./path-resolver.js', ...)`
 * with a minimal named-export surface) keeps working unchanged — importing
 * the sibling module would pull in `semaphore.ts` and its own lazy
 * `kill-switch.ts` wiring, none of which this file needs. Keep this string
 * in sync with `DELEGATION_CHILDREN_REGISTRY_SUBPATH` if either changes.
 */
const DELEGATION_CHILDREN_REGISTRY_SUBPATH = 'runtime/delegation-children.json';

export interface SweepDelegationChildrenOptions {
  dryRun: boolean;
  now?: () => number;
  /** Injectable kill seam — production defaults to `process.kill`. Tests MUST inject a fake; never touch real processes. */
  killFn?: (pid: number, signal: NodeJS.Signals) => void;
  /** Test seam and platform adapter for the recorded OS process start time. */
  processStartTimeFn?: (pid: number) => string | undefined;
}

export interface SweepDelegationChildrenResult {
  stale: DelegationChildRecord[];
  killed: DelegationChildRecord[];
  errors: string[];
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
  /** EV-06: append-only event-store files expired / deleted this run. */
  expiredEventStores: number;
  deletedEventStores: number;
  staleDelegationChildren: number;
  killedDelegationChildren: number;
  /**
   * AL-01: repo-relative `active/shared/runtime/<subdir>` directories that
   * exist on disk but are skipped because no retention-catalog entry covers
   * them (reported, never deleted).
   */
  uncoveredRuntimeDirs: string[];
  /**
   * EV-06: event-store directories on disk with no catalog entry. Same
   * contract as `uncoveredRuntimeDirs` — reported, never deleted.
   */
  uncoveredEventStoreDirs: string[];
  /**
   * AL-04: repo-relative directories declared `action: review_required` in
   * the catalog that exist on disk — never deleted, never counted as
   * uncovered, surfaced here for a human retention decision.
   */
  reviewRequiredDirs: string[];
  /** AL-04: files moved to `active/archive/.trash/` this run (soft-delete). */
  softDeleted: number;
  /** AL-04: `.trash/` files past their soft-delete grace this run. */
  expiredTrash: number;
  /** AL-04: `.trash/` files actually purged this run. */
  purgedTrash: number;
  /** Where the TTL rules came from: the governance catalog, or built-in fallback defaults. */
  retentionCatalogSource: 'catalog' | 'builtin-defaults';
  retentionCatalogWarnings: string[];
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
        const stat = safeLstat(fullPath);
        if (stat.isSymbolicLink()) {
          continue;
        }
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

/** Repo-relative POSIX path under the (possibly test-overridden) root. */
export function repoRelativePosix(absolutePath: string): string {
  return nodePath.relative(rootDir(), absolutePath).split(nodePath.sep).join('/');
}

/** AL-04: soft-delete grace floor — see the catalog's `active/archive/.trash` entry. */
export const TRASH_REPO_SUBPATH = 'active/archive/.trash';

/** Grace applied to trashed files whose original path no longer has a covering catalog entry. */
export const DEFAULT_TRASH_GRACE_DAYS = 30;

function trashRootDir(): string {
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

function readTrashIndex(): Map<string, number> {
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
      trashed_at: new Date().toISOString(),
    });
  } catch (err) {
    // Losing the record only costs precision (mtime fallback), never data.
    logger.warn(
      `[JANITOR] failed to record trash index entry for ${originalRepoRelative}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Rewrite the index without records whose trash file no longer exists. */
function pruneTrashIndex(trashedAt: Map<string, number>): void {
  const surviving: string[] = [];
  for (const [repoRel, ms] of trashedAt) {
    const filePath = nodePath.join(trashRootDir(), ...repoRel.split('/'));
    if (safeExistsSync(filePath)) {
      surviving.push(JSON.stringify({ path: repoRel, trashed_at: new Date(ms).toISOString() }));
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
      ts: new Date().toISOString(),
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

/**
 * AL-04: apply a catalog entry's expiry action to one expired file.
 *
 *  - `soft_delete_days` declared → move to
 *    `active/archive/.trash/<original-repo-relative-path>` (structure
 *    preserved) so the trash sweep can purge it after the grace period.
 *  - otherwise → hard delete (unchanged pre-AL-04 behavior).
 *  - `audit: true` (or any soft-delete, which needs a restore trail) → an
 *    audit JSONL record of what/why/policy ref.
 */
function expireFilePerPolicy(
  filePath: string,
  entry: RetentionCatalogEntry | null,
  outcome: { deleted: string[]; softDeleted: string[] }
): void {
  const repoRel = repoRelativePosix(filePath);
  const softDelete = entry?.soft_delete_days !== undefined;
  if (softDelete) {
    softDeleteToTrash(filePath);
    outcome.softDeleted.push(filePath);
    logger.info(`[JANITOR] soft-deleted (trash): ${filePath}`);
  } else {
    safeUnlinkSync(filePath);
    outcome.deleted.push(filePath);
    logger.info(`[JANITOR] deleted: ${filePath}`);
  }
  if (entry?.audit || softDelete) {
    appendRetentionAudit({
      event: softDelete ? 'RETENTION_SOFT_DELETE' : 'RETENTION_DELETE',
      path: repoRel,
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
    });
  }
}

export function scanTmp(opts: ScanTmpOptions): ScanTmpResult {
  const catalog = opts.catalog ?? loadRetentionCatalog();
  const entry = retentionEntryForExactPath(catalog, 'active/shared/tmp');
  const ttlMs =
    opts.ttlMs ?? retentionTtlMsForPath(catalog, 'active/shared/tmp') ?? DEFAULT_TMP_TTL_MS;
  const dir = sharedTmp();
  const now = Date.now();
  const expired: string[] = [];
  const outcome = { deleted: [] as string[], softDeleted: [] as string[] };

  const files = collectFiles(dir);
  for (const filePath of files) {
    try {
      const stat = safeStat(filePath);
      if (now - stat.mtimeMs > ttlMs) {
        expired.push(filePath);
        if (!opts.dryRun) {
          expireFilePerPolicy(filePath, entry, outcome);
        }
      }
    } catch {
      // skip
    }
  }

  return { expired, deleted: outcome.deleted, softDeleted: outcome.softDeleted };
}

export function rotateLogs(opts: RotateLogsOptions): RotateLogsResult {
  const catalog = opts.catalog ?? loadRetentionCatalog();
  const entry = retentionEntryForExactPath(catalog, 'active/shared/logs');
  const retentionDays =
    opts.retentionDays ??
    retentionTtlDaysForPath(catalog, 'active/shared/logs') ??
    DEFAULT_LOG_RETENTION_DAYS;
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  const logsDir = shared('logs');
  const now = Date.now();
  const expired: string[] = [];
  const outcome = { deleted: [] as string[], softDeleted: [] as string[] };

  const files = collectFiles(logsDir);
  for (const filePath of files) {
    try {
      const stat = safeStat(filePath);
      if (now - stat.mtimeMs > retentionMs) {
        expired.push(filePath);
        if (!opts.dryRun) {
          expireFilePerPolicy(filePath, entry, outcome);
        }
      }
    } catch {
      // skip
    }
  }

  return { expired, rotated: outcome.deleted, softDeleted: outcome.softDeleted };
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
      const entry = readJson<Record<string, unknown>>(filePath);
      if (typeof entry.expiresAt === 'string' && Date.parse(entry.expiresAt) <= Date.now()) {
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

export function scanRuntime(opts: {
  dryRun: boolean;
  catalog?: LoadedRetentionCatalog;
}): ScanRuntimeResult {
  const now = Date.now();
  const expired: string[] = [];
  const outcome = { deleted: [] as string[], softDeleted: [] as string[] };

  const rules = runtimeRetentionRules(opts.catalog ?? loadRetentionCatalog());
  for (const rule of rules) {
    const dir = shared(`runtime/${rule.subdir}`);
    for (const filePath of collectFiles(dir)) {
      try {
        const stat = safeStat(filePath);
        if (now - stat.mtimeMs > rule.ttlMs) {
          expired.push(filePath);
          if (!opts.dryRun) {
            expireFilePerPolicy(filePath, rule.entry, outcome);
          }
        }
      } catch {
        // skip
      }
    }
  }

  return { expired, deleted: outcome.deleted, softDeleted: outcome.softDeleted };
}

/**
 * EV-06: expire declared event-store files.
 *
 * Structurally the same walk as {@link scanRuntime}, but rooted at repo paths
 * rather than `active/shared/runtime/<subdir>`, because the event stores sit in
 * three different trees (`observability/`, `coordination/orchestration/events/`,
 * `presence/bridge/runtime/`). Adding a new event stream therefore needs only a
 * catalog entry, not another scan function.
 */
export function scanEventStores(opts: {
  dryRun: boolean;
  catalog?: LoadedRetentionCatalog;
}): ScanRuntimeResult {
  const now = Date.now();
  const expired: string[] = [];
  const outcome = { deleted: [] as string[], softDeleted: [] as string[] };

  const catalog = opts.catalog ?? loadRetentionCatalog();
  const rules = eventStoreRetentionRules(catalog);
  for (const rule of rules) {
    const dir = nodePath.join(rootDir(), rule.repoRelativeDir);
    for (const filePath of collectFiles(dir)) {
      try {
        const repoRelative = nodePath.relative(rootDir(), filePath).split(nodePath.sep).join('/');
        // collectFiles recurses, so a residual parent rule would otherwise also
        // claim files that a more specific child entry governs — applying the
        // wrong TTL and audit flag, and double-counting them in the report.
        // The catalog's contract is longest-prefix; honour it per file.
        const owning = retentionEntryForPath(catalog, repoRelative);
        if (owning && owning !== rule.entry) continue;

        const stat = safeStat(filePath);
        if (now - stat.mtimeMs > rule.ttlMs) {
          expired.push(filePath);
          if (!opts.dryRun) {
            expireFilePerPolicy(filePath, rule.entry, outcome);
          }
        }
      } catch {
        // skip
      }
    }
  }

  return { expired, deleted: outcome.deleted, softDeleted: outcome.softDeleted };
}

/**
 * EV-06: event-store directories present on disk with no catalog entry.
 *
 * The counterpart of {@link listUncoveredRuntimeDirs} for the event-store
 * trees. Reported, never deleted — an undeclared event stream must be visible
 * rather than silently retained forever.
 */
export function listUncoveredEventStoreDirs(catalog?: LoadedRetentionCatalog): string[] {
  const covered = coveredEventStoreDirs(catalog ?? loadRetentionCatalog());
  const uncovered: string[] = [];

  for (const prefix of EVENT_STORE_PREFIXES) {
    const root = nodePath.join(rootDir(), prefix);
    if (!safeExistsSync(root)) continue;
    // A covering entry on the prefix itself governs everything beneath it.
    if (covered.has(prefix)) continue;
    let entries: string[];
    try {
      entries = safeReaddir(root);
    } catch {
      continue;
    }
    for (const name of [...entries].sort()) {
      const repoRelative = `${prefix}/${name}`;
      try {
        const stat = safeLstat(nodePath.join(root, name));
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      } catch {
        continue;
      }
      if (!covered.has(repoRelative)) uncovered.push(repoRelative);
    }
  }
  return uncovered.sort();
}

/**
 * AL-04 trash sweep: purge `active/archive/.trash/` files whose soft-delete
 * grace elapsed. The grace per file is the `soft_delete_days` of the catalog
 * entry that covers the file's ORIGINAL repo-relative path (its path inside
 * the trash mirrors it); files whose original path no longer has a covering
 * entry fall back to `DEFAULT_TRASH_GRACE_DAYS`. The grace is counted from
 * the trash-index `trashed_at` (see {@link TRASH_INDEX_FILENAME}) — NOT from
 * mtime, which a move preserves and which would therefore make an
 * already-expired file purgeable the instant it is trashed. Files with no
 * index record (hand-moved) fall back to mtime.
 */
export function sweepTrash(opts: {
  dryRun: boolean;
  catalog?: LoadedRetentionCatalog;
}): SweepTrashResult {
  const catalog = opts.catalog ?? loadRetentionCatalog();
  const trashRoot = trashRootDir();
  const now = Date.now();
  const expired: string[] = [];
  const purged: string[] = [];
  const trashedAt = readTrashIndex();

  for (const filePath of collectFiles(trashRoot)) {
    try {
      const originalRepoRel = nodePath.relative(trashRoot, filePath).split(nodePath.sep).join('/');
      if (originalRepoRel === TRASH_INDEX_FILENAME) continue;
      const entry = retentionEntryForPath(catalog, originalRepoRel);
      const graceDays = entry?.soft_delete_days ?? DEFAULT_TRASH_GRACE_DAYS;
      const graceStartMs = trashedAt.get(originalRepoRel) ?? safeStat(filePath).mtimeMs;
      if (now - graceStartMs > graceDays * RETENTION_DAY_MS) {
        expired.push(filePath);
        if (!opts.dryRun) {
          safeUnlinkSync(filePath);
          purged.push(filePath);
          logger.info(`[JANITOR] purged trash: ${filePath}`);
          appendRetentionAudit({
            event: 'RETENTION_TRASH_PURGED',
            path: `${TRASH_REPO_SUBPATH}/${originalRepoRel}`,
            original_path: originalRepoRel,
            soft_delete_days: graceDays,
            policy_path: entry?.path,
            policy_ref: RETENTION_CATALOG_REPO_PATH,
            reason: 'soft-delete grace elapsed (janitor trash sweep)',
          });
        }
      }
    } catch {
      // skip
    }
  }

  if (!opts.dryRun && trashedAt.size > 0) pruneTrashIndex(trashedAt);

  return { expired, purged };
}

/**
 * AL-04: repo-relative directories declared `action: review_required` that
 * exist on disk. Never deleted, never uncovered — surfaced so a human can
 * make the retention decision the catalog deliberately refuses to automate.
 */
export function listReviewRequiredDirs(catalog?: LoadedRetentionCatalog): string[] {
  const declared = reviewRequiredCatalogPaths(catalog ?? loadRetentionCatalog());
  const present: string[] = [];
  for (const repoRel of declared) {
    try {
      if (safeExistsSync(nodePath.join(rootDir(), ...repoRel.split('/')))) {
        present.push(repoRel);
      }
    } catch {
      // unreadable — skip
    }
  }
  return present;
}

/**
 * AL-01: `active/shared/runtime/` subdirectories that exist on disk but have
 * no retention-catalog entry. The janitor never deletes these — it reports
 * them so undeclared (silently-forever) retention is visible instead of
 * invisible. Returned repo-relative, sorted, directories only.
 */
export function listUncoveredRuntimeDirs(catalog?: LoadedRetentionCatalog): string[] {
  const covered = coveredRuntimeSubdirs(catalog ?? loadRetentionCatalog());
  const runtimeRoot = shared('runtime');
  if (!safeExistsSync(runtimeRoot)) return [];
  let entries: string[];
  try {
    entries = safeReaddir(runtimeRoot);
  } catch {
    return [];
  }
  const uncovered: string[] = [];
  for (const name of [...entries].sort()) {
    try {
      const stat = safeLstat(nodePath.join(runtimeRoot, name));
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    if (!covered.has(name)) uncovered.push(`active/shared/runtime/${name}`);
  }
  return uncovered;
}

function readDelegationChildrenRegistry(): DelegationChildRecord[] {
  const filePath = shared(DELEGATION_CHILDREN_REGISTRY_SUBPATH);
  if (!safeExistsSync(filePath)) return [];
  const parsed = readJson<unknown>(filePath);
  return Array.isArray(parsed) ? parsed : [];
}

function writeDelegationChildrenRegistry(records: DelegationChildRecord[]): void {
  safeWriteFile(shared(DELEGATION_CHILDREN_REGISTRY_SUBPATH), JSON.stringify(records, null, 2));
}

function resolveProcessStartTime(pid: number): string | undefined {
  try {
    const result = safeExecResult('ps', ['-p', String(pid), '-o', 'lstart='], {
      timeoutMs: 1000,
      maxOutputMB: 1,
    });
    const parsed = Date.parse(result.stdout.trim());
    return result.status === 0 && Number.isFinite(parsed)
      ? new Date(parsed).toISOString()
      : undefined;
  } catch {
    return undefined;
  }
}

function sameProcessIdentity(
  record: DelegationChildRecord,
  processStartTimeFn: (pid: number) => string | undefined
): boolean {
  if (!Number.isInteger(record.pid) || (record.pid as number) <= 0) return false;
  if (!record.pidStartedAt) return false;
  const current = processStartTimeFn(record.pid as number);
  const expectedMs = Date.parse(record.pidStartedAt);
  const currentMs = current ? Date.parse(current) : Number.NaN;
  return Number.isFinite(expectedMs) && Number.isFinite(currentMs) && expectedMs === currentMs;
}

/**
 * XP-06 zombie sweep: reap orphaned CLI child processes whose wall-clock
 * budget (`delegation-concurrency.ts` `withWallClockBudget`) expired without
 * the in-process SIGTERM->SIGKILL escalation completing — e.g. the Kyberion
 * process itself exited or restarted between the timeout firing and the
 * grace window elapsing, orphaning the child. This is the maintenance-loop
 * half of XP-06's process-face resource budget; the real-time half lives in
 * `delegation-concurrency.ts`.
 *
 * Follows the janitor's existing dry-run convention: dry-run reports
 * staleness (past `deadlineAt`) without killing anything or mutating the
 * registry file; real mode kills stale PIDs and removes their records.
 * Records without a numeric `pid` are reported as stale but never passed to
 * `killFn` (nothing to kill) and are dropped from the registry alongside the
 * ones that were killed.
 */
export function sweepDelegationChildren(
  opts: SweepDelegationChildrenOptions
): SweepDelegationChildrenResult {
  const now = opts.now ?? Date.now;
  const killFn =
    opts.killFn ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const processStartTimeFn = opts.processStartTimeFn ?? resolveProcessStartTime;
  const errors: string[] = [];

  let records: DelegationChildRecord[] = [];
  try {
    records = readDelegationChildrenRegistry();
  } catch (err: any) {
    errors.push(`read: ${err?.message ?? String(err)}`);
    return { stale: [], killed: [], errors };
  }

  const nowMs = now();
  const stale = records.filter((r) => {
    const deadline = Date.parse(r.deadlineAt);
    return Number.isFinite(deadline) && deadline <= nowMs;
  });

  const killed: DelegationChildRecord[] = [];
  if (!opts.dryRun && stale.length > 0) {
    for (const record of stale) {
      if (!sameProcessIdentity(record, processStartTimeFn)) {
        errors.push(
          `pid ${String(record.pid)}: process identity unavailable or changed; refusing to kill`
        );
        continue;
      }
      try {
        killFn(record.pid, 'SIGKILL');
        killed.push(record);
        logger.warn(
          `[JANITOR] reaped orphaned delegation child pid=${record.pid} provider=${record.provider} id=${record.id}`
        );
      } catch (err: any) {
        errors.push(`pid ${record.pid}: ${err?.message ?? String(err)}`);
      }
    }
    const staleIds = new Set(stale.map((r) => r.id));
    const remaining = records.filter((r) => !staleIds.has(r.id));
    try {
      writeDelegationChildrenRegistry(remaining);
    } catch (err: any) {
      errors.push(`write: ${err?.message ?? String(err)}`);
    }
  }

  return { stale, killed, errors };
}

export function runJanitor(opts: { dryRun: boolean }): JanitorReport {
  const errors: string[] = [];

  // AL-01: single catalog load per run — never fatal (the loader falls back
  // to built-in defaults on any catalog problem and reports it via warnings).
  let catalog: LoadedRetentionCatalog;
  try {
    catalog = loadRetentionCatalog();
  } catch (err: any) {
    // Defensive: loadRetentionCatalog itself never throws by contract.
    errors.push(`retention-catalog: ${err?.message ?? String(err)}`);
    catalog = {
      entries: [...BUILTIN_RETENTION_DEFAULTS],
      source: 'builtin-defaults',
      warnings: [],
    };
  }

  let tmpResult: ScanTmpResult = { expired: [], deleted: [], softDeleted: [] };
  try {
    tmpResult = scanTmp({ dryRun: opts.dryRun, catalog });
  } catch (err: any) {
    errors.push(`tmp: ${err?.message ?? String(err)}`);
  }

  let logResult: RotateLogsResult = { expired: [], rotated: [], softDeleted: [] };
  try {
    logResult = rotateLogs({ dryRun: opts.dryRun, catalog });
  } catch (err: any) {
    errors.push(`logs: ${err?.message ?? String(err)}`);
  }

  let vaultResult: ScanDataVaultResult = { expired: [], deleted: [] };
  try {
    vaultResult = scanDataVault({ dryRun: opts.dryRun });
  } catch (err: any) {
    errors.push(`data-vault: ${err?.message ?? String(err)}`);
  }

  let runtimeResult: ScanRuntimeResult = { expired: [], deleted: [], softDeleted: [] };
  try {
    runtimeResult = scanRuntime({ dryRun: opts.dryRun, catalog });
  } catch (err: any) {
    errors.push(`runtime: ${err?.message ?? String(err)}`);
  }

  let eventStoreResult: ScanRuntimeResult = { expired: [], deleted: [], softDeleted: [] };
  try {
    eventStoreResult = scanEventStores({ dryRun: opts.dryRun, catalog });
  } catch (err: any) {
    errors.push(`event-stores: ${err?.message ?? String(err)}`);
  }

  let trashResult: SweepTrashResult = { expired: [], purged: [] };
  try {
    trashResult = sweepTrash({ dryRun: opts.dryRun, catalog });
  } catch (err: any) {
    errors.push(`trash: ${err?.message ?? String(err)}`);
  }

  let uncoveredRuntimeDirs: string[] = [];
  try {
    uncoveredRuntimeDirs = listUncoveredRuntimeDirs(catalog);
  } catch (err: any) {
    errors.push(`uncovered-runtime: ${err?.message ?? String(err)}`);
  }

  let uncoveredEventStoreDirs: string[] = [];
  try {
    uncoveredEventStoreDirs = listUncoveredEventStoreDirs(catalog);
  } catch (err: any) {
    errors.push(`uncovered-event-stores: ${err?.message ?? String(err)}`);
  }

  let reviewRequiredDirs: string[] = [];
  try {
    reviewRequiredDirs = listReviewRequiredDirs(catalog);
  } catch (err: any) {
    errors.push(`review-required: ${err?.message ?? String(err)}`);
  }

  let delegationChildrenResult: SweepDelegationChildrenResult = {
    stale: [],
    killed: [],
    errors: [],
  };
  try {
    delegationChildrenResult = sweepDelegationChildren({ dryRun: opts.dryRun });
    errors.push(...delegationChildrenResult.errors);
  } catch (err: any) {
    errors.push(`delegation-children: ${err?.message ?? String(err)}`);
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
    expiredEventStores: eventStoreResult.expired.length,
    deletedEventStores: eventStoreResult.deleted.length,
    staleDelegationChildren: delegationChildrenResult.stale.length,
    killedDelegationChildren: delegationChildrenResult.killed.length,
    uncoveredRuntimeDirs,
    uncoveredEventStoreDirs,
    reviewRequiredDirs,
    softDeleted:
      tmpResult.softDeleted.length +
      logResult.softDeleted.length +
      runtimeResult.softDeleted.length +
      eventStoreResult.softDeleted.length,
    expiredTrash: trashResult.expired.length,
    purgedTrash: trashResult.purged.length,
    retentionCatalogSource: catalog.source,
    retentionCatalogWarnings: catalog.warnings,
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
    } catch (err) {
      // The marker only powers the staleness gate; a real run without a marker
      // just means the next session re-runs the janitor.
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[JANITOR] failed to persist last-run marker: ${message}`);
    }
  }

  return report;
}

const JANITOR_MARKER_SUBPATH = 'runtime/state/janitor-last-run.json';

export function readJanitorLastRunMs(): number | null {
  const markerPath = shared(JANITOR_MARKER_SUBPATH);
  if (!safeExistsSync(markerPath)) return null;
  try {
    const parsed = readJson<Record<string, unknown>>(markerPath);
    const ts =
      typeof parsed.completed_at === 'string' ? Date.parse(parsed.completed_at) : Number.NaN;
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
