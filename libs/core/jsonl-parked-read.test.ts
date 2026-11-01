import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { sharedTmp } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
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
});
