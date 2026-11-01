/**
 * MSN-STORE-BOUNDS-3: find and recover leftover `.compacting-*` copies.
 *
 * A parked rewrite (`append-only-store.ts` `rewriteParked`) keeps its parked
 * copies when they are the only full-fidelity record of the store — and
 * nothing removes them later. Parked-aware readers then re-read every copy
 * on each call and agent-input-queue compaction stays skipped. ops-health
 * (`probeStaleCompactionCopies`) flags copies older than
 * {@link STALE_COMPACTION_COPY_MS}; `pnpm kyberion storage
 * recover-compaction-copies` plans and (with an approval) applies the merge
 * implemented here.
 *
 * The merge runs under the store's write-time maintenance lock
 * (`appendOnlyStoreLockId`, also taken by the storage janitor's compaction
 * and rotation) and, for a store whose writer rewrites it under its own
 * compaction lock ({@link WRITER_COMPACTION_LOCKS}), under that lock too —
 * so no other rewrite interleaves with the merge. It refuses any store with a
 * copy younger than the stale threshold (it may belong to a rewrite still
 * running), and only touches the exact copy set the operator approved.
 */
import * as nodePath from 'node:path';
import { withLockSync } from './foundation/lock-utils.js';
import {
  appendOnlyStoreLockId,
  mergeCompactionCopies,
  type StoreScanOptions,
} from './append-only-store.js';
import { parkedCompactionCopies } from './jsonl-parked-read.js';
import { jsonlFileSize } from './jsonl-read.js';
import { runtimeStatePath } from './foundation/runtime-state-roots.js';
import { createLogger } from './logger.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeReaddir } from './secure-io.js';
import { RETENTION_CATALOG_REPO_PATH } from './storage-retention-catalog.js';
import { appendRetentionAudit } from './storage-retention-expiry.js';

const logger = createLogger('compaction-copy-recovery');

/** A `.compacting-*` copy older than this is left over from a failed rewrite. */
export const STALE_COMPACTION_COPY_MS = 60 * 60 * 1000;
/** Trees that hold append-only stores with write-time maintenance. */
export const COMPACTION_COPY_ROOTS = [
  'active/shared/runtime',
  'active/shared/observability',
  'active/missions',
] as const;
/** Infix of a parked copy's name: `<store>.compacting-<stamp>`. */
export const COMPACTION_COPY_MARKER = '.compacting-';
/** Operator command that recovers leftover copies (named by the ops-health finding). */
export const RECOVER_COMPACTION_COPIES_COMMAND = 'pnpm kyberion storage recover-compaction-copies';

/**
 * Stores (repo-relative) whose writer rewrites them under a lock of its own
 * rather than `appendOnlyStoreLockId`: the recovery merge takes that lock as
 * well (outer), so it never interleaves with the writer's compaction — an
 * interleaving could order older rows after newer ones. The dot wake ledger
 * is compacted under `dot-wake-ledger-compact`
 * (dot/dot-wake-ledger-compaction.ts DOT_LEDGER_COMPACT_LOCK).
 */
export const WRITER_COMPACTION_LOCKS: Readonly<Record<string, string>> = {
  [runtimeStatePath('dot.wakeLedger').logicalPath]: 'dot-wake-ledger-compact',
};

const COMPACTION_COPY_MAX_DEPTH = 6;
const COMPACTION_COPY_MAX_ENTRIES = 20_000;

export interface CompactionCopyLocation {
  /** Repository root (default: the project root; tests inject a fixture root). */
  rootDir?: string;
  /** Trees to search, repo-relative (default {@link COMPACTION_COPY_ROOTS}). */
  roots?: readonly string[];
}

export interface CompactionCopyEntry {
  /** Repo-relative POSIX path of the copy. */
  path: string;
  sizeBytes: number;
  mtimeMs: number;
}

function rootOf(location: CompactionCopyLocation): string {
  return location.rootDir ?? pathResolver.rootDir();
}

function repoFile(rootDir: string, rel: string): string {
  return assertSafeRepositoryPath(nodePath.join(rootDir, rel), { allowMissingLeaf: true });
}

function toRel(rootDir: string, absolute: string): string {
  return nodePath.relative(rootDir, absolute).split(nodePath.sep).join('/');
}

