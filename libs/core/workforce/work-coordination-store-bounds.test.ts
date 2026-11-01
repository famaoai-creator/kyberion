import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { withExecutionContext } from '../authority.js';
import { safeAppendFileSync, safeReadFile, safeReaddir, safeRmSync } from '../secure-io.js';
import { resetAppendOnlyStoreMaintenanceState } from '../append-only-store.js';
import {
  claimWorkItem,
  createWorkItemIfAbsent,
  getWorkItem,
  listCoordinationEvents,
  listWorkItems,
  renewWorkItemLease,
  updateWorkItem,
} from './work-coordination.js';
import {
  currentLeaseRecords,
  eventsPath,
  itemsPath,
  leasesPath,
  setWorkCoordinationStoreTuningForTests,
  withCoordinationRoot,
  workItemCompactionKey,
} from './work-coordination-ledger.js';
import type { WorkItem } from './work-coordination-types.js';

let fixtureRoot: string;

const lines = (file: string): string[] =>
  String(safeReadFile(file, { encoding: 'utf8' }))
    .split('\n')
    .filter((line) => line.trim());

const inRoot = <T>(fn: () => T): T => withCoordinationRoot(fixtureRoot, fn);

beforeEach(() => {
  fixtureRoot = pathResolver.sharedTmp(`work-coordination-bounds-${randomUUID()}`);
  resetAppendOnlyStoreMaintenanceState();
});

afterEach(() => {
  setWorkCoordinationStoreTuningForTests({});
  resetAppendOnlyStoreMaintenanceState();
  safeRmSync(fixtureRoot, { recursive: true, force: true });
});

describe('work-coordination write-time compaction', () => {
  it('keeps creation snapshots verbatim and folds later versions per item', () => {
    expect(workItemCompactionKey({ item_id: 'a', version: 1 })).toBeUndefined();
    expect(workItemCompactionKey({ item_id: 'a', version: 2 })).toBe('a');
    expect(workItemCompactionKey({ version: 3 })).toBeUndefined();
  });

  it('folds items.jsonl above an injected threshold without changing what readers see', () => {
    // A threshold far above the fixture: nothing compacts, so this is the
    // full-history baseline the compacted store must reproduce.
    const run = (threshold: number) => {
      setWorkCoordinationStoreTuningForTests({ itemsCompactMinBytes: threshold, chunkBytes: 256 });
      resetAppendOnlyStoreMaintenanceState();
      return inRoot(() => {
        const ids = ['bounds-a', 'bounds-b', 'bounds-c'];
        for (const itemId of ids) {
          createWorkItemIfAbsent({
            itemId,
            title: itemId,
            description: 'd',
            status: 'ready',
            rootDir: fixtureRoot,
          });
        }
        for (let round = 0; round < 6; round++) {
          for (const itemId of ids) {
            updateWorkItem({
              rootDir: fixtureRoot,
              itemId,
              metadata: { round: String(round), pad: 'x'.repeat(200) },
            });
          }
        }
        return {
          lines: lines(itemsPath()).length,
          items: listWorkItems({}, { rootDir: fixtureRoot }).map((item) => ({
            item_id: item.item_id,
            version: item.version,
            metadata: item.metadata,
          })),
        };
      });
    };
    const baseline = run(1024 * 1024 * 1024);
    safeRmSync(fixtureRoot, { recursive: true, force: true });
    const compacted = run(2048);
    expect(compacted.lines).toBeLessThan(baseline.lines);
    expect(compacted.items).toEqual(baseline.items);
    inRoot(() => {
      // Creation identity survives compaction: replay returns the latest
      // state, a different creation still conflicts.
      const replay = createWorkItemIfAbsent({
        itemId: 'bounds-a',
        title: 'bounds-a',
        description: 'd',
        status: 'ready',
        rootDir: fixtureRoot,
      });
      expect(replay.version).toBe(7);
      expect(() =>
        createWorkItemIfAbsent({
          itemId: 'bounds-a',
          title: 'other',
          description: 'd',
          status: 'ready',
          rootDir: fixtureRoot,
        })
      ).toThrow(/identity conflict/);
      const records = lines(itemsPath()).map((line) => JSON.parse(line) as WorkItem);
      expect(records.filter((record) => record.version === 1)).toHaveLength(3);
      // The pre-compaction union is archived under the coordination root.
      const archiveDir = path.join(
        fixtureRoot,
        'active/archive/jsonl-compaction',
        path.dirname(path.relative(fixtureRoot, itemsPath()))
      );
      expect(safeReaddir(archiveDir).some((name) => name.startsWith('items.'))).toBe(true);
    });
  });

  it('folds leases.jsonl to the latest record per lease_id', () => {
    setWorkCoordinationStoreTuningForTests({ leasesCompactMinBytes: 512 });
    inRoot(() => {
      createWorkItemIfAbsent({
        itemId: 'lease-item',
        title: 'lease-item',
        description: 'd',
        status: 'ready',
        rootDir: fixtureRoot,
      });
      const { lease } = claimWorkItem({
        itemId: 'lease-item',
        actorPeerId: 'peer-a',
        purpose: 'test',
        ttlMs: 60_000,
      });
      let renewed = lease;
      for (let i = 0; i < 8; i++) {
        renewed = renewWorkItemLease({ leaseId: lease.lease_id, ttlMs: 60_000 + i });
      }
      expect(lines(leasesPath()).length).toBeLessThan(9);
      const latest = currentLeaseRecords();
      expect(latest).toHaveLength(1);
      expect(latest[0]).toMatchObject({ lease_id: lease.lease_id, renewed_at: renewed.renewed_at });
      expect(latest[0]?.expires_at).toBe(renewed.expires_at);
    });
  });

  it('fails closed on a torn item record but skips a torn event line', () => {
    inRoot(() => {
      createWorkItemIfAbsent({
        itemId: 'torn',
        title: 'torn',
        description: 'd',
        status: 'ready',
        rootDir: fixtureRoot,
      });
      const eventsFile = eventsPath();
      withExecutionContext('infrastructure_sentinel', () => {
        safeAppendFileSync(eventsFile, '{"event_id":"wce-torn","ev');
      });
      // The observability feed is tolerant: the torn tail is skipped.
      expect(listCoordinationEvents({ item_id: 'torn' })).toHaveLength(1);
      withExecutionContext('infrastructure_sentinel', () => {
        safeAppendFileSync(itemsPath(), '{"item_id":"torn","version":2,"stat');
      });
      // The item store is a correctness store: an unverifiable record fails closed.
      expect(() => getWorkItem('torn', { rootDir: fixtureRoot })).toThrow();
    });
  });
});
