/**
 * MSN-STORE-BOUNDS-20261101 (P2/P3): one shared, streaming implementation of
 * append-only JSONL store maintenance — rotate, compact-by-key and time
 * window — used inline by writers (`maintainStoreAfterAppend`) and by the
 * storage janitor (`sweepAppendOnlyStores`).
 *
 * Nothing here reads a store whole: every pass streams through
 * `jsonl-read.ts`, so a store of any size (including one past the 100MB
 * whole-file read cap) stays maintainable.
 *
 * Rewrites (compact / window) keep the janitor's race-safe park/stage
 * protocol against concurrent appenders:
 *
 *  1. The live file is atomically moved aside to a `.compacting-<pid>-<n>-<tag>`
 *     staging sibling — appends already in flight land on the moved inode,
 *     appends after the move create a fresh live file.
 *  2. The surviving lines are written to a temp sibling and published with an
 *     exclusive hard link (`safeLinkExclusiveSync`) — EEXIST means a writer
 *     recreated the live file in the gap, so it is parked too, merged, and the
 *     publish is retried (at most {@link COMPACT_MAX_PARK_ATTEMPTS} rounds).
 *  3. If the merge loop does not converge, the raw union of every parked file
 *     is restored uncompressed — nothing is ever dropped.
 *  4. Staging siblings are removed only once the live file holds the result
 *     and (for compaction) the raw union is archived. On any failure before
 *     that point the staging files are kept, so no record is lost.
 *
 * Residual risk (same as before): a writer holding a long-lived open fd could
 * append to a staging inode after its last read. The repo's appenders reopen
 * the path per record, so the window is nil in practice.
 */
import { createHash } from 'node:crypto';
import * as nodePath from 'node:path';
import { logger } from './core.js';
import { withLockSync } from './foundation/lock-utils.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import {
  DEFAULT_JSONL_CHUNK_BYTES,
  jsonlFileSize,
  streamTextLines,
  type JsonlOversizedLine,
} from './jsonl-read.js';
import { getFoundationIo } from './foundation/io.js';
import { rootDir } from './path-resolver.js';
import {
  safeAppendFileSync,
  safeExistsSync,
  safeLinkExclusiveSync,
  safeMkdir,
  safeMoveSync,
  safeUnlinkSync,
} from './secure-io.js';
import {
  loadRetentionCatalog,
  retentionEntryForExactPath,
  RETENTION_CATALOG_REPO_PATH,
  type LoadedRetentionCatalog,
} from './storage-retention-catalog.js';
import {
  appendRetentionAudit,
  COMPACTION_ARCHIVE_REPO_SUBPATH,
  DEFAULT_COMPACT_MIN_BYTES,
  DEFAULT_ROTATE_MIN_BYTES,
  repoRelativePosix,
} from './storage-retention-expiry.js';

/** Merge rounds before a rewrite gives up and restores the raw union. */
export const COMPACT_MAX_PARK_ATTEMPTS = 5;

/** Output is flushed to disk in batches of about this many bytes. */
const WRITE_BATCH_BYTES = DEFAULT_JSONL_CHUNK_BYTES;

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

/**
 * `<stem>-YYYYMMDD-HHmmss.jsonl` sibling for a rotated live file.
 * Second-granularity stamps can collide when a busy log rotates twice in one
 * second (or a retry follows a partial failure); disambiguate with `-<n>`.
 */
export function rotatedSegmentPath(liveFilePath: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  for (let i = 0; ; i++) {
    const candidate = liveFilePath.replace(/\.jsonl$/, `-${stamp}${i > 0 ? `-${i}` : ''}.jsonl`);
    if (!safeExistsSync(candidate)) return candidate;
  }
}

/** Basename stem rotated segments of `liveFilePath` start with (`<stem>-`). */
export function rotatedSegmentStem(liveFilePath: string): string {
  return nodePath.basename(liveFilePath).replace(/\.jsonl$/, '');
}

/**
 * Rename the live file to a rotated segment. Writers reopen the canonical
 * path per append, so appends continue on a fresh file. Returns the segment
 * path, or null when the live file is missing or empty.
 */