/** Every `.compacting-*` regular file under the roots (bounded walk, sorted). */
export function listCompactionCopies(location: CompactionCopyLocation = {}): CompactionCopyEntry[] {
  const rootDir = rootOf(location);
  const copies: CompactionCopyEntry[] = [];
  let visited = 0;
  const walk = (rel: string, depth: number): void => {
    let names: string[];
    try {
      names = safeReaddir(repoFile(rootDir, rel));
    } catch (error) {
      logger.debug(`skipped ${rel}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    for (const name of names.sort()) {
      if (visited++ >= COMPACTION_COPY_MAX_ENTRIES) return;
      const child = `${rel}/${name}`;
      try {
        const stat = safeLstat(repoFile(rootDir, child));
        if (stat.isDirectory()) {
          if (depth < COMPACTION_COPY_MAX_DEPTH) walk(child, depth + 1);
        } else if (stat.isFile() && name.includes(COMPACTION_COPY_MARKER)) {
          copies.push({ path: child, sizeBytes: stat.size, mtimeMs: stat.mtimeMs });
        }
      } catch (error) {
        logger.debug(`skipped ${child}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
  for (const root of location.roots ?? COMPACTION_COPY_ROOTS) walk(root, 1);
  return copies;
}

/** The live store a copy belongs to (`<store>.compacting-…` → `<store>`). */
export function compactionCopyStore(copyPath: string): string {
  const at = copyPath.lastIndexOf(COMPACTION_COPY_MARKER);
  return at === -1 ? copyPath : copyPath.slice(0, at);
}

export interface CompactionCopyPlanCopy {
  /** Repo-relative path. */
  path: string;
  size_bytes: number;
  mtime: string;
  age_ms: number;
  /** Older than {@link STALE_COMPACTION_COPY_MS}. */
  stale: boolean;
}

export interface CompactionCopyStorePlan {
  /** Repo-relative path of the live store. */
  store: string;
  live_bytes: number;
  /** Park order — the order the merge streams them in, before the live file. */
  copies: CompactionCopyPlanCopy[];
  action: 'merge' | 'refuse';
  /** What `--apply` would do, or why it refuses. */
  detail: string;
}

export interface PlanCompactionCopyRecoveryOptions extends CompactionCopyLocation {
  /** Only this store (repo-relative or absolute `.jsonl` under the roots). */
  storePath?: string;
  now?: Date;
}

/**
 * Resolve `--path`: a `.jsonl` store under one of the roots. Anything else is
 * refused, so an approval can never be pointed at an arbitrary file.
 */
export function resolveRecoveryStorePath(
  storePath: string,
  location: CompactionCopyLocation = {}
): string {
  const rootDir = rootOf(location);
  const absolute = nodePath.resolve(rootDir, storePath);
  const rel = toRel(rootDir, absolute);
  const roots = location.roots ?? COMPACTION_COPY_ROOTS;
  if (
    !rel.endsWith('.jsonl') ||
    rel.startsWith('..') ||
    rel.includes(COMPACTION_COPY_MARKER) ||
    !roots.some((root) => rel.startsWith(`${root}/`))
  ) {
    throw new Error(
      `[COMPACTION_COPY_RECOVERY] --path must be a .jsonl store under ${roots.join(', ')} — refused: ${storePath}`
    );
  }
  return repoFile(rootDir, rel);
}

function planStore(rootDir: string, storeAbs: string, nowMs: number): CompactionCopyStorePlan {
  const copies = parkedCompactionCopies(storeAbs).flatMap((copyAbs): CompactionCopyPlanCopy[] => {
    try {
      const stat = safeLstat(copyAbs);
      if (!stat.isFile()) return [];
      const age = nowMs - stat.mtimeMs;
      return [
        {
          path: toRel(rootDir, copyAbs),
          size_bytes: stat.size,
          mtime: new Date(stat.mtimeMs).toISOString(),
          age_ms: Math.max(0, Math.round(age)),
          stale: age > STALE_COMPACTION_COPY_MS,
        },
      ];
    } catch {
      return []; // removed after listing: its rewrite finished
    }
  });
  const store = toRel(rootDir, storeAbs);
  const young = copies.filter((copy) => !copy.stale);
  const live = safeExistsSync(storeAbs) ? jsonlFileSize(storeAbs) : 0;
  const detail =
    copies.length === 0
      ? 'no compaction copies'
      : young.length > 0
        ? `refused: ${young.length} copy(ies) younger than ${STALE_COMPACTION_COPY_MS / 60_000} minutes may belong to a rewrite still running — retry later`
        : `merge ${copies.length} copy(ies) (park order) then the live file into ${store} under its store lock, dropping lines byte-identical to one kept from an earlier file, then remove the copies`;
  return {
    store,
    live_bytes: live,
    copies,
    action: copies.length > 0 && young.length === 0 ? 'merge' : 'refuse',
    detail,
  };
}

/** Per-store recovery plan: every store with copies, or only `storePath`. */
export function planCompactionCopyRecovery(
  options: PlanCompactionCopyRecoveryOptions = {}
): CompactionCopyStorePlan[] {
  const rootDir = rootOf(options);
  const nowMs = (options.now ?? new Date()).getTime();
  const stores = options.storePath
    ? [resolveRecoveryStorePath(options.storePath, options)]
    : [...new Set(listCompactionCopies(options).map((copy) => compactionCopyStore(copy.path)))]
        .sort()
        .map((rel) => repoFile(rootDir, rel));
  return stores.map((storeAbs) => planStore(rootDir, storeAbs, nowMs));
}

export type CompactionCopyRecoveryOutcome = 'merged' | 'not_converged' | 'refused' | 'changed';

export interface CompactionCopyRecoveryResult {
  store: string;
  outcome: CompactionCopyRecoveryOutcome;
  /** Copies merged (and removed when `merged`). */
  copies: string[];
  detail: string;
  before_lines?: number;
  after_lines?: number;
  duplicates_dropped?: number;
  live_bytes_after?: number;
}

export interface RecoverCompactionCopiesOptions extends CompactionCopyLocation, StoreScanOptions {
  now?: Date;
  lockTimeoutMs?: number;
  /** Where the RETENTION_RECOVER record goes (default: the storage-retention audit log). */
  audit?: (record: Record<string, unknown>) => void;
}

/**
 * Merge `expectedCopies` (repo-relative, as planned and approved) back into
 * `store` under the store lock. Refuses (`changed`) when the store's copy set
 * differs from the expected one, and (`refused`) when a copy is younger than
 * the stale threshold. Writes a RETENTION_RECOVER audit record on a merge.
 */
export function recoverCompactionCopies(
  store: string,
  expectedCopies: readonly string[],
  options: RecoverCompactionCopiesOptions = {}
): CompactionCopyRecoveryResult {
  const rootDir = rootOf(options);
  const storeAbs = resolveRecoveryStorePath(store, options);
  const storeRel = toRel(rootDir, storeAbs);
  const lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
  const writerLock = WRITER_COMPACTION_LOCKS[storeRel];
  const underStoreLock = (): CompactionCopyRecoveryResult =>
    withLockSync(
      appendOnlyStoreLockId(storeAbs),
      (): CompactionCopyRecoveryResult => {
        const plan = planStore(rootDir, storeAbs, (options.now ?? new Date()).getTime());
        const current = plan.copies.map((copy) => copy.path);
        const expected = [...expectedCopies].sort();
        if (current.length === 0 || [...current].sort().join('\n') !== expected.join('\n')) {
          return {
            store: storeRel,
            outcome: 'changed',
            copies: current,
            detail: `copy set changed since the plan (now ${current.length}, planned ${expected.length}) — re-run the dry-run and request a new approval`,
          };
        }
        if (plan.action !== 'merge') {
          return { store: storeRel, outcome: 'refused', copies: current, detail: plan.detail };
        }
        const copyAbs = current.map((rel) => repoFile(rootDir, rel));
        const result = mergeCompactionCopies(storeAbs, copyAbs, options);
        if (!result) {
          return {
            store: storeRel,
            outcome: 'changed',
            copies: current,
            detail: 'neither the store nor its copies exist any more',
          };
        }
        const outcome: CompactionCopyRecoveryOutcome = result.published
          ? 'merged'
          : 'not_converged';
        const liveAfter = safeExistsSync(storeAbs) ? jsonlFileSize(storeAbs) : 0;
        (options.audit ?? appendRetentionAudit)({
          event: 'RETENTION_RECOVER',
          path: storeRel,
          copies: current,
          copy_bytes: plan.copies.reduce((sum, copy) => sum + copy.size_bytes, 0),
          size_before_bytes: plan.live_bytes,
          size_after_bytes: liveAfter,
          before_lines: result.before,
          after_lines: result.after,
          duplicates_dropped: result.duplicatesDropped,
          published: result.published,
          policy_ref: RETENTION_CATALOG_REPO_PATH,
          reason: 'leftover compaction copies merged back into the live store (operator recovery)',
        });
        if (!result.published) {
          logger.warn(
            `compaction-copy recovery did not converge for ${storeRel} — writers out-paced the merge | next: re-run ${RECOVER_COMPACTION_COPIES_COMMAND} --path ${storeRel} when the store is quieter | evidence: copies kept: ${current.join(', ')}`
          );
        }
        return {
          store: storeRel,
          outcome,
          copies: current,
          detail: result.published
            ? `merged ${current.length} copy(ies) into the live store and removed them`
            : 'writers out-paced the merge; the copies were kept untouched',
          before_lines: result.before,
          after_lines: result.after,
          duplicates_dropped: result.duplicatesDropped,
          live_bytes_after: liveAfter,
        };
      },
      lockTimeoutMs
    );
  return writerLock ? withLockSync(writerLock, underStoreLock, lockTimeoutMs) : underStoreLock();
}
