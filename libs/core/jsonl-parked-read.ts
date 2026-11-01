/**
 * MSN-STORE-BOUNDS-2-20261101: forward-stream a JSONL store that a write-time
 * compaction (`maintainStoreAfterAppend` → `compactStoreByKey`) may be
 * rewriting in another process.
 *
 * Between the compaction's park (live file renamed to
 * `<name>.compacting-t<ms>-<seq>-<pid>-<tag>`) and its publish, the live file either
 * does not exist or — because appenders do not take the compaction lock — was
 * recreated by a writer and holds only the rows appended since the park.
 * Whenever parked copies exist they are therefore streamed first (in park
 * order), then the live file: every row is seen, older before newer. Rows may
 * repeat (between the publish and the cleanup of the copies, the live file
 * already holds the folded union), so this reader is for consumers that keep
 * the latest row per key — never for counting or append-order-sensitive
 * history. Same protocol as the mesh presence reader in
 * `mesh/mesh-peer-directory.ts`.
 *
 * A compaction may also park the live file while this reader is streaming it,
 * so the copies are re-listed after the live file; when a new copy appeared,
 * the copies and the live file are streamed again (rows repeat — allowed).
 *
 * Callers validate the path (and that it is a regular file) beforehand.
 */
import * as nodePath from 'node:path';
import { streamJsonLines, type JsonlReadOptions } from './jsonl-read.js';
import { readJsonLinesCached } from './jsonl-tail.js';
import { assertSafeRepositoryPath, safeReaddir, safeStat } from './secure-io.js';

/** Current names: `t<ms>-<seq>-…` (cross-process sortable). */
const PARKED_COPY_STAMP = /^t(\d+)-(\d+)-/u;
/** Legacy names: `<pid>-<n>-…` (ordered by mtime, then n). */
const LEGACY_PARKED_COPY_ORDER = /^\d+-(\d+)(?:-|$)/u;
/** Bound on re-reads when compactions keep parking the live file mid-read. */
const MAX_STREAM_ROUNDS = 4;

interface ParkOrder {
  ms: number;
  seq: number;
  name: string;
}

function parkOrder(dir: string, name: string, suffix: string): ParkOrder {
  const stamped = suffix.match(PARKED_COPY_STAMP);
  if (stamped) return { ms: Number(stamped[1]), seq: Number(stamped[2]), name };
  let ms = 0;
  try {
    ms = safeStat(nodePath.join(dir, name)).mtimeMs;
  } catch {
    // unlinked after listing: its rows are in the live file
  }
  return { ms, seq: Number(suffix.match(LEGACY_PARKED_COPY_ORDER)?.[1] ?? 0), name };
}

/** Parked copies of `safePath` a compaction is rewriting, in park order. */
export function parkedCompactionCopies(safePath: string): string[] {
  const dir = nodePath.dirname(safePath);
  const prefix = `${nodePath.basename(safePath)}.compacting-`;
  let names: string[];
  try {
    names = safeReaddir(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(prefix))
    .map((name) => parkOrder(dir, name, name.slice(prefix.length)))
    .sort(
      (a, b) => a.ms - b.ms || a.seq - b.seq || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    )
    .map((entry) => nodePath.join(dir, entry.name));
}

/**
 * Constant-memory forward stream of `safePath`'s records across a concurrent
 * compaction: parked copies first (park order), then the live file. A missing
 * store with no parked copies yields nothing.
 */
export function* streamJsonLinesAcrossCompaction<T = unknown>(
  safePath: string,
  options: JsonlReadOptions<T> = {}
): Generator<T> {
  let copies = parkedCompactionCopies(safePath);
  for (let round = 0; round < MAX_STREAM_ROUNDS; round++) {
    // A copy unlinked after listing (the compaction published) yields
    // nothing; its rows are in the live file read below.
    for (const copy of copies) yield* streamJsonLines<T>(copy, options);
    yield* streamJsonLines<T>(safePath, options);
    // A copy parked after the listing may hold the rows the live read missed
    // (the live file was moved aside and recreated): read everything again.
    const seen = new Set(copies);
    const after = parkedCompactionCopies(safePath);
    if (after.every((copy) => seen.has(copy))) return;
    copies = after;
  }
}

/**
 * {@link readJsonLinesCached} for a ledger a write-time compaction may be
 * rewriting in another process. With no parked copy around it is the cached
 * incremental replay; while copies exist (before or after the replay) the
 * cache is bypassed for a full {@link streamJsonLinesAcrossCompaction} read
 * with byte-identical rows collapsed to their first occurrence — only for
 * ledgers whose rows are unique (they carry a timestamp), where an identical
 * row can only be the same row seen twice across the park.
 */
export function readJsonLinesCachedAcrossCompaction<T>(filePath: string): T[] {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (parkedCompactionCopies(safePath).length === 0) {
    const rows = readJsonLinesCached<T>(safePath);
    if (parkedCompactionCopies(safePath).length === 0) return rows;
  }
  const seen = new Set<string>();
  const rows: T[] = [];
  for (const row of streamJsonLinesAcrossCompaction<T>(safePath, { onMalformed: 'skip' })) {
    const text = JSON.stringify(row);
    if (seen.has(text)) continue;
    seen.add(text);
    rows.push(row);
  }
  return rows;
}