export function rotateStore(filePath: string, options: { now?: Date } = {}): string | null {
  if (jsonlFileSize(filePath) === 0) return null;
  const segmentPath = rotatedSegmentPath(filePath, options.now ?? new Date());
  safeMoveSync(filePath, segmentPath);
  return segmentPath;
}

// ---------------------------------------------------------------------------
// Parked rewrite (shared by compaction and the time window)
// ---------------------------------------------------------------------------

export interface StoreRewriteResult {
  /** Non-blank lines across every parked copy (the raw union). */
  before: number;
  /** Lines in the live file after the rewrite (`before` when not converged). */
  after: number;
  /** False when writers out-paced the merge loop and the raw union was restored. */
  published: boolean;
  /** Live files recreated by writers during the rewrite and merged in. */
  merged: number;
  /** Raw-union archive written before staging cleanup, or null. */
  archivePath: string | null;
  /** Lines over the per-line guard: dropped from the live file, kept in the archive. */
  oversizedLines: number;
}

export interface StoreScanOptions {
  /** Range-read chunk size (tests inject small values). */
  chunkBytes?: number;
  /** Per-line guard (tests inject small values). */
  maxLineBytes?: number;
}

interface LineFilter {
  /** Pass 1, once per parked file as it is parked: `index` is global across files. */
  observe(text: string, index: number): void;
  /** Pass 2: whether the line survives. */
  keep(text: string, index: number): boolean;
}

class BatchedAppender {
  private pending: string[] = [];
  private pendingBytes = 0;
  constructor(private readonly filePath: string) {
    // Create (or truncate-free touch) the file so an empty result still exists.
    safeAppendFileSync(filePath, '');
  }
  write(text: string): void {
    this.pending.push(text);
    this.pendingBytes += text.length;
    if (this.pendingBytes >= WRITE_BATCH_BYTES) this.flush();
  }
  writeBuffer(buf: Buffer): void {
    this.flush();
    safeAppendFileSync(this.filePath, buf);
  }
  flush(): void {
    if (this.pending.length === 0) return;
    safeAppendFileSync(this.filePath, this.pending.join(''));
    this.pending = [];
    this.pendingBytes = 0;
  }
}

function uniqueSibling(base: string, suffix: string): string {
  for (let i = 0; ; i++) {
    const candidate = `${base}${i > 0 ? `-${i}` : ''}${suffix}`;
    if (!safeExistsSync(candidate)) return candidate;
  }
}

function isErrno(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === code;
}

function tryUnlink(filePath: string): void {
  try {
    if (safeExistsSync(filePath)) safeUnlinkSync(filePath);
  } catch {
    // best-effort cleanup
  }
}

/** Byte-verbatim copy of `src` onto `out`, newline-terminated. */
function copyBytes(src: string, out: BatchedAppender, chunkBytes: number): void {
  const size = jsonlFileSize(src);
  const io = getFoundationIo();
  if (!io.readRange) throw new Error('secure_foundation_range_io_not_registered');
  let lastByte = 0x0a;
  for (let position = 0; position < size;) {
    const buf = io.readRange(src, position, Math.min(chunkBytes, size - position));
    if (buf.length === 0) break;
    out.writeBuffer(buf);
    lastByte = buf[buf.length - 1]!;
    position += buf.length;
  }
  if (lastByte !== 0x0a) out.write('\n');
}

