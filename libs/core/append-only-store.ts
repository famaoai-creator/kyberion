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
 *  1. The live file is atomically moved aside to a
 *     `.compacting-t<ms>-<seq>-<pid>-<tag>` staging sibling (zero-padded
 *     wall-clock ms + per-process sequence, so park order sorts across
 *     processes and runs; a name never overwrites a kept copy) — appends already in flight land on the moved inode,
 *     appends after the move create a fresh live file.
 *  2. The surviving lines are written to a temp sibling and published with an
 *     exclusive hard link (`safeLinkExclusiveSync`; buffered exclusive publish
 *     where hard links are unsupported) — EEXIST means a writer recreated the
 *     live file in the gap, so it is parked too, merged, and the publish is
 *     retried (at most {@link COMPACT_MAX_PARK_ATTEMPTS} rounds). Pass 1
 *     records how many bytes of each parked copy it indexed; pass 2 filters
 *     exactly that prefix and copies any bytes an in-flight append added
 *     afterwards verbatim, so the two passes always agree on line numbers.
 *     A line over the per-line guard is copied verbatim, never dropped.
 *  3. If the merge loop does not converge, the raw union of every parked file
 *     is restored uncompressed — nothing is ever dropped.
 *  4. Staging siblings are removed once the live file holds the result and
 *     (when requested) the raw union is archived, or once the raw union was
 *     restored to the live file. They are kept only while they are the sole
 *     full-fidelity copy, so no record is lost and nothing is kept twice.
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
  safePublishExclusiveFileSync,
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
  /** Lines across every parked copy (the raw union), oversized and late lines included. */
  before: number;
  /** Lines in the live file after the rewrite (`before` when not converged). */
  after: number;
  /** False when writers out-paced the merge loop and the raw union was restored. */
  published: boolean;
  /** Live files recreated by writers during the rewrite and merged in. */
  merged: number;
  /** Raw-union archive written before staging cleanup, or null. */
  archivePath: string | null;
  /** Lines over the per-line guard: kept byte-verbatim in the live file, never dropped. */
  oversizedLines: number;
  /**
   * Lines that reached a parked copy after pass 1 indexed it (an append in
   * flight at park time): carried over verbatim, never filtered.
   */
  lateLines: number;
}

export interface StoreScanOptions {
  /** Range-read chunk size (tests inject small values). */
  chunkBytes?: number;
  /** Per-line guard (tests inject small values). */
  maxLineBytes?: number;
}

/**
 * Per-line rewrite filter. `index` counts non-blank, line-guard-sized lines
 * across every parked copy in order, identically in both passes. Malformed
 * lines reach the filter as raw text; oversized lines and late (in-flight)
 * bytes never reach it — they are always kept verbatim.
 */
export interface StoreLineFilter {
  /**
   * Pass 1, once per parked file as it is parked: `index` is global across
   * files; `fileIndex` is the file's position in park order.
   */
  observe(text: string, index: number, fileIndex: number): void;
  /** Pass 2: whether the line survives. */
  keep(text: string, index: number, fileIndex: number): boolean;
}
type LineFilter = StoreLineFilter;

/** Test seams for the parked rewrite. */
export interface AppendOnlyStoreTestHooks {
  /** Runs right before pass 2 streams the parked copies (simulate a late append). */
  beforeWriteSurvivors?: (stagingPaths: readonly string[]) => void;
  /** Runs right before the exclusive publish (throw to simulate ENOSPC etc.). */
  beforePublish?: (livePath: string) => void;
}
let testHooks: AppendOnlyStoreTestHooks = {};

/** Test seam: install rewrite hooks; call with `{}` to reset. */
export function setAppendOnlyStoreTestHooks(hooks: AppendOnlyStoreTestHooks): void {
  testHooks = { ...hooks };
}

/** Largest result the no-hard-link publish fallback buffers in memory. */
const PUBLISH_COPY_MAX_BYTES = 64 * 1024 * 1024;

const NEWLINE = 0x0a;

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

let lastParkMs = 0;
let parkSeq = 0;

/**
 * Base name of a parked copy: `<live>.compacting-t<ms>-<seq>-<pid>-<tag>`.
 * The zero-padded ms (monotonic within a process) and per-process sequence
 * make lexical order park order across processes and runs, so a reader
 * (`parkedCompactionCopies`) streams kept copies of a failed rewrite before
 * newer ones. Callers still pick a non-existing sibling (`uniqueSibling`).
 */
