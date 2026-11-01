/**
 * MSN-STORE-BOUNDS-2-20261101: forward-stream a JSONL store that a write-time
 * compaction (`maintainStoreAfterAppend` → `compactStoreByKey`) may be
 * rewriting in another process.
 *
 * Between the compaction's park (live file renamed to
 * `<name>.compacting-<pid>-<n>-<tag>`) and its publish, the live file does not
 * exist. A reader in that window reads the parked copies instead, so a
 * lookup never comes back empty (and a caller never re-creates state it would
 * otherwise have found) because maintenance was running. Same protocol as the
 * mesh presence reader in `mesh/mesh-peer-directory.ts`.
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
 * Constant-memory forward stream of `safePath`'s records; when the live file
 * is momentarily parked by a compaction, streams the parked copies instead.
 * A missing store with no parked copies yields nothing.
 */
export function* streamJsonLinesAcrossCompaction<T = unknown>(
  safePath: string,
  options: JsonlReadOptions<T> = {}
): Generator<T> {
  let emitted = false;
  if (safeExistsSync(safePath)) {
    for (const record of streamJsonLines<T>(safePath, options)) {
      emitted = true;
      yield record;
    }
    // Parked between the existence check and the open: read the copies.
    if (emitted || safeExistsSync(safePath)) return;
  }
  for (const copy of parkedCompactionCopies(safePath)) {
    for (const record of streamJsonLines<T>(copy, options)) {
      emitted = true;
      yield record;
    }
  }
  // The copies were cleaned up because the compaction just published.
  if (!emitted && safeExistsSync(safePath)) yield* streamJsonLines<T>(safePath, options);
}