function rewriteParked(
  livePath: string,
  filter: LineFilter,
  options: StoreScanOptions & { archivePath?: string | null; label: string }
): StoreRewriteResult | null {
  if (!safeExistsSync(livePath)) return null;
  const chunkBytes = options.chunkBytes ?? DEFAULT_JSONL_CHUNK_BYTES;
  const scan = { chunkBytes, maxLineBytes: options.maxLineBytes };
  const stagingPaths: string[] = [];
  let total = 0;
  let merged = 0;
  let oversizedLines = 0;
  let liveRestored = false;
  const countOversized = (_line: JsonlOversizedLine): void => {
    oversizedLines++;
  };

  const park = (tag: string): boolean => {
    const staging = `${livePath}.compacting-${process.pid}-${stagingPaths.length}-${tag}`;
    try {
      safeMoveSync(livePath, staging);
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return false; // another maintainer took it
      throw err;
    }
    stagingPaths.push(staging);
    for (const line of streamTextLines(staging, { ...scan, onOversized: countOversized })) {
      if (!line.text.trim()) continue;
      filter.observe(line.text, total++);
    }
    return true;
  };

  const writeSurvivors = (dest: string): number => {
    const out = new BatchedAppender(dest);
    let index = 0;
    let kept = 0;
    for (const staging of stagingPaths) {
      for (const line of streamTextLines(staging, scan)) {
        if (!line.text.trim()) continue;
        if (filter.keep(line.text, index++)) {
          out.write(`${line.text}\n`);
          kept++;
        }
      }
    }
    out.flush();
    return kept;
  };

  const writeUnion = (dest: string): void => {
    const out = new BatchedAppender(dest);
    for (const staging of stagingPaths) copyBytes(staging, out, chunkBytes);
    out.flush();
  };

  const restoreRawUnion = (): void => {
    // Park any live file that reappeared so its records are not lost.
    if (safeExistsSync(livePath) && park('restore-merge')) merged++;
    const temp = uniqueSibling(`${livePath}.compact-restore-${process.pid}`, '.tmp');
    try {
      writeUnion(temp);
      safeMoveSync(temp, livePath);
    } finally {
      tryUnlink(temp);
    }
    liveRestored = true;
  };

  let published = false;
  let kept = 0;
  let archivePath: string | null = null;
  try {
    if (!park('initial')) return null;
    for (let i = 0; i <= COMPACT_MAX_PARK_ATTEMPTS; i++) {
      if (!safeExistsSync(livePath)) {
        const temp = uniqueSibling(`${livePath}.compact-out-${process.pid}-${i}`, '.tmp');
        try {
          kept = writeSurvivors(temp);
          safeLinkExclusiveSync(temp, livePath);
          published = true;
          liveRestored = true;
        } catch (err) {
          // EEXIST: a writer recreated the live file — merge it below.
          if (!isErrno(err, 'EEXIST')) throw err;
        } finally {
          tryUnlink(temp);
        }
        if (published) break;
      }
      if (i >= COMPACT_MAX_PARK_ATTEMPTS) break;
      if (park(`merge-${i}`)) merged++;
    }

    if (!published) {
      restoreRawUnion();
      logger.warn(
        `[append-only-store] ${options.label} did not converge for ${livePath} — writers out-paced ${COMPACT_MAX_PARK_ATTEMPTS} merge rounds | next: raw records restored uncompressed; the next maintenance pass retries | evidence: ${stagingPaths.length} parked copies`
      );
    }
    if (oversizedLines > 0) {
      logger.warn(
        `[append-only-store] ${oversizedLines} oversized line(s) dropped from ${livePath} during ${options.label} — a line exceeded the per-line guard | next: inspect the writer | evidence: ${options.archivePath ? `raw union archived at ${options.archivePath}` : 'no archive requested'}`
      );
    }

    if (options.archivePath) {
      safeMkdir(nodePath.dirname(options.archivePath), { recursive: true });
      const target = uniqueSibling(options.archivePath.replace(/\.jsonl$/, ''), '.jsonl');
      writeUnion(target);
      archivePath = target;
    }
  } catch (err) {
    if (!liveRestored && stagingPaths.length > 0) {
      try {
        restoreRawUnion();
      } catch (restoreErr) {
        logger.warn(
          `[append-only-store] ${options.label} failed and the raw union could not be restored for ${livePath} — ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)} | next: recover records from the staging files by hand | evidence: ${stagingPaths.join(', ')}`
        );
      }
    }
    if (!liveRestored || (options.archivePath && !archivePath)) {
      // Keep the staging copies: they are the only full-fidelity record.
      stagingPaths.length = 0;
    }
    throw err;
  } finally {
    for (const staging of stagingPaths) tryUnlink(staging);
  }

  return {
    before: total,
    after: published ? kept : total,
    published,
    merged,
    archivePath,
    oversizedLines,
  };
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

function recordKey(text: string, keyField: string): string | undefined {
  let value: unknown;
  try {
    value = parseSafeJsonInput(text, 'JSONL entry');
  } catch {
    return undefined; // malformed lines are kept verbatim like keyless records
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const key = (value as Record<string, unknown>)[keyField];
  return typeof key === 'string' || typeof key === 'number' ? String(key) : undefined;
}

/**
 * Streaming count of non-blank records and distinct keys — the janitor's
 * "anything to fold?" check (`distinctKeys === records` means nothing to do).
 */
export function analyzeStoreKeys(
  filePath: string,
  key: string,
  options: StoreScanOptions = {}
): { records: number; distinctKeys: number } {
  const keys = new Set<string>();
  let records = 0;
  for (const line of streamTextLines(filePath, options)) {
    if (!line.text.trim()) continue;
    records++;
    const k = recordKey(line.text, key);
    if (k !== undefined) keys.add(k);
  }
  return { records, distinctKeys: keys.size };
}

/** Default archive directory for a store: `active/archive/jsonl-compaction/<repo-rel dir>`. */
export function defaultCompactionArchiveDir(filePath: string): string {
  return nodePath.join(
    rootDir(),
    COMPACTION_ARCHIVE_REPO_SUBPATH,
    nodePath.dirname(repoRelativePosix(filePath))
  );
}

export interface CompactStoreOptions extends StoreScanOptions {
  /** Record field identifying the keyed entity. */
  key: string;
  /** Where the raw-union archive lands. Default {@link defaultCompactionArchiveDir}. */
  archiveDir?: string;
  now?: Date;
}

/**
 * Fold the store to the last record per `key` (order of last appearance;
 * records lacking the key, and unparseable lines, are kept verbatim). Two
 * streaming passes: pass 1 records the last line index per key, pass 2
 * writes the survivors to a temp file that is published exclusively. The raw
 * union is archived to `<archiveDir>/<stem>.<stamp>Z-<pid>.jsonl`. Returns
 * null when the live file does not exist.
 */
export function compactStoreByKey(
  filePath: string,
  options: CompactStoreOptions
): StoreRewriteResult | null {
  const lastIndex = new Map<string, number>();
  const now = options.now ?? new Date();
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  const archiveDir = options.archiveDir ?? defaultCompactionArchiveDir(filePath);
  const archivePath = nodePath.join(
    archiveDir,
    `${rotatedSegmentStem(filePath)}.${stamp}Z-${process.pid}.jsonl`
  );
  return rewriteParked(
    filePath,
    {
      observe(text, index) {
        const k = recordKey(text, options.key);
        if (k !== undefined) lastIndex.set(k, index);
      },
      keep(text, index) {
        const k = recordKey(text, options.key);
        return k === undefined || lastIndex.get(k) === index;
      },
    },
    { ...options, archivePath, label: 'compaction' }
  );
}

// ---------------------------------------------------------------------------
// Time window
// ---------------------------------------------------------------------------

export interface RetainWindowOptions<T = unknown> extends StoreScanOptions {
  /** Record time in epoch ms; undefined = unknown (the record is kept). */
  timeOf: (record: T) => number | undefined;
  /** Records older than this are dropped... */
  sinceMs: number;
  /** ...unless this says to keep them (e.g. in-flight claims). */
  keep?: (record: T) => boolean;
  /** Optional raw-union archive (default: none — the window is lossy by design). */
  archivePath?: string;
}

/**
 * Drop records older than `sinceMs` (unless `keep` says otherwise) with the
 * same race-safe parked rewrite as compaction. Unparseable lines are kept
 * verbatim. Returns null when the live file does not exist.
 */
export function retainWindow<T = unknown>(
  filePath: string,
  options: RetainWindowOptions<T>
): StoreRewriteResult | null {
  return rewriteParked(
    filePath,
    {
      observe() {},
      keep(text) {
        let record: T;
        try {
          record = parseSafeJsonInput(text, 'JSONL entry') as T;
        } catch {
          return true;
        }
        const t = options.timeOf(record);
        if (t === undefined || t >= options.sinceMs) return true;
        return options.keep?.(record) ?? false;
      },
    },
    { ...options, archivePath: options.archivePath ?? null, label: 'window retention' }
  );
}

// ---------------------------------------------------------------------------
// Write-time maintenance
// ---------------------------------------------------------------------------

export type AppendOnlyStorePolicy =
  | { action: 'rotate'; minBytes?: number }
  | { action: 'compact'; key: string; minBytes?: number; archiveDir?: string }
  | {
      /** Explicit-policy only: the retention catalog has no `window` action. */
      action: 'window';
      minBytes: number;
      windowMs: number;
      timeOf: (record: unknown) => number | undefined;
      keep?: (record: unknown) => boolean;
    };

export interface MaintainStoreOptions extends StoreScanOptions {
  /**
   * Inter-process lock id guarding the store. Default: a per-path
   * `append-only-store-<hash>` id. Pass `null` when the caller already holds
   * the store's lock (calling under the same id would wait on itself).
   */
  lockId?: string | null;
  lockTimeoutMs?: number;
  now?: Date;
  /** Catalog override for `'catalog'` policy resolution (tests). */
  catalog?: LoadedRetentionCatalog;
}

export type MaintainStoreOutcome =
  | 'below-threshold'
  | 'no-policy'
  | 'rotated'
  | 'compacted'
  | 'windowed'
  | 'nothing-to-do'
  | 'failed';

const CATALOG_CACHE_TTL_MS = 60_000;
let catalogCache: { loadedAt: number; catalog: LoadedRetentionCatalog } | undefined;
/** Size after the last maintenance per store — re-run only after the store doubles. */
const lastMaintainedSize = new Map<string, number>();
const warnedNoPolicy = new Set<string>();

/** Test seam: forget cached catalog and per-store hysteresis. */
export function resetAppendOnlyStoreMaintenanceState(): void {
  catalogCache = undefined;
  lastMaintainedSize.clear();
  warnedNoPolicy.clear();
}

function cachedCatalog(): LoadedRetentionCatalog {
  const nowMs = Date.now();
  if (!catalogCache || nowMs - catalogCache.loadedAt > CATALOG_CACHE_TTL_MS) {
    catalogCache = { loadedAt: nowMs, catalog: loadRetentionCatalog() };
  }
  return catalogCache.catalog;
}

/** Resolve a store's policy from its exact-path `rotate` / `compact` catalog entry. */
export function resolveAppendOnlyStorePolicy(
  filePath: string,
  catalog: LoadedRetentionCatalog = cachedCatalog()
): AppendOnlyStorePolicy | null {
  const entry = retentionEntryForExactPath(catalog, repoRelativePosix(filePath));
  if (!entry) return null;
  if (entry.action === 'rotate') return { action: 'rotate', minBytes: entry.rotate_min_bytes };
  if (entry.action === 'compact' && entry.compact_key) {
    return { action: 'compact', key: entry.compact_key, minBytes: entry.compact_min_bytes };
  }
  return null;
}

function policyThreshold(policy: AppendOnlyStorePolicy): number {
  if (policy.action === 'rotate') return policy.minBytes ?? DEFAULT_ROTATE_MIN_BYTES;
  if (policy.action === 'compact') return policy.minBytes ?? DEFAULT_COMPACT_MIN_BYTES;
  return policy.minBytes;
}

function defaultLockId(filePath: string): string {
  return `append-only-store-${createHash('sha256')
    .update(nodePath.resolve(filePath))
    .digest('hex')
    .slice(0, 32)}`;
}

function runPolicy(
  filePath: string,
  policy: AppendOnlyStorePolicy,
  threshold: number,
  options: MaintainStoreOptions
): MaintainStoreOutcome {
  // Re-check under the lock: another process may have just maintained it.
  const size = jsonlFileSize(filePath);
  if (size < threshold) return 'below-threshold';
  const now = options.now ?? new Date();
  const base = {
    path: repoRelativePosix(filePath),
    size_before_bytes: size,
    policy_ref: RETENTION_CATALOG_REPO_PATH,
    reason: 'append-only store exceeded its maintenance threshold (inline after append)',
  };
  if (policy.action === 'rotate') {
    const segment = rotateStore(filePath, { now });
    if (!segment) return 'nothing-to-do';
    appendRetentionAudit({
      event: 'RETENTION_ROTATE',
      ...base,
      segment_path: repoRelativePosix(segment),
    });
    return 'rotated';
  }
  if (policy.action === 'compact') {
    const { records, distinctKeys } = analyzeStoreKeys(filePath, policy.key, options);
    if (records === distinctKeys) return 'nothing-to-do';
    const result = compactStoreByKey(filePath, {
      ...options,
      key: policy.key,
      archiveDir: policy.archiveDir,
      now,
    });
    if (!result) return 'nothing-to-do';
    appendRetentionAudit({
      event: 'RETENTION_COMPACT',
      ...base,
      compact_key: policy.key,
      archive_path: result.archivePath ? repoRelativePosix(result.archivePath) : undefined,
      before_lines: result.before,
      after_lines: result.after,
      merged_during_compaction: result.merged,
    });
    return 'compacted';
  }
  const result = retainWindow(filePath, {
    ...options,
    timeOf: policy.timeOf,
    keep: policy.keep,
    sinceMs: now.getTime() - policy.windowMs,
  });
  if (!result) return 'nothing-to-do';
  appendRetentionAudit({
    event: 'RETENTION_WINDOW',
    ...base,
    window_ms: policy.windowMs,
    before_lines: result.before,
    after_lines: result.after,
  });
  return 'windowed';
}

/**
 * Write-time retention: call right after appending to a store. A cheap stat
 * first; only when the size crosses the policy threshold (and has at least
 * doubled since this process last maintained it) does the action run, under
 * the store lock. Never throws — any failure logs a diagnostic warn and
 * returns `'failed'`; growth that maintenance cannot shrink warns (P3) but
 * never fails the append.
 *
 * `policy` is explicit, or `'catalog'` to resolve the store's exact-path
 * `rotate` / `compact` entry from storage-retention-catalog.json.
 */
export function maintainStoreAfterAppend(
  filePath: string,
  policy: AppendOnlyStorePolicy | 'catalog',
  options: MaintainStoreOptions = {}
): MaintainStoreOutcome {
  try {
    const size = jsonlFileSize(filePath);
    const resolved =
      policy === 'catalog'
        ? resolveAppendOnlyStorePolicy(filePath, options.catalog ?? cachedCatalog())
        : policy;
    if (!resolved) {
      if (!warnedNoPolicy.has(filePath)) {
        warnedNoPolicy.add(filePath);
        logger.warn(
          `[append-only-store] no rotate/compact catalog entry for ${repoRelativePosix(filePath)} — write-time maintenance cannot run | next: declare the store in ${RETENTION_CATALOG_REPO_PATH} or pass an explicit policy | evidence: size ${size} bytes`
        );
      }
      return 'no-policy';
    }
    const threshold = policyThreshold(resolved);
    const floor = Math.max(threshold, 2 * (lastMaintainedSize.get(filePath) ?? 0));
    if (size < floor) return 'below-threshold';

    const run = (): MaintainStoreOutcome => runPolicy(filePath, resolved, threshold, options);
    const lockId = options.lockId === undefined ? defaultLockId(filePath) : options.lockId;
    const outcome =
      lockId === null ? run() : withLockSync(lockId, run, options.lockTimeoutMs ?? 2000);

    const after = jsonlFileSize(filePath);
    lastMaintainedSize.set(filePath, after);
    if (after >= threshold) {
      logger.warn(
        `[append-only-store] ${repoRelativePosix(filePath)} is still ${after} bytes after ${resolved.action} (threshold ${threshold}) — the store grows faster than its retention shrinks it | next: review its retention policy | evidence: outcome ${outcome}`
      );
    }
    return outcome;
  } catch (err) {
    logger.warn(
      `[append-only-store] write-time maintenance failed for ${filePath} — ${err instanceof Error ? err.message : String(err)} | next: the append succeeded; the janitor or the next append retries | evidence: policy ${policy === 'catalog' ? 'catalog' : policy.action}`
    );
    return 'failed';
  }
}
