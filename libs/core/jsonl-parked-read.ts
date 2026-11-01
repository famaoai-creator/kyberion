/**
 * MSN-STORE-BOUNDS-2-20261101: forward-stream a JSONL store that a write-time
 * compaction (`maintainStoreAfterAppend` → `compactStoreByKey`) may be
 * rewriting in another process.
 *
 * Between the compaction's park (live file renamed to
 * `<name>.compacting-<pid>-<n>-<tag>`) and its publish, the live file either
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
 * Callers validate the path (and that it is a regular file) beforehand.
 */
import * as nodePath from 'node:path';
import { streamJsonLines, type JsonlReadOptions } from './jsonl-read.js';
import { safeExistsSync, safeReaddir } from './secure-io.js';

const PARKED_COPY_ORDER = /^\d+-(\d+)-/u;

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
  const order = (name: string): number =>
    Number(name.slice(prefix.length).match(PARKED_COPY_ORDER)?.[1] ?? 0);
  return names
    .filter((name) => name.startsWith(prefix))
    .sort((a, b) => order(a) - order(b))
    .map((name) => nodePath.join(dir, name));
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
  const copies = parkedCompactionCopies(safePath);
  // A copy unlinked after listing (the compaction published) yields nothing;
  // its rows are in the live file read below.
  for (const copy of copies) yield* streamJsonLines<T>(copy, options);
  let liveEmitted = false;
  for (const record of streamJsonLines<T>(safePath, options)) {
    liveEmitted = true;
    yield record;
  }
  if (copies.length > 0 || liveEmitted || safeExistsSync(safePath)) return;
  // No copies were listed, yet the live file is gone: a compaction parked it
  // after the listing. Nothing was emitted, so re-read without duplicates.
  const late = parkedCompactionCopies(safePath);
  for (const copy of late) yield* streamJsonLines<T>(copy, options);
  if (late.length > 0) yield* streamJsonLines<T>(safePath, options);
}
