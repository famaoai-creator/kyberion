import { defineCatalog } from './foundation/governed-catalog.js';
import { loadJsonIfPresent } from './foundation/json.js';
import {
  analyzeStoreKeys,
  appendOnlyStoreLockId,
  compactStoreByKey,
  rotateStore,
  rotatedSegmentStem,
} from './append-only-store.js';
import { withLockSync } from './foundation/lock-utils.js';
import {
  ledgerSegmentLastHash,
  listLedgerSegments,
  recordLedgerSegmentArchived,
  SYSTEM_LEDGER_REPO_PATH,
} from './ledger.js';
import { nowIso } from './foundation/time.js';
export {
  readSchedulerOpsAlertDays,
  writeSchedulerOpsAlertDay,
  type SchedulerOpsAlertDays,
} from './scheduler-alert-markers.js';
import * as nodePath from 'node:path';
import { knowledge, sharedTmp, shared, rootDir } from './path-resolver.js';
import {
  safeReaddir,
  safeExecResult,
  safeLstat,
  safeStat,
  safeUnlinkSync,
  safeRmdirSync,
  safeExistsSync,
  safeWriteFile,
} from './secure-io.js';
import { reportScratchCodeGrace, selectExpiredTmpFiles } from './scratch-promotion-grace.js';
import { collectDirsPostOrder, collectFiles } from './storage-walk.js';
import { listUncoveredRuntimeDirs, listUncoveredRuntimeFiles } from './storage-runtime-coverage.js';
export {
  listUncoveredRuntimeDirs,
  listUncoveredRuntimeEntries,
  listUncoveredRuntimeFiles,
} from './storage-runtime-coverage.js';
import { logger } from './core.js';
import { withExecutionContext } from './authority.js';
import { loadVaultEntryAtPath } from './data-vault.js';
import {
  DELEGATION_CHILDREN_REGISTRY_SUBPATH,
  loadDelegationChildrenRegistryAtPath,
  writeDelegationChildrenRegistryAtPath,
  type DelegationChildRecord,
} from './mission/delegation-child-registry.js';
import {
  loadRetentionCatalog,
  retentionTtlMsForPath,
  retentionTtlDaysForPath,
  retentionEntryForExactPath,
  retentionEntryForPath,
  reviewRequiredCatalogPaths,
  runtimeRetentionRules,
  eventStoreRetentionRules,
  storageFloorRetentionRules,
  coveredEventStoreDirs,
  catalogStatusRules,
  statusRulePatternToRegex,
  appendOnlyStoreEntries,
  EVENT_STORE_PREFIXES,
  BUILTIN_RETENTION_DEFAULTS,
  RETENTION_CATALOG_REPO_PATH,
  RETENTION_DAY_MS,
  type LoadedRetentionCatalog,
  type RetentionCatalogEntry,
  type RetentionStatusRule,
} from './storage-retention-catalog.js';
import {
  sweepRegisteredWorkspaces,
  type SweepWorkspacesOptions,
  type SweepWorkspacesResult,
} from './workforce/workspace-sweep.js';
import {
  compactArtifactOwnershipRegistry,
  type ArtifactOwnershipCompaction,
} from './workforce/artifact-registry.js';
import {
  listSupervisorEventFiles,
  SUPERVISOR_EVENTS_FILE_PATTERN,
  SUPERVISOR_EVENTS_LEGACY_FILE,
} from './agent/agent-runtime-events.js';
import { trashedAtFor } from './storage-trash-grace.js';
import {
  repoRelativePosix,
  TRASH_REPO_SUBPATH,
  ARCHIVE_REPO_SUBPATH,
  COMPACTION_ARCHIVE_REPO_SUBPATH,
  DEFAULT_ROTATE_MIN_BYTES,
  DEFAULT_COMPACT_MIN_BYTES,
  DEFAULT_TRASH_GRACE_DAYS,
  TRASH_INDEX_FILENAME,
  appendRetentionAudit,
  trashRootDir,
  readTrashIndex,
  pruneTrashIndex,
  expireFilePerPolicy,
  isAuditChainDayFile,
  auditChainDayMirrors,
  expireAuditChainDay,
  type ExpiryOutcome,
} from './storage-retention-expiry.js';
export {
  repoRelativePosix,
  TRASH_REPO_SUBPATH,
  ARCHIVE_REPO_SUBPATH,
  COMPACTION_ARCHIVE_REPO_SUBPATH,
  DEFAULT_ROTATE_MIN_BYTES,
  DEFAULT_COMPACT_MIN_BYTES,
  ROTATED_SEGMENT_SUFFIX_PATTERN,
  DEFAULT_TRASH_GRACE_DAYS,
  TRASH_INDEX_FILENAME,
  appendRetentionAudit,
  softDeleteToTrash,
  restoreFromTrash,
} from './storage-retention-expiry.js';

export { trashedAtFor };

export const DEFAULT_TMP_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_LOG_RETENTION_DAYS = 30;
/** AC-10: default retention for the dated `agent-runtime-supervisor-events-YYYY-MM-DD.jsonl`
 * family. See `sweepSupervisorEventFiles` and `SUPERVISOR_EVENTS_RETENTION_PATH`. */
export const DEFAULT_SUPERVISOR_EVENTS_RETENTION_DAYS = 14;
/**
 * AC-10: virtual (non-directory) retention-catalog lookup key for the dated
 * supervisor-event family. Resolved by *exact* match only — the same pattern
 * `scanTmp`/`rotateLogs` use for `active/shared/tmp` / `active/shared/logs` —
 * never by directory-prefix walk, so it cannot shadow the real
 * `active/shared/observability/mission-control` directory entry that still
 * governs `task-events.jsonl` / `orchestration-events.jsonl` at their own
 * (longer) TTL. The pre-rotation `agent-runtime-supervisor-events.jsonl`
 * legacy file is deliberately excluded from both that entry's sweep and this
 * one — it is never auto-deleted (see `scanEventStores`).
 */
export const SUPERVISOR_EVENTS_RETENTION_PATH =
  'active/shared/observability/mission-control/agent-runtime-supervisor-events';

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
  /** Expired files moved to `active/archive/<repo-rel>` by an `archive` entry. */
  archived: string[];
  codeGrace?: ReturnType<typeof reportScratchCodeGrace>; // dirs held by code_grace_days
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
  /** Expired files moved to `active/archive/<repo-rel>` by an `archive` entry. */
  archived: string[];
  /** Audit chain days that could not be expired as a whole (left live). */
  errors?: string[];
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
  /** Expired files moved to `active/archive/<repo-rel>` by an `archive` entry. */
  archived: string[];
}

