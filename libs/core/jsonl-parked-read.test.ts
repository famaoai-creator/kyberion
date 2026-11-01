import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { sharedTmp } from './path-resolver.js';
import {
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeRmSync,
  safeWriteFile,
} from './secure-io.js';
import { compactStoreByKey, setAppendOnlyStoreTestHooks } from './append-only-store.js';
import { parkedCompactionCopies, streamJsonLinesAcrossCompaction } from './jsonl-parked-read.js';

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
});
