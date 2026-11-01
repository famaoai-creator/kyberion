import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Fake mtimes for legacy-name ordering (no real-time sleep). */
const mtimeOverride = vi.hoisted(() => new Map<string, number>());

vi.mock('./secure-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./secure-io.js')>();
  return {
    ...actual,
    safeStat: (filePath: string) => {
      const stat = actual.safeStat(filePath);
      const fake = mtimeOverride.get(path.basename(filePath));
      return fake === undefined ? stat : Object.assign(stat, { mtimeMs: fake });
    },
  };
});

import { sharedTmp } from './path-resolver.js';
import {
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeMoveSync,
  safeReaddir,
  safeRmSync,
  safeWriteFile,
} from './secure-io.js';
import { compactStoreByKey, setAppendOnlyStoreTestHooks } from './append-only-store.js';
import {
  parkedCompactionCopies,
  readJsonLinesCachedAcrossCompaction,
  streamJsonLinesAcrossCompaction,
} from './jsonl-parked-read.js';

interface Row {
  id: string;
  v: number;
}

describe('jsonl-parked-read', () => {
  let dir: string;
  let live: string;

  beforeEach(() => {
    dir = sharedTmp(`jsonl-parked-read-${randomUUID().slice(0, 8)}`);
    safeMkdir(dir, { recursive: true });
    live = path.join(dir, 'store.jsonl');
  });

  afterEach(() => {
    mtimeOverride.clear();
    setAppendOnlyStoreTestHooks({});
    safeRmSync(dir, { recursive: true, force: true });
  });

  const write = (rows: Row[], tail = ''): void =>
    safeWriteFile(live, rows.map((row) => `${JSON.stringify(row)}\n`).join('') + tail);

  it('yields nothing for a missing store with no parked copies', () => {
    expect([...streamJsonLinesAcrossCompaction<Row>(live)]).toEqual([]);
  });

  it('streams the live file across small chunks and skips a torn tail line', () => {
    write(
      [
        { id: 'a', v: 1 },
        { id: 'b', v: 2 },
      ],
      '{"id":"c","v'
    );
    expect(
      [...streamJsonLinesAcrossCompaction<Row>(live, { chunkBytes: 5, onMalformed: 'skip' })].map(
        (row) => row.id
      )
    ).toEqual(['a', 'b']);
  });

  it('reads the parked copies while a compaction has the live file moved aside', () => {
    write([
      { id: 'a', v: 1 },
      { id: 'a', v: 2 },
      { id: 'b', v: 1 },
    ]);
    let seenDuringPark: Row[] | undefined;
    setAppendOnlyStoreTestHooks({
      beforeWriteSurvivors: () => {
        // The live file is parked: a concurrent reader must still see every row.
        expect(safeExistsSync(live)).toBe(false);
        expect(parkedCompactionCopies(live)).toHaveLength(1);
        seenDuringPark = [...streamJsonLinesAcrossCompaction<Row>(live)];
      },
    });
    compactStoreByKey(live, { key: 'id', archiveDir: null });
    expect(seenDuringPark).toEqual([
      { id: 'a', v: 1 },
      { id: 'a', v: 2 },
      { id: 'b', v: 1 },
    ]);
    // After the publish the live file holds the folded result.
    expect([...streamJsonLinesAcrossCompaction<Row>(live)]).toEqual([
      { id: 'a', v: 2 },
      { id: 'b', v: 1 },
    ]);
  });

  it('keeps parked rows visible after a writer recreates the live file mid-compaction', () => {
    write([
      { id: 'task', v: 1 },
      { id: 'task', v: 2 }, // the completed state
    ]);
    let seenDuringPark: Row[] | undefined;
    setAppendOnlyStoreTestHooks({
      beforeWriteSurvivors: () => {
        if (seenDuringPark) return; // the merge round re-runs the hook
        // Appenders do not take the compaction lock: this recreates the live
        // file holding only the new row while the history is parked.
        safeAppendFileSync(live, `${JSON.stringify({ id: 'other', v: 1 })}\n`);
        expect(parkedCompactionCopies(live)).toHaveLength(1);
        seenDuringPark = [...streamJsonLinesAcrossCompaction<Row>(live)];
      },
    });
    compactStoreByKey(live, { key: 'id', archiveDir: null });
    // Parked copies first, then the live file: the completed state is still
    // visible and the newest row per key wins.
    expect(seenDuringPark).toEqual([
      { id: 'task', v: 1 },
      { id: 'task', v: 2 },
      { id: 'other', v: 1 },
    ]);
    const latest = new Map<string, number>();
    for (const row of streamJsonLinesAcrossCompaction<Row>(live)) latest.set(row.id, row.v);
    expect(Object.fromEntries(latest)).toEqual({ task: 2, other: 1 });
  });

  it('reads leftover parked copies before the live file so the live rows win', () => {
    write([{ id: 'a', v: 3 }]);
    safeWriteFile(`${live}.compacting-1-0-initial`, `${JSON.stringify({ id: 'a', v: 1 })}\n`);
    safeWriteFile(`${live}.compacting-1-1-merge-0`, `${JSON.stringify({ id: 'a', v: 2 })}\n`);
    expect([...streamJsonLinesAcrossCompaction<Row>(live)].map((row) => row.v)).toEqual([1, 2, 3]);
  });
  it('re-reads when a compaction parks the live file mid-read and a writer recreates it', () => {
    write([
      { id: 'task', v: 1 },
      { id: 'task', v: 2 },
    ]);
    const stream = streamJsonLinesAcrossCompaction<Row>(live);
    const rows: Row[] = [stream.next().value as Row];
    // After the listing (no copies) and while the live read is under way,
    // another process parks the live file and a writer recreates it.
    safeMoveSync(live, `${live}.compacting-t000000000000001-000000-999999-initial`);
    safeAppendFileSync(live, `${JSON.stringify({ id: 'other', v: 1 })}\n`);
    for (let next = stream.next(); !next.done; next = stream.next()) rows.push(next.value);
    const latest = new Map<string, number>();
    for (const row of rows) latest.set(row.id, row.v);
    // The recreated live row is not lost; duplicates are allowed.
    expect(Object.fromEntries(latest)).toEqual({ task: 2, other: 1 });
  });

  it('orders parked copies by their park stamp across processes, then legacy copies by mtime', () => {
    // Stamped names: time first, pid last — a newer copy from a lower pid sorts after.
    safeWriteFile(
      `${live}.compacting-t000000000000002-000000-1-initial`,
      `${JSON.stringify({ id: 'a', v: 2 })}\n`
    );
    safeWriteFile(
      `${live}.compacting-t000000000000001-000007-9-initial`,
      `${JSON.stringify({ id: 'a', v: 1 })}\n`
    );
    write([{ id: 'a', v: 3 }]);
    expect([...streamJsonLinesAcrossCompaction<Row>(live)].map((row) => row.v)).toEqual([1, 2, 3]);
    safeRmSync(dir, { recursive: true, force: true });
    safeMkdir(dir, { recursive: true });
    // Legacy `<pid>-<n>` copies from two pids tie on n: the older write goes first.
    safeWriteFile(`${live}.compacting-9-0-initial`, `${JSON.stringify({ id: 'a', v: 1 })}\n`);
    mtimeOverride.set('store.jsonl.compacting-9-0-initial', 1_000);
    mtimeOverride.set('store.jsonl.compacting-1-0-initial', 2_000);
    safeWriteFile(`${live}.compacting-1-0-initial`, `${JSON.stringify({ id: 'a', v: 2 })}\n`);
    expect([...streamJsonLinesAcrossCompaction<Row>(live)].map((row) => row.v)).toEqual([1, 2]);
  });

  it('parks under park-ordered names and leaves a kept copy alone', () => {
    write([{ id: 'a', v: 1 }]);
    let names: string[] = [];
    setAppendOnlyStoreTestHooks({
      beforeWriteSurvivors: (staging) => {
        names = staging.map((copy) => path.basename(copy));
        // Force a merge round: a writer recreates the live file before the publish.
        if (staging.length === 1)
          safeAppendFileSync(live, `${JSON.stringify({ id: 'b', v: 1 })}\n`);
      },
    });
    compactStoreByKey(live, { key: 'id', archiveDir: null });
    expect(names).toHaveLength(2);
    for (const name of names) {
      expect(name).toMatch(
        new RegExp(`^store\\.jsonl\\.compacting-t\\d{15}-\\d{6}-${process.pid}-`)
      );
    }
    expect([...names].sort()).toEqual(names);
    // A copy kept by an earlier failed rewrite survives a later compaction.
    const kept = `${live}.compacting-kept`;
    safeWriteFile(kept, `${JSON.stringify({ id: 'a', v: 0 })}\n`);
    setAppendOnlyStoreTestHooks({});
    compactStoreByKey(live, { key: 'id', archiveDir: null });
    expect(safeReaddir(dir).filter((name) => name.includes('.compacting-'))).toEqual([
      'store.jsonl.compacting-kept',
    ]);
  });

  it('bypasses the incremental cache while parked copies exist and collapses repeated rows', () => {
    write([
      { id: 'k1', v: 1 },
      { id: 'k1', v: 2 },
    ]);
    expect(readJsonLinesCachedAcrossCompaction<Row>(live)).toHaveLength(2); // primes the cache
    let seen: Row[] | undefined;
    setAppendOnlyStoreTestHooks({
      beforeWriteSurvivors: () => {
        if (seen) return;
        safeAppendFileSync(live, `${JSON.stringify({ id: 'k2', v: 1 })}\n`);
        seen = readJsonLinesCachedAcrossCompaction<Row>(live);
      },
    });
    compactStoreByKey(live, { key: 'id', archiveDir: null });
    expect(seen).toEqual([
      { id: 'k1', v: 1 },
      { id: 'k1', v: 2 },
      { id: 'k2', v: 1 },
    ]);
    // Published and cleaned up: the cached path again, on the folded file.
    expect(readJsonLinesCachedAcrossCompaction<Row>(live)).toEqual([
      { id: 'k1', v: 2 },
      { id: 'k2', v: 1 },
    ]);
    // A leftover copy repeating live rows does not double them.
    safeWriteFile(
      `${live}.compacting-t000000000000001-000000-1-initial`,
      `${JSON.stringify({ id: 'k1', v: 2 })}\n`
    );
    expect(readJsonLinesCachedAcrossCompaction<Row>(live)).toEqual([
      { id: 'k1', v: 2 },
      { id: 'k2', v: 1 },
    ]);
  });
});