/** AL-04 trash sweep result — see `sweepTrash`. */
export interface SweepTrashResult {
  expired: string[];
  purged: string[];
}

/** XP-06 zombie sweep uses the same schema-bound record contract as its producer. */
export type { DelegationChildRecord } from './mission/delegation-child-registry.js';

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

export type { SweepWorkspacesOptions, SweepWorkspacesResult } from './workforce/workspace-sweep.js';

export interface JanitorWorkspacesReport {
  registered: number;
  orphaned: number;
  deleted: number;
  unregisteredDirs: string[];
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
  /** Storage-layout floors (staging/cache/artifacts) expired / deleted this run. */
  expiredStorageFloors: number;
  deletedStorageFloors: number;
  /** AC-10: dated supervisor-event files expired / deleted this run (legacy file never included). */
  expiredSupervisorEvents: number;
  deletedSupervisorEvents: number;
  /** WI-16: files expired / deleted this run by a catalog `status_rules` entry. */
  expiredStatusRules: number;
  deletedStatusRules: number;
  /**
   * MSN-LOG-STORE-HARDENING-20261016: append-only `.jsonl` store maintenance —
   * live files rotated to `<stem>-YYYYMMDD-HHmmss.jsonl` segments, keyed
   * stores folded by `compact_key`, and aged segments expired/archived.
   */
  appendOnlyStores: {
    rotated: string[];
    compacted: string[];
    segmentsExpired: string[];
    segmentsArchived: string[];
  };
  /** Total expired files moved to `active/archive/` across all sweeps (archive action). */
  archived: number;
  staleDelegationChildren: number;
  killedDelegationChildren: number;
  /**
   * Artifact ownership registry rows that are superseded (an older row of an
   * artifact re-registered since): reported in dry run, removed otherwise.
   */
  supersededArtifactOwnershipRows: number;
  compactedArtifactOwnershipRows: number;
  /** WS-07: ledger-registered workspace sweep (orphans deleted only through the ledger). */
  workspaces: JanitorWorkspacesReport;
  /**
   * File-free directory debris under `active/missions/` swept this run —
   * dirs whose whole subtree holds no real file (never a ledger-bearing
   * mission). `candidates` is the full list found; `removed` what this run
   * actually deleted (empty in dry-run).
   */
  emptyMissionDirs: { candidates: string[]; removed: string[] };
  /**
   * AL-01: repo-relative `active/shared/runtime/<subdir>` directories that
   * exist on disk but are skipped because no retention-catalog entry covers
   * them (reported, never deleted).
   */
  uncoveredRuntimeDirs: string[];
  /** G01: top-level runtime files (ledgers, state) with no entry — reported, never deleted. */
  uncoveredRuntimeFiles: string[];
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

export function scanTmp(opts: ScanTmpOptions): ScanTmpResult {
  const catalog = opts.catalog ?? loadRetentionCatalog();
  const entry = retentionEntryForExactPath(catalog, 'active/shared/tmp');
  const ttlMs =
    opts.ttlMs ?? retentionTtlMsForPath(catalog, 'active/shared/tmp') ?? DEFAULT_TMP_TTL_MS;
  const dir = sharedTmp();
  const now = Date.now();
  const expired: string[] = [];
  const outcome: ExpiryOutcome = { deleted: [], softDeleted: [], archived: [] };

  const selection = selectExpiredTmpFiles(collectFiles(dir), ttlMs, now, entry?.code_grace_days);
  for (const filePath of selection.expired) {
    expired.push(filePath);
    if (opts.dryRun) continue;
    try {
      expireFilePerPolicy(filePath, entry, outcome);
    } catch {
      // skip
    }
  }

  // collectFiles only sees files, so job-scoped directories under tmp/ never
  // expire: empty staging dirs and dirs emptied by the file sweep accumulate
  // forever (observed: hundreds of month-old empty dirs with Expired: 0 in
  // the janitor report). Prune a directory once it is empty and either (a)
  // its own mtime is past TTL or (b) this run just removed its last files.
  const emptiedBySweep = new Set<string>();
  for (const filePath of [...outcome.deleted, ...outcome.softDeleted]) {
    let parent = nodePath.dirname(filePath);
    while (parent.startsWith(dir + nodePath.sep)) {
      emptiedBySweep.add(parent);
      parent = nodePath.dirname(parent);
    }
  }
  for (const dirPath of collectDirsPostOrder(dir)) {
    try {
      const stat = safeLstat(dirPath);
      if (now - stat.mtimeMs <= ttlMs && !emptiedBySweep.has(dirPath)) continue;
      if (safeReaddir(dirPath).length > 0) continue;
      expired.push(dirPath);
      if (!opts.dryRun) {
        safeRmdirSync(dirPath);
        outcome.deleted.push(dirPath);
        logger.info(`[JANITOR] deleted empty dir: ${dirPath}`);
        if (entry?.audit) {
          appendRetentionAudit({
            event: 'RETENTION_DELETE',
            path: repoRelativePosix(dirPath),
            policy_path: entry?.path,
            artifact_class: entry?.artifact_class,
            ttl_days: entry?.ttl_days,
            policy_ref: RETENTION_CATALOG_REPO_PATH,
            reason: 'retention TTL elapsed (storage janitor, empty dir prune)',
          });
        }
      }
    } catch {
      // skip
    }
  }

  return {
    expired,
    deleted: outcome.deleted,
    softDeleted: outcome.softDeleted,
    archived: outcome.archived,
    codeGrace: reportScratchCodeGrace(selection.grace, now, opts.dryRun),
  };
}

export function rotateLogs(opts: RotateLogsOptions): RotateLogsResult {
  const catalog = opts.catalog ?? loadRetentionCatalog();
  const entry = retentionEntryForExactPath(catalog, 'active/shared/logs');
  const fallbackRetentionDays =
    opts.retentionDays ??
    retentionTtlDaysForPath(catalog, 'active/shared/logs') ??
    DEFAULT_LOG_RETENTION_DAYS;
  const logsDir = shared('logs');
  const now = Date.now();
  const expired: string[] = [];
  const errors: string[] = [];
  const outcome: ExpiryOutcome = { deleted: [], softDeleted: [], archived: [] };

  const files = collectFiles(logsDir);
  for (const filePath of files) {
    try {
      // Per-file longest-prefix resolution (same contract as the event-store
      // sweep): a nested entry like `logs/audit` (archive@90d) governs its own
      // subtree instead of the logs-root delete TTL. Entries without a
      // ttl_days — and `review_required` / file-level `rotate`/`compact`
      // entries — never expire a file from this sweep.
      const fileEntry = retentionEntryForPath(catalog, repoRelativePosix(filePath)) ?? entry;
      if (!fileEntry || (fileEntry.action !== 'delete' && fileEntry.action !== 'archive')) continue;
      // The fallback (catalog `logs` TTL, else the built-in 30d) applies only
      // to files still governed by the logs root entry itself; a nested
      // note-only entry without ttl_days means "no expiry declared".
      const ttlDays =
        fileEntry.ttl_days ?? (fileEntry === entry ? fallbackRetentionDays : undefined);
      if (ttlDays === undefined) continue;
      const stat = safeStat(filePath);
      if (now - stat.mtimeMs > ttlDays * RETENTION_DAY_MS) {
        expired.push(filePath);
        if (isAuditChainDayFile(filePath)) {
          expired.push(...auditChainDayMirrors(nodePath.basename(filePath)));
          if (!opts.dryRun) {
            try {
              expireAuditChainDay(filePath, fileEntry, outcome);
            } catch (err) {
              errors.push(
                `${repoRelativePosix(filePath)}: ${err instanceof Error ? err.message : String(err)}`
              );
            }
          }
        } else if (!opts.dryRun) {
          expireFilePerPolicy(filePath, fileEntry, outcome);
        }
      }
    } catch {
      // skip
    }
  }

  return {
    expired,
    rotated: outcome.deleted,
    softDeleted: outcome.softDeleted,
    archived: outcome.archived,
    ...(errors.length > 0 ? { errors } : {}),
  };
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
      const entry = loadVaultEntryAtPath(filePath);
      if (entry?.expiresAt && Date.parse(entry.expiresAt) <= Date.now()) {
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
  const outcome: ExpiryOutcome = { deleted: [], softDeleted: [], archived: [] };

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

  return {
    expired,
    deleted: outcome.deleted,
    softDeleted: outcome.softDeleted,
    archived: outcome.archived,
  };
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
/** Tracked keep-files that must survive inside event-store trees. */
const EVENT_STORE_PROTECTED_BASENAMES = new Set(['.gitignore', '.gitkeep', '.gitattributes']);

export function scanEventStores(opts: {
  dryRun: boolean;
  catalog?: LoadedRetentionCatalog;
}): ScanRuntimeResult {
  const catalog = opts.catalog ?? loadRetentionCatalog();
  return sweepRepoRootedRules(eventStoreRetentionRules(catalog), catalog, opts.dryRun);
}

/**
 * Storage-layout floors (`active/shared/{staging,cache,artifacts}`): same
 * declared-entry sweep as the event stores, so a new floor subtree needs only
 * a catalog entry.
 */
export function scanStorageFloors(opts: {
  dryRun: boolean;
  catalog?: LoadedRetentionCatalog;
}): ScanRuntimeResult {
  const catalog = opts.catalog ?? loadRetentionCatalog();
  return sweepRepoRootedRules(storageFloorRetentionRules(catalog), catalog, opts.dryRun);
}

function sweepRepoRootedRules(
  rules: Array<{ repoRelativeDir: string; ttlMs: number; entry: RetentionCatalogEntry }>,
  catalog: LoadedRetentionCatalog,
  dryRun: boolean
): ScanRuntimeResult {
  const now = Date.now();
  const expired: string[] = [];
  const outcome: ExpiryOutcome = { deleted: [], softDeleted: [], archived: [] };
  for (const rule of rules) {
    const dir = nodePath.join(rootDir(), rule.repoRelativeDir);
    for (const filePath of collectFiles(dir)) {
      try {
        // AC-10: the supervisor-event family has its own dedicated sweep
        // (`sweepSupervisorEventFiles`) with a shorter default TTL, and the
        // legacy unrotated file must never be auto-deleted at all. Both are
        // filename-matched (not path-prefix-matched, see
        // `SUPERVISOR_EVENTS_RETENTION_PATH`), so exclude them here
        // explicitly rather than relying on catalog prefix resolution.
        const baseName = nodePath.basename(filePath);
        if (
          baseName === SUPERVISOR_EVENTS_LEGACY_FILE ||
          SUPERVISOR_EVENTS_FILE_PATTERN.test(baseName) ||
          // Tracked infrastructure inside runtime dirs (e.g.
          // presence/bridge/runtime/.gitignore, which is what keeps the rest
          // of the tree gitignored) is never retention debris.
          EVENT_STORE_PROTECTED_BASENAMES.has(baseName)
        ) {
          continue;
        }

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
          if (!dryRun) {
            expireFilePerPolicy(filePath, rule.entry, outcome);
          }
        }
      } catch {
        // skip
      }
    }
  }

  return {
    expired,
    deleted: outcome.deleted,
    softDeleted: outcome.softDeleted,
    archived: outcome.archived,
  };
}

/**
 * WI-16: expire individual files by their OWN JSON status + age field,
 * declared per-directory-entry via the catalog's `status_rules` vocabulary
 * (see `storage-retention-catalog.ts`'s `RetentionStatusRule`).
 *
 * This closes the gap directory-level `ttl_days`/mtime cannot express: a
 * directory that legitimately holds a mix of statuses (e.g.
 * `knowledge/personal/members/<id>/work-inventory/observations/*.json`,
 * `pending_review | confirmed | discarded`) where only some statuses should
 * ever expire, and only counting from a per-file date field, not mtime.
 *
 * Fail-safe per file: malformed JSON, a non-object body, a missing/wrong-type
 * `status_field` or `age_field`, or an unparseable `age_field` date all skip
 * the file — it is never deleted on doubt. A file whose status is not one of
 * the rule's `statuses` simply isn't a candidate (not an error).
 */
/**
 * Reads `filePath` and returns its status when it is a candidate of `rule`
 * that is past the rule's ttl at `now`; `null` otherwise (including every
 * fail-safe skip: malformed JSON, non-object body, missing/wrong-type status or
 * age field, unparseable date, status outside `rule.statuses`, still in ttl).
 */
function expiredStatusRuleMatch(
  filePath: string,
  rule: RetentionStatusRule,
  now: number
): string | null {
  let parsed: unknown;
  try {
    parsed = loadJsonIfPresent<Record<string, unknown>>(filePath);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null; // malformed → skip

  const record = parsed as Record<string, unknown>;
  const status = record[rule.status_field];
  if (typeof status !== 'string' || !rule.statuses.includes(status)) return null; // not a candidate

  const ageRaw = record[rule.age_field];
  if (typeof ageRaw !== 'string') return null; // missing/wrong-type age field → skip
  const ageMs = Date.parse(ageRaw);
  if (!Number.isFinite(ageMs)) return null; // unparseable date → skip

  return now - ageMs > rule.ttl_days * RETENTION_DAY_MS ? status : null;
}

export function sweepStatusRules(opts: {
  dryRun: boolean;
  catalog?: LoadedRetentionCatalog;
}): ScanRuntimeResult {
  // Status-rule areas live under tier-guarded knowledge (e.g.
  // knowledge/personal/members/**): without a system context every read is
  // denied and the fail-safe skip would silently expire nothing. The sweep is
  // synchronous, so one context covers every read and delete it makes.
  return withExecutionContext('ecosystem_architect', () => sweepStatusRulesInContext(opts));
}

function sweepStatusRulesInContext(opts: {
  dryRun: boolean;
  catalog?: LoadedRetentionCatalog;
}): ScanRuntimeResult {
  const catalog = opts.catalog ?? loadRetentionCatalog();
  const now = Date.now();
  const expired: string[] = [];
  const outcome: ExpiryOutcome = { deleted: [], softDeleted: [], archived: [] };

  for (const { entry, rule } of catalogStatusRules(catalog)) {
    const entryDir = nodePath.join(rootDir(), ...entry.path.split('/'));
    const matcher = statusRulePatternToRegex(rule.path_pattern);
    for (const filePath of collectFiles(entryDir)) {
      try {
        const relativeToEntry = nodePath.relative(entryDir, filePath).split(nodePath.sep).join('/');
        // collectFiles never walks outside entryDir (symlinks are skipped),
        // so relativeToEntry can never carry a leading '..' — the pattern
        // itself is also validated at load time to reject '..' segments.
        if (!matcher.test(relativeToEntry)) continue;

        const status = expiredStatusRuleMatch(filePath, rule, now);
        if (status === null) continue;

        if (opts.dryRun) {
          expired.push(filePath);
          continue;
        }
        // Narrow the scan-vs-confirm race: a member may confirm (or restore)
        // the file between the scan read above and the delete. Re-read right
        // before deleting and skip unless the status and age still match.
        if (expiredStatusRuleMatch(filePath, rule, Date.now()) !== status) {
          logger.info(`[JANITOR] status changed before delete, kept: ${filePath}`);
          continue;
        }
        expired.push(filePath);
        expireFilePerPolicy(filePath, entry, outcome, {
          status_rule_id: rule.id,
          status,
          status_field: rule.status_field,
          age_field: rule.age_field,
          status_rule_ttl_days: rule.ttl_days,
        });
      } catch {
        // skip — never delete on doubt
      }
    }
  }

  return {
    expired,
    deleted: outcome.deleted,
    softDeleted: outcome.softDeleted,
    archived: outcome.archived,
  };
}

export interface SweepSupervisorEventFilesOptions {
  dryRun: boolean;
  /** Override the resolved TTL (days). Falls back to the catalog, then `DEFAULT_SUPERVISOR_EVENTS_RETENTION_DAYS`. */
  retentionDays?: number;
  /** Preloaded retention catalog; loaded on demand when omitted. */
  catalog?: LoadedRetentionCatalog;
  /** Test override for the directory to scan — forwarded to `listSupervisorEventFiles`. */
  dir?: string;
  /** Test override for "now" — forwarded to `listSupervisorEventFiles`'s recency math (unused here beyond that). */
  now?: string;
}

/**
 * AC-10: prune dated `agent-runtime-supervisor-events-YYYY-MM-DD.jsonl`
 * files older than the retention window (default 14 days, see
 * `SUPERVISOR_EVENTS_RETENTION_PATH`). The pre-rotation legacy file
 * (`agent-runtime-supervisor-events.jsonl`) is NEVER included —
 * `listSupervisorEventFiles({ includeLegacy: false })` excludes it by
 * construction — leaving its retention to an operator's own judgment.
 */
export function sweepSupervisorEventFiles(
  opts: SweepSupervisorEventFilesOptions
): ScanRuntimeResult {
  const catalog = opts.catalog ?? loadRetentionCatalog();
  const entry = retentionEntryForExactPath(catalog, SUPERVISOR_EVENTS_RETENTION_PATH);
  const retentionDays =
    opts.retentionDays ??
    retentionTtlDaysForPath(catalog, SUPERVISOR_EVENTS_RETENTION_PATH) ??
    DEFAULT_SUPERVISOR_EVENTS_RETENTION_DAYS;
  const retentionMs = retentionDays * RETENTION_DAY_MS;
  const now = Date.now();
  const expired: string[] = [];
  const outcome: ExpiryOutcome = { deleted: [], softDeleted: [], archived: [] };

  const files = listSupervisorEventFiles({
    includeLegacy: false,
    dir: opts.dir,
    now: opts.now,
  });
  for (const file of files) {
    try {
      if (!safeExistsSync(file.path)) continue;
      const stat = safeStat(file.path);
      if (now - stat.mtimeMs > retentionMs) {
        expired.push(file.path);
        if (!opts.dryRun) {
          expireFilePerPolicy(file.path, entry, outcome);
        }
      }
    } catch {
      // skip
    }
  }

  return {
    expired,
    deleted: outcome.deleted,
    softDeleted: outcome.softDeleted,
    archived: outcome.archived,
  };
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
 * MSN-LOG-STORE-HARDENING-20261016: maintenance pass for append-only
 * `.jsonl` stores declared `action: 'rotate' | 'compact'` in the catalog.
 *
 * Directory mtime TTL can never expire a file that is appended to daily —
 * the file's own mtime is always fresh, so these stores grew without bound
 * in silence (observed: a 31MB `items.jsonl` of 853 versioned lines for 101
 * live items; every coordination read parses the whole file). These stores
 * therefore need file-level maintenance, not expiry:
 *
 *  - `rotate`: when the live file exceeds `rotate_min_bytes` (default
 *    {@link DEFAULT_ROTATE_MIN_BYTES}) it is renamed to a
 *    `<stem>-YYYYMMDD-HHmmss.jsonl` sibling. Writers reopen the canonical
 *    path per append, so appends continue uninterrupted. Segments past
 *    `ttl_days` are expired through {@link expireFilePerPolicy} with the
 *    entry's `segment_action` (default `delete`, `archive` for
 *    evidence-class ledgers).
 *  - `compact`: when the file exceeds `compact_min_bytes` (default
 *    {@link DEFAULT_COMPACT_MIN_BYTES}) it is folded to the last record per
 *    `compact_key` (order of last appearance preserved; keyless records are
 *    kept verbatim). The pre-compaction file is first copied under
 *    `active/archive/jsonl-compaction/<repo-rel>.<stamp>.jsonl`, then the
 *    live file is rewritten through safeWriteFile's atomic temp+rename.
 *  - `self_managed: true` (either action): the writer owns live-file
 *    retention under its own lock (the trigger journal's 7-day dedupe
 *    window), so the janitor never rotates or compacts the live file and
 *    only expires already-rotated segments by `ttl_days`.
 *
 * Every mutation emits a RETENTION_ROTATE / RETENTION_COMPACT / segment
 * expiry record to the retention audit log. Nothing here deletes the live
 * file itself. Live-file rotation and compaction run under the store's
 * write-time maintenance lock and skip a busy store until the next sweep.
 * The hash-chained system ledger's segments are archived oldest-first in
 * chain order with a signed receipt on the ledger
 * ({@link archiveExpiredLedgerSegments}).
 */
export interface SweepAppendOnlyStoresResult {
  rotated: string[];
  compacted: string[];
  segmentsExpired: string[];
  segmentsDeleted: string[];
  segmentsArchived: string[];
  errors: string[];
}

/**
 * Race-safe streaming compaction of a live append-only store, delegated to
 * `compactStoreByKey` (append-only-store.ts) — the same park/stage protocol
 * the janitor used before, without whole-file reads, so a store past the
 * 100MB read cap stays compactable. This wrapper keeps the janitor's
 * RETENTION_COMPACT_ARCHIVE audit and log line. The caller holds the store's
 * write-time maintenance lock ({@link withStoreLock}).
 */
function compactAppendOnlyFile(
  livePath: string,
  entry: RetentionCatalogEntry,
  keyField: string,
  now: Date
): void {
  const result = compactStoreByKey(livePath, {
    key: keyField,
    now,
    archiveDir: nodePath.join(
      rootDir(),
      COMPACTION_ARCHIVE_REPO_SUBPATH,
      nodePath.dirname(entry.path)
    ),
  });
  if (!result) return;
  appendRetentionAudit({
    event: 'RETENTION_COMPACT_ARCHIVE',
    path: repoRelativePosix(livePath),
    archive_path: result.archivePath ? repoRelativePosix(result.archivePath) : undefined,
    compact_key: keyField,
    before_lines: result.before,
    after_lines: result.after,
    merged_during_compaction: result.merged,
    policy_path: entry.path,
    artifact_class: entry.artifact_class,
    policy_ref: RETENTION_CATALOG_REPO_PATH,
    reason: 'pre-compaction archive (storage janitor)',
  });
  logger.info(
    `[JANITOR] compacted: ${livePath} (${result.before} -> ${result.after} records; union archived, ${result.merged} live merge(s))`
  );
}

/** How long the janitor waits for a store's maintenance lock before skipping it this sweep. */
export const JANITOR_STORE_LOCK_TIMEOUT_MS = 2000;

/**
 * Run a live-file mutation (rotate / compact) under the store's write-time
 * maintenance lock (`appendOnlyStoreLockId`, the lock `maintainStoreAfterAppend`
 * and the compaction-copy recovery take), so a parked rewrite never
 * interleaves with another one. A busy store is skipped this sweep (returns
 * false) — the next sweep retries.
 */
function withStoreLock(livePath: string, timeoutMs: number, fn: () => void): boolean {
  try {
    withLockSync(appendOnlyStoreLockId(livePath), fn, timeoutMs);
    return true;
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith('[LOCK_TIMEOUT]')) throw err;
    logger.warn(
      `[JANITOR] store maintenance skipped — another writer holds the store lock | next: none, the next sweep retries | evidence: ${repoRelativePosix(livePath)} (waited ${timeoutMs}ms)`
    );
    return false;
  }
}

/**
 * Archive expired segments of the hash-chained system ledger, oldest first
 * in chain order (stamp, then numeric suffix — ledger.ts ordering), stopping
 * at the first segment that has not expired so the remaining segments stay
 * a contiguous suffix of the chain. The newest segment is never archived (it
 * may carry the chain tail while the live file is empty). After each move a
 * keyed LEDGER_SEGMENT_ARCHIVED receipt goes on the live ledger — the proof
 * verification needs to accept a chain that starts at a segment marker.
 * Segments are only ever archived, never deleted.
 */
function archiveExpiredLedgerSegments(
  livePath: string,
  entry: RetentionCatalogEntry,
  ttlMs: number,
  nowMs: number,
  dryRun: boolean,
  result: SweepAppendOnlyStoresResult
): void {
  const segments = listLedgerSegments(livePath).slice(0, -1);
  const archiveEntry: RetentionCatalogEntry = { ...entry, action: 'archive' };
  for (const segmentPath of segments) {
    if (nowMs - safeStat(segmentPath).mtimeMs <= ttlMs) break;
    result.segmentsExpired.push(segmentPath);
    if (dryRun) continue;
    const lastHash = ledgerSegmentLastHash(segmentPath);
    const outcome: ExpiryOutcome = { deleted: [], softDeleted: [], archived: [] };
    expireFilePerPolicy(segmentPath, archiveEntry, outcome);
    result.segmentsArchived.push(...outcome.archived);
    recordLedgerSegmentArchived({
      segment: segmentPath,
      last_hash: lastHash,
      archive_path: `${ARCHIVE_REPO_SUBPATH}/${repoRelativePosix(segmentPath)}`,
    });
  }
}

export function sweepAppendOnlyStores(opts: {
  dryRun: boolean;
  catalog?: LoadedRetentionCatalog;
  now?: Date;
  /** Wait for a busy store's maintenance lock (default {@link JANITOR_STORE_LOCK_TIMEOUT_MS}). */
  lockTimeoutMs?: number;
}): SweepAppendOnlyStoresResult {
  const lockTimeoutMs = opts.lockTimeoutMs ?? JANITOR_STORE_LOCK_TIMEOUT_MS;
  const catalog = opts.catalog ?? loadRetentionCatalog();
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const result: SweepAppendOnlyStoresResult = {
    rotated: [],
    compacted: [],
    segmentsExpired: [],
    segmentsDeleted: [],
    segmentsArchived: [],
    errors: [],
  };

  for (const entry of appendOnlyStoreEntries(catalog)) {
    const livePath = nodePath.join(rootDir(), entry.path);
    try {
      if (entry.action === 'rotate') {
        // Expire aged segments first — they age by mtime even when the live
        // file never does.
        if (entry.ttl_days !== undefined && entry.path === SYSTEM_LEDGER_REPO_PATH) {
          archiveExpiredLedgerSegments(
            livePath,
            entry,
            entry.ttl_days * RETENTION_DAY_MS,
            nowMs,
            opts.dryRun,
            result
          );
        } else if (entry.ttl_days !== undefined) {
          const stem = rotatedSegmentStem(livePath);
          const dir = nodePath.dirname(livePath);
          const segmentOutcome: ExpiryOutcome = {
            deleted: [],
            softDeleted: [],
            archived: [],
          };
          const segmentEntry: RetentionCatalogEntry = {
            ...entry,
            action: entry.segment_action ?? 'delete',
          };
          for (const name of safeReaddir(dir)) {
            if (!name.startsWith(`${stem}-`)) continue;
            const suffix = name.slice(stem.length + 1);
            if (!/^\d{8}-\d{6}(-\d+)?\.jsonl$/.test(suffix)) continue;
            const segmentPath = nodePath.join(dir, name);
            try {
              const stat = safeStat(segmentPath);
              if (nowMs - stat.mtimeMs > entry.ttl_days * RETENTION_DAY_MS) {
                result.segmentsExpired.push(segmentPath);
                if (!opts.dryRun) {
                  expireFilePerPolicy(segmentPath, segmentEntry, segmentOutcome);
                }
              }
            } catch {
              // skip
            }
          }
          result.segmentsDeleted.push(...segmentOutcome.deleted);
          result.segmentsArchived.push(...segmentOutcome.archived);
        }

        // The writer owns the live file (e.g. the trigger journal's dedupe
        // window): rotating it here would drop history the writer depends on.
        if (entry.self_managed) continue;
        if (!safeExistsSync(livePath)) continue;
        const stat = safeStat(livePath);
        const threshold = entry.rotate_min_bytes ?? DEFAULT_ROTATE_MIN_BYTES;
        if (stat.size > 0 && stat.size >= threshold) {
          if (opts.dryRun) {
            result.rotated.push(livePath);
            continue;
          }
          let segmentPath: string | null = null;
          if (
            !withStoreLock(
              livePath,
              lockTimeoutMs,
              () => (segmentPath = rotateStore(livePath, { now }))
            )
          )
            continue;
          result.rotated.push(livePath);
          if (segmentPath) {
            appendRetentionAudit({
              event: 'RETENTION_ROTATE',
              path: repoRelativePosix(livePath),
              segment_path: repoRelativePosix(segmentPath),
              size_bytes: stat.size,
              policy_path: entry.path,
              artifact_class: entry.artifact_class,
              policy_ref: RETENTION_CATALOG_REPO_PATH,
              reason: 'append-only file exceeded rotate_min_bytes (storage janitor)',
            });
            logger.info(`[JANITOR] rotated: ${livePath} -> ${segmentPath}`);
          }
        }
      } else if (entry.action === 'compact') {
        const keyField = entry.compact_key as string; // validated at catalog load
        if (entry.self_managed) continue; // the writer compacts inline
        if (!safeExistsSync(livePath)) continue;
        const stat = safeStat(livePath);
        const threshold = entry.compact_min_bytes ?? DEFAULT_COMPACT_MIN_BYTES;
        if (stat.size < threshold) continue;

        // Streaming pre-check (no whole-file read, so no size cap applies).
        const { records, distinctKeys } = analyzeStoreKeys(livePath, keyField);
        if (distinctKeys === records) continue; // nothing to fold

        if (opts.dryRun) {
          result.compacted.push(livePath);
          continue;
        }
        if (
          !withStoreLock(livePath, lockTimeoutMs, () =>
            compactAppendOnlyFile(livePath, entry, keyField, now)
          )
        )
          continue;
        result.compacted.push(livePath);
        appendRetentionAudit({
          event: 'RETENTION_COMPACT',
          path: repoRelativePosix(livePath),
          compact_key: keyField,
          size_before_bytes: stat.size,
          policy_path: entry.path,
          artifact_class: entry.artifact_class,
          policy_ref: RETENTION_CATALOG_REPO_PATH,
          reason: 'versioned keyed store exceeded compact_min_bytes (storage janitor)',
        });
      }
    } catch (err) {
      // One bad entry must not abort the pass — report and continue.
      result.errors.push(`${entry.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
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
      const graceStartMs = trashedAtFor(originalRepoRel, trashedAt) ?? safeStat(filePath).mtimeMs;
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

function readDelegationChildrenRegistry(): DelegationChildRecord[] {
  const filePath = shared(DELEGATION_CHILDREN_REGISTRY_SUBPATH);
  return loadDelegationChildrenRegistryAtPath(filePath);
}

function writeDelegationChildrenRegistry(records: DelegationChildRecord[]): void {
  writeDelegationChildrenRegistryAtPath(records, shared(DELEGATION_CHILDREN_REGISTRY_SUBPATH));
}

function resolveProcessStartTime(pid: number): string | undefined {
  try {
    const result = safeExecResult('ps', ['-p', String(pid), '-o', 'lstart='], {
      timeoutMs: 1000,
      maxOutputMB: 1,
    });
    const parsed = Date.parse(result.stdout.trim());
    return result.status === 0 && Number.isFinite(parsed) ? nowIso(new Date(parsed)) : undefined;
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

/** WS-07 workspace sweep with the janitor's retention audit wired in. */
export function sweepWorkspaces(opts: SweepWorkspacesOptions): SweepWorkspacesResult {
  return sweepRegisteredWorkspaces({ audit: appendRetentionAudit, ...opts });
}

export interface SweepEmptyMissionDirsResult {
  /** Repo-relative dirs whose subtree holds no meaningful files (post-order, deepest first). */
  candidates: string[];
  removed: string[];
  errors: string[];
}

const MISSIONS_ROOT_REPO_PATH = 'active/missions';
const EMPTY_DIR_DEBRIS_FILES = new Set(['.DS_Store', 'Thumbs.db']);
/**
 * Subtrees the sweep never descends into: VCS and dependency internals are
 * managed by their own tooling — an "empty" `.git/objects/pack` or a
 * symlink-farmed `node_modules` is not debris for a directory janitor.
 * Their presence also disqualifies the parent (not file-free by contract).
 */
const EMPTY_DIR_SWEEP_SKIP_DIRS = new Set(['.git', 'node_modules']);

/**
 * File-free mission-directory debris sweep.
 *
 * Mission creation can leave behind directories that never received a ledger
 * (`mission-state.json`): abandoned creates, interrupted template expansion,
 * scope containers whose missions all closed. A directory tree holding no
 * real file cannot contain mission state, so removing it can never lose a
 * ledger. Tier roots (depth 1 below `active/missions/`) are always kept —
 * a dir is a removal candidate only at depth >= 2 and only when its whole
 * subtree is file-free (OS debris files like `.DS_Store` are removed with it;
 * any symlink anywhere in the subtree disqualifies the dir).
 *
 * Detection needs only read access, but `active/missions/` writes are gated
 * to the `mission_controller` authority role — the governed entry point for
 * removal is `pnpm mission sweep-empty-dirs --execute` (dry-run without
 * `--execute`). `runJanitor` therefore runs this sweep detection-only and
 * reports candidates; it never attempts the delete itself.
 */
export function sweepEmptyMissionDirs(opts: { dryRun: boolean }): SweepEmptyMissionDirsResult {
  const missionsRoot = nodePath.join(rootDir(), ...MISSIONS_ROOT_REPO_PATH.split('/'));
  const result: SweepEmptyMissionDirsResult = { candidates: [], removed: [], errors: [] };
  if (!safeExistsSync(missionsRoot)) return result;

  const visit = (dirPath: string, depth: number): { clean: boolean; debris: string[] } => {
    let entries: string[];
    try {
      entries = safeReaddir(dirPath);
    } catch {
      return { clean: true, debris: [] };
    }
    let clean = true;
    const debris: string[] = [];
    for (const name of entries) {
      const child = nodePath.join(dirPath, name);
      let stat;
      try {
        stat = safeLstat(child);
      } catch {
        clean = false;
        continue;
      }
      if (stat.isSymbolicLink()) {
        clean = false;
        continue;
      }
      if (stat.isDirectory()) {
        if (EMPTY_DIR_SWEEP_SKIP_DIRS.has(name)) {
          clean = false;
          continue;
        }
        const sub = visit(child, depth + 1);
        if (!sub.clean) clean = false;
        else debris.push(...sub.debris);
        continue;
      }
      if (EMPTY_DIR_DEBRIS_FILES.has(name)) debris.push(child);
      else clean = false;
    }
    if (!clean) return { clean: false, debris: [] };
    if (depth >= 2) {
      const repoRel = repoRelativePosix(dirPath);
      result.candidates.push(repoRel);
      if (!opts.dryRun) {
        try {
          for (const debrisFile of debris) {
            if (safeExistsSync(debrisFile)) safeUnlinkSync(debrisFile);
          }
          safeRmdirSync(dirPath);
          result.removed.push(repoRel);
        } catch (err: unknown) {
          result.errors.push(`${repoRel}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return { clean: true, debris };
  };

  visit(missionsRoot, 0);
  return result;
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

  let tmpResult: ScanTmpResult = { expired: [], deleted: [], softDeleted: [], archived: [] };
  try {
    tmpResult = scanTmp({ dryRun: opts.dryRun, catalog });
  } catch (err: any) {
    errors.push(`tmp: ${err?.message ?? String(err)}`);
  }

  let logResult: RotateLogsResult = { expired: [], rotated: [], softDeleted: [], archived: [] };
  try {
    logResult = rotateLogs({ dryRun: opts.dryRun, catalog });
    for (const failure of logResult.errors ?? []) errors.push(`logs: ${failure}`);
  } catch (err: any) {
    errors.push(`logs: ${err?.message ?? String(err)}`);
  }

  let vaultResult: ScanDataVaultResult = { expired: [], deleted: [] };
  try {
    vaultResult = scanDataVault({ dryRun: opts.dryRun });
  } catch (err: any) {
    errors.push(`data-vault: ${err?.message ?? String(err)}`);
  }

  let runtimeResult: ScanRuntimeResult = {
    expired: [],
    deleted: [],
    softDeleted: [],
    archived: [],
  };
  try {
    runtimeResult = scanRuntime({ dryRun: opts.dryRun, catalog });
  } catch (err: any) {
    errors.push(`runtime: ${err?.message ?? String(err)}`);
  }

  let eventStoreResult: ScanRuntimeResult = {
    expired: [],
    deleted: [],
    softDeleted: [],
    archived: [],
  };
  try {
    eventStoreResult = scanEventStores({ dryRun: opts.dryRun, catalog });
  } catch (err: any) {
    errors.push(`event-stores: ${err?.message ?? String(err)}`);
  }

  let storageFloorResult: ScanRuntimeResult = {
    expired: [],
    deleted: [],
    softDeleted: [],
    archived: [],
  };
  try {
    storageFloorResult = scanStorageFloors({ dryRun: opts.dryRun, catalog });
  } catch (err: any) {
    errors.push(`storage-floors: ${err?.message ?? String(err)}`);
  }

  let supervisorEventsResult: ScanRuntimeResult = {
    expired: [],
    deleted: [],
    softDeleted: [],
    archived: [],
  };
  try {
    supervisorEventsResult = sweepSupervisorEventFiles({ dryRun: opts.dryRun, catalog });
  } catch (err: any) {
    errors.push(`supervisor-events: ${err?.message ?? String(err)}`);
  }

  let statusRulesResult: ScanRuntimeResult = {
    expired: [],
    deleted: [],
    softDeleted: [],
    archived: [],
  };
  try {
    statusRulesResult = sweepStatusRules({ dryRun: opts.dryRun, catalog });
  } catch (err: any) {
    errors.push(`status-rules: ${err?.message ?? String(err)}`);
  }

  let appendOnlyResult: SweepAppendOnlyStoresResult = {
    rotated: [],
    compacted: [],
    segmentsExpired: [],
    segmentsDeleted: [],
    segmentsArchived: [],
    errors: [],
  };
  try {
    appendOnlyResult = sweepAppendOnlyStores({ dryRun: opts.dryRun, catalog });
    errors.push(...appendOnlyResult.errors.map((error) => `append-only-stores: ${error}`));
  } catch (err: any) {
    errors.push(`append-only-stores: ${err?.message ?? String(err)}`);
  }

  let trashResult: SweepTrashResult = { expired: [], purged: [] };
  try {
    trashResult = sweepTrash({ dryRun: opts.dryRun, catalog });
  } catch (err: any) {
    errors.push(`trash: ${err?.message ?? String(err)}`);
  }

  let uncoveredRuntimeDirs: string[] = [];
  let uncoveredRuntimeFiles: string[] = [];
  try {
    uncoveredRuntimeDirs = listUncoveredRuntimeDirs(catalog);
    uncoveredRuntimeFiles = listUncoveredRuntimeFiles(catalog);
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

  let workspacesResult: SweepWorkspacesResult = {
    registered: 0,
    orphaned: [],
    deleted: [],
    unregisteredDirs: [],
    unresolvedOwners: [],
    errors: [],
  };
  try {
    workspacesResult = sweepWorkspaces({ dryRun: opts.dryRun });
    errors.push(...workspacesResult.errors.map((error) => `workspaces: ${error}`));
  } catch (err: unknown) {
    errors.push(`workspaces: ${err instanceof Error ? err.message : String(err)}`);
  }

  let emptyMissionDirsResult: SweepEmptyMissionDirsResult = {
    candidates: [],
    removed: [],
    errors: [],
  };
  try {
    // Detection-only: `active/missions/` writes belong to the
    // mission_controller role, so the janitor reports candidates rather than
    // attempting deletes it cannot authorize (removal runs through
    // `pnpm mission sweep-empty-dirs --execute`).
    emptyMissionDirsResult = sweepEmptyMissionDirs({ dryRun: true });
    errors.push(...emptyMissionDirsResult.errors.map((error) => `mission-dirs: ${error}`));
  } catch (err: unknown) {
    errors.push(`mission-dirs: ${err instanceof Error ? err.message : String(err)}`);
  }

  let ownershipCompaction: ArtifactOwnershipCompaction = {
    total_rows: 0,
    kept_rows: 0,
    removed_rows: 0,
    applied: false,
  };
  try {
    ownershipCompaction = compactArtifactOwnershipRegistry({ dryRun: opts.dryRun });
  } catch (err: unknown) {
    errors.push(`artifact-ownership: ${err instanceof Error ? err.message : String(err)}`);
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
    expiredStorageFloors: storageFloorResult.expired.length,
    deletedStorageFloors: storageFloorResult.deleted.length,
    expiredSupervisorEvents: supervisorEventsResult.expired.length,
    deletedSupervisorEvents: supervisorEventsResult.deleted.length,
    expiredStatusRules: statusRulesResult.expired.length,
    deletedStatusRules: statusRulesResult.deleted.length,
    appendOnlyStores: {
      rotated: appendOnlyResult.rotated.map(repoRelativePosix),
      compacted: appendOnlyResult.compacted.map(repoRelativePosix),
      segmentsExpired: appendOnlyResult.segmentsExpired.map(repoRelativePosix),
      segmentsArchived: appendOnlyResult.segmentsArchived.map(repoRelativePosix),
    },
    archived:
      tmpResult.archived.length +
      logResult.archived.length +
      runtimeResult.archived.length +
      eventStoreResult.archived.length +
      storageFloorResult.archived.length +
      supervisorEventsResult.archived.length +
      statusRulesResult.archived.length +
      appendOnlyResult.segmentsArchived.length,
    staleDelegationChildren: delegationChildrenResult.stale.length,
    killedDelegationChildren: delegationChildrenResult.killed.length,
    supersededArtifactOwnershipRows: ownershipCompaction.removed_rows,
    compactedArtifactOwnershipRows: ownershipCompaction.applied
      ? ownershipCompaction.removed_rows
      : 0,
    workspaces: {
      registered: workspacesResult.registered,
      orphaned: workspacesResult.orphaned.length,
      deleted: workspacesResult.deleted.length,
      unregisteredDirs: workspacesResult.unregisteredDirs,
    },
    emptyMissionDirs: {
      candidates: emptyMissionDirsResult.candidates,
      removed: emptyMissionDirsResult.removed,
    },
    uncoveredRuntimeDirs,
    uncoveredRuntimeFiles,
    uncoveredEventStoreDirs,
    reviewRequiredDirs,
    softDeleted:
      tmpResult.softDeleted.length +
      logResult.softDeleted.length +
      runtimeResult.softDeleted.length +
      eventStoreResult.softDeleted.length +
      storageFloorResult.softDeleted.length +
      supervisorEventsResult.softDeleted.length +
      statusRulesResult.softDeleted.length,
    expiredTrash: trashResult.expired.length,
    purgedTrash: trashResult.purged.length,
    retentionCatalogSource: catalog.source,
    retentionCatalogWarnings: catalog.warnings,
    errors,
    timestamp: nowIso(),
    dryRun: opts.dryRun,
  };

  if (!opts.dryRun) {
    try {
      const markerPath = shared(JANITOR_MARKER_SUBPATH);
      const marker = janitorLastRunCatalog(markerPath).validate(
        { completed_at: report.timestamp, errors: errors.length },
        markerPath
      );
      safeWriteFile(markerPath, JSON.stringify(marker, null, 2));
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
const JANITOR_SUBMIT_MARKER_SUBPATH = 'runtime/state/janitor-last-submit.json';
const JANITOR_LAST_RUN_SCHEMA_PATH = knowledge(
  'product/schemas/janitor-last-run-marker.schema.json'
);
const JANITOR_SUBMISSION_SCHEMA_PATH = knowledge(
  'product/schemas/janitor-submission-marker.schema.json'
);

type JanitorLastRunMarker = { completed_at: string; errors: number };
type JanitorSubmissionMarker = {
  submitted_at: string;
  pipeline_id: 'storage-janitor';
  dry_run: false;
};

function janitorLastRunCatalog(filePath: string) {
  return defineCatalog<JanitorLastRunMarker>({
    id: 'janitor-last-run-marker',
    path: filePath,
    schema: JANITOR_LAST_RUN_SCHEMA_PATH,
  });
}

function janitorSubmissionCatalog(filePath: string) {
  return defineCatalog<JanitorSubmissionMarker>({
    id: 'janitor-submission-marker',
    path: filePath,
    schema: JANITOR_SUBMISSION_SCHEMA_PATH,
  });
}

export function readJanitorLastRunMs(): number | null {
  const markerPath = shared(JANITOR_MARKER_SUBPATH);
  if (!safeExistsSync(markerPath)) return null;
  try {
    if (!safeLstat(markerPath).isFile()) return null;
    const parsed = janitorLastRunCatalog(markerPath).load();
    const ts = Date.parse(parsed.completed_at);
    return Number.isFinite(ts) ? ts : null;
  } catch {
    return null;
  }
}

export function readJanitorLastSubmissionMs(): number | null {
  const markerPath = shared(JANITOR_SUBMIT_MARKER_SUBPATH);
  if (!safeExistsSync(markerPath)) return null;
  try {
    if (!safeLstat(markerPath).isFile()) return null;
    const parsed = janitorSubmissionCatalog(markerPath).load();
    const ts = Date.parse(parsed.submitted_at);
    return Number.isFinite(ts) ? ts : null;
  } catch {
    return null;
  }
}

export function writeJanitorSubmissionMarker(): void {
  const markerPath = shared(JANITOR_SUBMIT_MARKER_SUBPATH);
  const marker = janitorSubmissionCatalog(markerPath).validate(
    { submitted_at: nowIso(), pipeline_id: 'storage-janitor', dry_run: false },
    markerPath
  );
  safeWriteFile(markerPath, JSON.stringify(marker, null, 2));
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