function parkedCopyBase(livePath: string, tag: string): string {
  lastParkMs = Math.max(Date.now(), lastParkMs);
  const ms = String(lastParkMs).padStart(15, '0');
  const seq = String(parkSeq++ % 1_000_000).padStart(6, '0');
  return `${livePath}.compacting-t${ms}-${seq}-${process.pid}-${tag}`;
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

/**
 * Visit bytes [start, end) of `src` in chunks from one pinned inode (`end`
 * defaults to the size at open). Returns the number of bytes visited.
 */
function forEachChunk(
  src: string,
  chunkBytes: number,
  visit: (buf: Buffer) => void,
  start = 0,
  end?: number
): number {
  const io = getFoundationIo();
  const reader = io.openRangeReader?.(src);
  try {
    const readRange = io.readRange;
    if (!reader && !readRange) throw new Error('secure_foundation_range_io_not_registered');
    const stop = end ?? (reader ? reader.size : jsonlFileSize(src));
    let position = start;
    while (position < stop) {
      const length = Math.min(chunkBytes, stop - position);
      const buf = reader
        ? reader.read(position, length)
        : readRange!.call(io, src, position, length);
      if (buf.length === 0) break;
      visit(buf);
      position += buf.length;
    }
    return position - start;
  } finally {
    reader?.close();
  }
}

/**
 * Byte-verbatim copy of `src` bytes [start, end) onto `out`, newline-terminated
 * when anything was copied. Returns the number of lines copied.
 */
function copyBytes(
  src: string,
  out: BatchedAppender,
  chunkBytes: number,
  start = 0,
  end?: number
): number {
  let lines = 0;
  let lastByte = NEWLINE;
  const copied = forEachChunk(
    src,
    chunkBytes,
    (buf) => {
      out.writeBuffer(buf);
      for (let i = buf.indexOf(NEWLINE); i !== -1; i = buf.indexOf(NEWLINE, i + 1)) lines++;
      lastByte = buf[buf.length - 1]!;
    },
    start,
    end
  );
  if (copied > 0 && lastByte !== NEWLINE) {
    out.write('\n');
    lines++;
  }
  return lines;
}

function isLinkUnsupported(err: unknown): boolean {
  return ['ENOTSUP', 'ENOSYS', 'EPERM', 'EXDEV'].some((code) => isErrno(err, code));
}

/**
 * Publish `temp` at `livePath` exclusively (EEXIST when a writer recreated
 * it). Filesystems without hard links fall back to the buffered exclusive
 * publish the janitor used before (`safePublishExclusiveFileSync`, which in
 * turn falls back to an exclusive create).
 */
function publishExclusive(temp: string, livePath: string, chunkBytes: number): void {
  try {
    safeLinkExclusiveSync(temp, livePath);
    return;
  } catch (err) {
    if (!isLinkUnsupported(err)) throw err;
    const size = jsonlFileSize(temp);
    if (size > PUBLISH_COPY_MAX_BYTES) throw err;
    const parts: Buffer[] = [];
    forEachChunk(temp, chunkBytes, (buf) => parts.push(Buffer.from(buf)));
    safePublishExclusiveFileSync(livePath, Buffer.concat(parts));
  }
}

interface ParkedCopy {
  path: string;
  /**
   * Bytes pass 1 indexed — always on a line boundary. Pass 2 filters exactly
   * this prefix, so its line numbering matches pass 1 even when an in-flight
   * append lands on the parked inode between the passes; anything after it
   * is copied verbatim.
   */
  indexedBytes: number;
  /**
   * A copy left by an earlier, failed rewrite and adopted by this one
   * ({@link mergeCompactionCopies}). It is removed only once the live file
   * holds the published result; a raw-union restore never includes it.
   */
  adopted?: boolean;
}

function rewriteParked(
  livePath: string,
  filter: LineFilter,
  options: StoreScanOptions & {
    archivePath?: string | null;
    label: string;
    /** Leftover parked copies (park order) streamed before the live file. */
    adoptCopies?: readonly string[];
  }
): StoreRewriteResult | null {
  const adoptCopies = options.adoptCopies ?? [];
  if (!safeExistsSync(livePath) && adoptCopies.length === 0) return null;
  const chunkBytes = options.chunkBytes ?? DEFAULT_JSONL_CHUNK_BYTES;
  const scan = { chunkBytes, maxLineBytes: options.maxLineBytes };
  const parked: ParkedCopy[] = [];
  let total = 0;
  let merged = 0;
  let oversizedLines = 0;
  let lateLines = 0;
  let liveRestored = false;

  const indexCopy = (copy: ParkedCopy): void => {
    const fileIndex = parked.length;
    parked.push(copy);
    const onOversized = (line: JsonlOversizedLine): void => {
      if (!line.terminated) return; // runs to EOF: carried verbatim with the late bytes
      oversizedLines++;
      copy.indexedBytes = line.byteEnd!;
    };
    for (const line of streamTextLines(copy.path, { ...scan, onOversized })) {
      // An unterminated tail is an append in flight (or torn): pass 2 copies it verbatim.
      if (!line.terminated) break;
      copy.indexedBytes = line.byteEnd!;
      if (!line.text.trim()) continue;
      filter.observe(line.text, total++, fileIndex);
    }
  };

  const park = (tag: string): boolean => {
    const staging = uniqueSibling(parkedCopyBase(livePath, tag), '');
    try {
      safeMoveSync(livePath, staging);
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return false; // another maintainer took it
      throw err;
    }
    indexCopy({ path: staging, indexedBytes: 0 });
    return true;
  };

  const writeSurvivors = (dest: string): number => {
    testHooks.beforeWriteSurvivors?.(parked.map((copy) => copy.path));
    const out = new BatchedAppender(dest);
    let index = 0;
    let kept = 0;
    lateLines = 0;
    for (const [fileIndex, copy] of parked.entries()) {
      // An oversized line is never buffered and never dropped: copy its bytes.
      const onOversized = (line: JsonlOversizedLine): void => {
        kept += copyBytes(copy.path, out, chunkBytes, line.byteStart!, line.byteEnd!);
      };
      for (const line of streamTextLines(copy.path, {
        ...scan,
        endOffset: copy.indexedBytes,
        onOversized,
      })) {
        if (!line.text.trim()) continue;
        if (filter.keep(line.text, index++, fileIndex)) {
          out.write(`${line.text}\n`);
          kept++;
        }
      }
      lateLines += copyBytes(copy.path, out, chunkBytes, copy.indexedBytes);
    }
    out.flush();
    return kept + lateLines;
  };

  const writeUnion = (dest: string, copies: readonly ParkedCopy[] = parked): void => {
    const out = new BatchedAppender(dest);
    for (const copy of copies) copyBytes(copy.path, out, chunkBytes);
    out.flush();
  };

  const restoreRawUnion = (): void => {
    // Park any live file that reappeared so its records are not lost.
    if (safeExistsSync(livePath) && park('restore-merge')) merged++;
    // Adopted copies stay where they were: only this run's parks are restored.
    const own = parked.filter((copy) => !copy.adopted);
    if (own.length === 0) {
      liveRestored = true;
      return;
    }
    const temp = uniqueSibling(`${livePath}.compact-restore-${process.pid}`, '.tmp');
    try {
      writeUnion(temp, own);
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
    for (const copyPath of adoptCopies) {
      indexCopy({ path: copyPath, indexedBytes: 0, adopted: true });
    }
    if (!park('initial') && parked.length === 0) return null;
    for (let i = 0; i <= COMPACT_MAX_PARK_ATTEMPTS; i++) {
      if (!safeExistsSync(livePath)) {
        const temp = uniqueSibling(`${livePath}.compact-out-${process.pid}-${i}`, '.tmp');
        try {
          kept = writeSurvivors(temp);
          testHooks.beforePublish?.(livePath);
          publishExclusive(temp, livePath, chunkBytes);
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
        `[append-only-store] ${options.label} did not converge for ${livePath} — writers out-paced ${COMPACT_MAX_PARK_ATTEMPTS} merge rounds | next: raw records restored uncompressed; the next maintenance pass retries | evidence: ${parked.length} parked copies`
      );
    }
    if (oversizedLines > 0) {
      logger.warn(
        `[append-only-store] ${oversizedLines} oversized line(s) in ${livePath} during ${options.label} — a line exceeded the per-line guard | next: inspect the writer; the line was kept byte-verbatim in the live file | evidence: ${options.archivePath ? `raw union archived at ${options.archivePath}` : 'no archive requested'}`
      );
    }

    if (options.archivePath) {
      safeMkdir(nodePath.dirname(options.archivePath), { recursive: true });
      const target = uniqueSibling(options.archivePath.replace(/\.jsonl$/, ''), '.jsonl');
      try {
        writeUnion(target);
      } catch (err) {
        tryUnlink(target); // a partial archive is not evidence of anything
        throw err;
      }
      archivePath = target;
    }
  } catch (err) {
    if (!liveRestored && parked.length > 0) {
      try {
        restoreRawUnion();
      } catch (restoreErr) {
        logger.warn(
          `[append-only-store] ${options.label} failed and the raw union could not be restored for ${livePath} — ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)} | next: recover records from the staging files by hand | evidence: ${parked.map((copy) => copy.path).join(', ')}`
        );
      }
    }
    // Keep the staging copies only while they are the sole full-fidelity
    // record: the live file lost the data, or it holds the compacted result
    // and the requested raw-union archive was not written. When the raw
    // union was restored to the live file, the copies are redundant.
    if (!liveRestored || (published && options.archivePath && !archivePath)) {
      logger.warn(
        `[append-only-store] ${options.label} failed for ${livePath}; staging copies kept — they hold records found nowhere else | next: fix the cause; recover or archive the copies, then delete them | evidence: ${parked.map((copy) => copy.path).join(', ')}`
      );
      parked.length = 0;
    }
    throw err;
  } finally {
    for (const copy of parked) if (!copy.adopted || published) tryUnlink(copy.path);
  }

  const before = total + oversizedLines + lateLines;
  return {
    before,
    after: published ? kept : before,
    published,
    merged,
    archivePath,
    oversizedLines,
    lateLines,
  };
}

export interface RewriteStoreLinesOptions extends StoreScanOptions {
  /** Raw-union archive file (made unique if taken); null/undefined = no archive. */
  archivePath?: string | null;
  /** Diagnostic label for warns (e.g. `'wake-ledger compaction'`). */
  label?: string;
}

/**
 * Narrow entry to the race-safe parked rewrite for stores whose fold rule is
 * not expressible as compact-by-key or a time window (e.g. the dot wake
 * ledger). Same guarantees as {@link compactStoreByKey}: malformed and
 * oversized lines kept verbatim, raw union restored on any error, re-park
 * only on EEXIST. Returns null when the live file does not exist.
 */
export function rewriteStoreLines(
  filePath: string,
  filter: StoreLineFilter,
  options: RewriteStoreLinesOptions = {}
): StoreRewriteResult | null {
  return rewriteParked(filePath, filter, {
    ...options,
    archivePath: options.archivePath ?? null,
    label: options.label ?? 'rewrite',
  });
}

export interface MergeCompactionCopiesResult extends StoreRewriteResult {
  /** Lines dropped because a byte-identical line was kept from an earlier file. */
  duplicatesDropped: number;
}

/**
 * Merge leftover parked copies of a failed rewrite back into the live store:
 * the copies (pass them in park order — `parkedCompactionCopies`), then the
 * live file, through the same race-safe parked rewrite. A line byte-identical
 * to a line already kept from an EARLIER file is dropped (the copies and a
 * published result overlap), so strict stores never get cross-file
 * duplicates; repeats inside one file are kept. Oversized and in-flight lines
 * are kept verbatim. The copies are removed only once the result is
 * published; when writers out-pace the merge (`published: false`) they stay
 * untouched. The caller holds the store lock ({@link appendOnlyStoreLockId}).
 * Returns null when neither the live file nor any copy exists.
 */
export function mergeCompactionCopies(
  filePath: string,
  copies: readonly string[],
  options: StoreScanOptions = {}
): MergeCompactionCopiesResult | null {
  const seen = new Set<string>();
  let fileSeen = new Set<string>();
  let currentFile = -1;
  const dropped = new Set<number>();
  const digest = (text: string): string => createHash('sha256').update(text).digest('base64');
  const result = rewriteParked(
    filePath,
    {
      observe(text, index, fileIndex) {
        if (fileIndex !== currentFile) {
          for (const hash of fileSeen) seen.add(hash);
          fileSeen = new Set();
          currentFile = fileIndex;
        }
        const hash = digest(text);
        if (seen.has(hash)) dropped.add(index);
        else fileSeen.add(hash);
      },
      keep(_text, index) {
        return !dropped.has(index);
      },
    },
    { ...options, archivePath: null, label: 'compaction-copy recovery', adoptCopies: copies }
  );
  return result ? { ...result, duplicatesDropped: result.published ? dropped.size : 0 } : null;
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

/**
 * How a compaction identifies the keyed entity: a record field name, or a
 * function for composite keys (e.g. `${dot_id}:${signal}`). A function that
 * returns undefined marks the record keyless, so it is kept verbatim.
 */
export type StoreKey = string | ((record: Record<string, unknown>) => string | undefined);

/** Printable form of a {@link StoreKey} for audit records and diagnostics. */
export function describeStoreKey(key: StoreKey): string {
  return typeof key === 'string' ? key : `fn:${key.name || 'anonymous'}`;
}

function recordKey(text: string, key: StoreKey): string | undefined {
  let value: unknown;
  try {
    value = parseSafeJsonInput(text, 'JSONL entry');
  } catch {
    return undefined; // malformed lines are kept verbatim like keyless records
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof key === 'function') {
    let derived: string | undefined;
    try {
      derived = key(record);
    } catch {
      return undefined; // a key function that throws leaves the record verbatim
    }
    return typeof derived === 'string' && derived !== '' ? derived : undefined;
  }
  const field = record[key];
  return typeof field === 'string' || typeof field === 'number' ? String(field) : undefined;
}

/**
 * Streaming count of non-blank records and distinct keys — the janitor's
 * "anything to fold?" check (`distinctKeys === records` means nothing to do).
 */
export function analyzeStoreKeys(
  filePath: string,
  key: StoreKey,
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

/**
 * Archive directory for WRITE-TIME maintenance: `<store dir>/compaction-archive`.
 * The writer of a store can always write next to it, and the archive keeps the
 * store's tier / tenant partition — unlike {@link defaultCompactionArchiveDir}
 * (`active/archive/...`), which only the janitor's role may write.
 */
export function writeTimeArchiveDir(filePath: string): string {
  return nodePath.join(nodePath.dirname(filePath), 'compaction-archive');
}

export interface CompactStoreOptions extends StoreScanOptions {
  /** Record field (or composite-key function) identifying the keyed entity. */
  key: StoreKey;
  /**
   * Where the raw-union archive lands. Default {@link defaultCompactionArchiveDir}.
   * `null` = no archive, for ephemeral stores whose readers use only the
   * latest record per key (nothing a reader uses is lost).
   */
  archiveDir?: string | null;
  now?: Date;
}

/**
 * Fold the store to the last record per `key` (order of last appearance;
 * records lacking the key, and unparseable lines, are kept verbatim). Two
 * streaming passes: pass 1 records the last line index per key, pass 2
 * writes the survivors to a temp file that is published exclusively. The raw
 * union is archived to `<archiveDir>/<stem>.<stamp>Z-<pid>.jsonl` unless
 * `archiveDir` is null. Returns null when the live file does not exist.
 */
export function compactStoreByKey(
  filePath: string,
  options: CompactStoreOptions
): StoreRewriteResult | null {
  const lastIndex = new Map<string, number>();
  const now = options.now ?? new Date();
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  const archiveDir =
    options.archiveDir === undefined ? defaultCompactionArchiveDir(filePath) : options.archiveDir;
  const archivePath =
    archiveDir === null
      ? null
      : nodePath.join(archiveDir, `${rotatedSegmentStem(filePath)}.${stamp}Z-${process.pid}.jsonl`);
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
 * same race-safe parked rewrite as compaction. Unparseable lines, and lines
 * over the per-line guard, are kept verbatim — the window never loses a
 * record it cannot read. Returns null when the live file does not exist.
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
  | { action: 'compact'; key: StoreKey; minBytes?: number; archiveDir?: string | null }
  | {
      /** Explicit-policy only: the retention catalog has no `window` action. */
      action: 'window';
      minBytes: number;
      windowMs: number;
      timeOf: (record: unknown) => number | undefined;
      keep?: (record: unknown) => boolean;
      /**
       * Raw-union archive directory for the dropped window (evidence stores,
       * e.g. accounting rows). Default: none — the window is lossy by design.
       */
      archiveDir?: string | null;
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
  /**
   * Where the RETENTION_* record goes. Default: the storage-retention audit
   * log (`appendRetentionAudit`). A writer whose role cannot write there
   * routes it through a governed recorder it can use (e.g. the audit chain).
   */
  audit?: (record: Record<string, unknown>) => void;
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
  testHooks = {};
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
  // A self-managed store's writer owns its live-file retention.
  if (!entry || entry.self_managed === true) return null;
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

/**
 * Inter-process lock id `maintainStoreAfterAppend` takes for `filePath` by
 * default. Anything else that rewrites the store (e.g. the compaction-copy
 * recovery command) takes the same id so it never races write-time maintenance.
 */
export function appendOnlyStoreLockId(filePath: string): string {
  return `append-only-store-${createHash('sha256')
    .update(nodePath.resolve(filePath))
    .digest('hex')
    .slice(0, 32)}`;
}

/**
 * Cheap pre-check (one stat): would {@link maintainStoreAfterAppend} run
 * `policy` now? For a caller that takes the store lock itself under another
 * identity (`lockId: null`), so most appends skip the lock.
 */
export function appendOnlyStoreMaintenanceDue(
  filePath: string,
  policy: AppendOnlyStorePolicy
): boolean {
  const floor = Math.max(policyThreshold(policy), 2 * (lastMaintainedSize.get(filePath) ?? 0));
  return jsonlFileSize(filePath) >= floor;
}

function recordAudit(options: MaintainStoreOptions, record: Record<string, unknown>): void {
  try {
    (options.audit ?? appendRetentionAudit)(record);
  } catch (err) {
    logger.warn(
      `[append-only-store] ${String(record.event)} audit record for ${String(record.path)} could not be written — ${err instanceof Error ? err.message : String(err)} | next: check the audit recorder for this store | evidence: maintenance itself completed`
    );
  }
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
    recordAudit(options, {
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
      // Write-time: the store's writer cannot write `active/archive/` (the
      // janitor's default), so archive next to the store unless overridden.
      archiveDir:
        policy.archiveDir === undefined ? writeTimeArchiveDir(filePath) : policy.archiveDir,
      now,
    });
    if (!result) return 'nothing-to-do';
    recordAudit(options, {
      event: 'RETENTION_COMPACT',
      ...base,
      compact_key: describeStoreKey(policy.key),
      archive_path: result.archivePath ? repoRelativePosix(result.archivePath) : undefined,
      before_lines: result.before,
      after_lines: result.after,
      merged_during_compaction: result.merged,
    });
    return 'compacted';
  }
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  const archivePath =
    policy.archiveDir == null
      ? undefined
      : nodePath.join(
          policy.archiveDir,
          `${rotatedSegmentStem(filePath)}.${stamp}Z-${process.pid}.jsonl`
        );
  const result = retainWindow(filePath, {
    ...options,
    timeOf: policy.timeOf,
    keep: policy.keep,
    sinceMs: now.getTime() - policy.windowMs,
    archivePath,
  });
  if (!result) return 'nothing-to-do';
  recordAudit(options, {
    event: 'RETENTION_WINDOW',
    ...base,
    window_ms: policy.windowMs,
    archive_path: result.archivePath ? repoRelativePosix(result.archivePath) : undefined,
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
  let attemptedSize: number | undefined;
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

    attemptedSize = size;
    const run = (): MaintainStoreOutcome => runPolicy(filePath, resolved, threshold, options);
    const lockId = options.lockId === undefined ? appendOnlyStoreLockId(filePath) : options.lockId;
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
    // Back off like a success: retry only once the store doubles, so a
    // persistent failure does not re-run an O(N) pass on every append.
    if (attemptedSize !== undefined) lastMaintainedSize.set(filePath, attemptedSize);
    logger.warn(
      `[append-only-store] write-time maintenance failed for ${filePath} — ${err instanceof Error ? err.message : String(err)} | next: the append succeeded; the janitor retries, and so does an append once the store reaches ${attemptedSize !== undefined ? 2 * attemptedSize : 'its threshold'} bytes | evidence: policy ${policy === 'catalog' ? 'catalog' : policy.action}`
    );
    return 'failed';
  }
}
