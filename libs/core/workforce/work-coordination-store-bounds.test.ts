import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { withExecutionContext } from '../authority.js';
import {
  safeAppendFileSync,
  safeExistsSync,
  safeMoveSync,
  safeReadFile,
  safeReaddir,
  safeRmSync,
} from '../secure-io.js';
import { validateWritePermission } from '../tier-guard.js';
import { WORK_COORDINATION_ROOT_PATH } from '../foundation/runtime-state-roots.js';
import { resetAppendOnlyStoreMaintenanceState } from '../append-only-store.js';
import {
  claimWorkItem,
  createWorkItemIfAbsent,
  getWorkItem,
  listCoordinationEvents,
  listWorkItems,
  readWorkItemInventory,
  renewWorkItemLease,
  updateWorkItem,
} from './work-coordination.js';
import {
  coordinationCompactionArchiveDir,
  currentLeaseForItem,
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
      // The pre-compaction union is archived next to the store, and no
      // staging copy leaked (a failed archive write keeps every copy).
      const archiveDir = path.join(path.dirname(itemsPath()), 'compaction-archive');
      expect(coordinationCompactionArchiveDir(itemsPath())).toBe(archiveDir);
      expect(safeReaddir(archiveDir).some((name) => name.startsWith('items.'))).toBe(true);
      expect(
        safeReaddir(path.dirname(itemsPath())).filter((name) => name.includes('.compacting-'))
      ).toEqual([]);
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

  it('archives where the fence role may write in the production layout', () => {
    // The fixture root lives under active/shared/tmp/, which every role may
    // write, so the compaction tests above cannot catch an archive directory
    // the production writer is denied. Check the production store paths
    // against the role the mutation fence runs as.
    const root = pathResolver.rootDir();
    for (const store of ['items.jsonl', 'leases.jsonl']) {
      const file = path.join(root, WORK_COORDINATION_ROOT_PATH, store);
      const archived = path.join(coordinationCompactionArchiveDir(file), `${store}.x.jsonl`);
      const verdict = withExecutionContext('infrastructure_sentinel', () =>
        validateWritePermission(archived, 'write')
      );
      expect(verdict, `${archived}: ${verdict.reason ?? ''}`).toMatchObject({ allowed: true });
    }
    // The janitor's archive root is not writable by the fence role.
    const janitorArchive = path.join(
      root,
      'active/archive/jsonl-compaction',
      WORK_COORDINATION_ROOT_PATH,
      'items.x.jsonl'
    );
    expect(
      withExecutionContext('infrastructure_sentinel', () =>
        validateWritePermission(janitorArchive, 'write')
      ).allowed
    ).toBe(false);
  });

  it('readers outside the fence see items and leases while another process has them parked', () => {
    inRoot(() => {
      createWorkItemIfAbsent({
        itemId: 'parked',
        title: 'parked',
        description: 'd',
        status: 'ready',
        rootDir: fixtureRoot,
      });
      const { lease } = claimWorkItem({
        itemId: 'parked',
        actorPeerId: 'peer-a',
        purpose: 'test',
        ttlMs: 60_000,
      });
      // Simulate another process mid-compaction: both stores moved aside.
      withExecutionContext('infrastructure_sentinel', () => {
        safeMoveSync(itemsPath(), `${itemsPath()}.compacting-999999-0-initial`);
        safeMoveSync(leasesPath(), `${leasesPath()}.compacting-999999-0-initial`);
      });
      expect(safeExistsSync(itemsPath())).toBe(false);
      expect(listWorkItems({}, { rootDir: fixtureRoot }).map((item) => item.item_id)).toEqual([
        'parked',
      ]);
      expect(currentLeaseForItem('parked')?.lease_id).toBe(lease.lease_id);
      const inventory = readWorkItemInventory({ rootDir: fixtureRoot });
      expect(inventory.present).toBe(true);
      expect(inventory.items.map((item) => item.item_id)).toEqual(['parked']);
    });
  });
});
