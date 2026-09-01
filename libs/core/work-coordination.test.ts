import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeSymlinkSync, safeWriteFile } from './secure-io.js';

import {
  claimWorkItem,
  clearWorkCoordinationStore,
  clearWorkCoordinationNamespace,
  createBoard,
  createWorkItem,
  getBoard,
  listBoardItems,
  listBoards,
  listCoordinationEvents,
  listWorkItemAttempts,
  listWorkItems,
  releaseWorkItem,
  renewWorkItemLease,
  reapExpiredWorkLeases,
  handoffWorkItem,
  importExternalWorkItem,
  setWorkCoordinationNamespace,
  updateWorkItem,
  recordMissionHandoff,
} from './work-coordination.js';
import { buildHandoffPacket } from './handoff-packet.js';

beforeEach(() => {
  setWorkCoordinationNamespace('work-coordination-core-test');
  clearWorkCoordinationStore();
});

afterEach(() => {
  clearWorkCoordinationStore();
  clearWorkCoordinationNamespace();
});

describe('work coordination', () => {
  it('rejects a namespace that can escape the coordination root', () => {
    expect(() => setWorkCoordinationNamespace('../outside')).toThrow(/invalid work coordination/);
  });

  it('rejects a symlinked coordination store leaf', () => {
    const runtimeDir = pathResolver.rootResolve(
      'active/shared/runtime/work-coordination/work-coordination-core-test'
    );
    const target = `${runtimeDir}/items-target.jsonl`;
    const link = `${runtimeDir}/items.jsonl`;
    safeMkdir(runtimeDir, { recursive: true });
    safeWriteFile(target, '');
    safeSymlinkSync(target, link);

    expect(() => listWorkItems()).toThrow('[RESOURCE_PATH_SYMLINK]');
  });

  it('keeps the canonical context chain when an external item is updated', () => {
    const first = importExternalWorkItem({
      source: 'github',
      sourceRef: 'issue-ctx-1',
      title: 'Context-bearing issue',
      description: 'Imported once',
      status: 'backlog',
      projectId: 'PRJ-CTX',
      context: {
        organization_id: 'ORG-CTX',
        tenant_slug: 'tenant-ctx',
        mission_id: 'MSN-CTX',
        project_id: 'PRJ-CTX',
        task_id: 'TASK-CTX',
        work_shape: 'improvement_experiment',
      },
    });

    const updated = importExternalWorkItem({
      source: 'github',
      sourceRef: 'issue-ctx-1',
      title: 'Context-bearing issue updated',
      description: 'Imported twice',
      status: 'ready',
      projectId: 'PRJ-CTX',
    });

    expect(updated.item_id).toBe(first.item_id);
    expect(updated.context).toEqual(first.context);
  });

  it('records mission handoff metadata and coordination event', () => {
    createWorkItem({
      itemId: 'mission-item-1',
      title: 'Mission task',
      description: 'Mission task description',
      projectId: 'M-HANDOFF',
      metadata: { mission_id: 'M-HANDOFF', task_id: 'task-1' },
    });
    const packet = buildHandoffPacket({
      kind: 'mission',
      correlationId: 'handoff-1',
      outgoingSummary: 'Continue mission',
      sourceRef: 'persona:worker',
      targetRef: 'persona:reviewer',
    });
    const updated = recordMissionHandoff({
      missionId: 'M-HANDOFF',
      fromPersona: 'worker',
      toPersona: 'reviewer',
      handoffPacket: packet,
    });
    expect(updated[0].metadata).toMatchObject({
      handoff_status: 'written',
      handoff_to_persona: 'reviewer',
    });
    expect(listCoordinationEvents({ event_type: 'mission_handoff_written' })).toHaveLength(1);
  });

  it('creates and lists work items', () => {
    const item = createWorkItem({
      title: 'Ship coordination kernel',
      description: 'Implement local work item storage and lease control',
      projectId: 'PRJ-1',
      labels: ['coordination', 'core'],
    });

    const items = listWorkItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      item_id: item.item_id,
      title: 'Ship coordination kernel',
      status: 'backlog',
      project_id: 'PRJ-1',
    });
    expect(listCoordinationEvents()).toHaveLength(1);
  });

  it('creates boards and filters items by board definition', () => {
    createBoard({
      boardId: 'project-1',
      name: 'Project 1',
      type: 'project',
      filters: { project_id: 'PRJ-1' },
      sortBy: 'updated_at',
    });
    createBoard({
      boardId: 'personal-todo',
      name: 'Personal TODO',
      type: 'personal',
      filters: { assignee_user_id: 'user-1' },
    });

    const first = createWorkItem({
      title: 'Project item',
      description: 'Belongs to project',
      projectId: 'PRJ-1',
    });
    createWorkItem({
      title: 'Personal item',
      description: 'Belongs to a person',
      projectId: 'PRJ-2',
      assigneeUserId: 'user-1',
    });

    expect(getBoard('project-1')).toMatchObject({ board_id: 'project-1' });
    expect(listBoards()).toHaveLength(2);
    expect(listBoardItems('project-1')).toHaveLength(1);
    expect(listBoardItems('project-1')[0]).toMatchObject({ item_id: first.item_id });
    expect(listBoardItems('personal-todo')).toHaveLength(1);
  });

  it('slugifies board ids from names when boardId is omitted', () => {
    const board = createBoard({
      name: 'Roadmap Review Board',
      type: 'project',
      filters: {},
    });

    expect(board.board_id).toBe('roadmap-review-board');
  });

  it('claims, releases, and hands off leases with version checks', () => {
    const item = createWorkItem({
      title: 'Implement claim logic',
      description: 'This item will be leased and transferred',
      projectId: 'PRJ-1',
    });

    const claimed = claimWorkItem({
      itemId: item.item_id,
      actorPeerId: 'peer-a',
      actorUserId: 'user-a',
      purpose: 'implementation',
      ttlMs: 60_000,
      expectedVersion: 1,
      idempotencyKey: 'claim-1',
    });

    expect(claimed.item.version).toBe(2);
    expect(claimed.item.status).toBe('in_progress');
    expect(claimed.item.lease_id).toBe(claimed.lease.lease_id);
    expect(listWorkItemAttempts(item.item_id)).toHaveLength(1);
    expect(listWorkItemAttempts(item.item_id)[0]).toMatchObject({
      status: 'running',
      lease_id: claimed.lease.lease_id,
    });

    expect(() =>
      claimWorkItem({
        itemId: item.item_id,
        actorPeerId: 'peer-b',
        purpose: 'implementation',
        expectedVersion: 2,
      })
    ).toThrowError(/lease/i);

    const handed = handoffWorkItem({
      itemId: claimed.item.item_id,
      fromLeaseId: claimed.lease.lease_id,
      fromPeerId: 'peer-a',
      toPeerId: 'peer-b',
      toUserId: 'user-b',
      purpose: 'implementation',
      ttlMs: 60_000,
      expectedVersion: 2,
      idempotencyKey: 'handoff-1',
    });

    expect(handed.item.status).toBe('in_progress');
    expect(handed.item.lease_id).toBe(handed.toLease.lease_id);
    expect(listCoordinationEvents().some((event) => event.event_type === 'item_handed_off')).toBe(
      true
    );
    expect(listCoordinationEvents({ event_type: 'handoff_written' })).toHaveLength(1);
    expect(listCoordinationEvents({ event_type: 'handoff_consumed' })).toHaveLength(1);
    expect(listWorkItemAttempts(item.item_id)).toHaveLength(2);
    expect(listWorkItemAttempts(item.item_id)[0]).toMatchObject({
      status: 'released',
      summary: expect.any(String),
    });
    expect(listWorkItemAttempts(item.item_id)[1]).toMatchObject({
      status: 'running',
      lease_id: handed.toLease.lease_id,
      metadata: expect.objectContaining({
        handoff_packet: expect.objectContaining({
          kind: 'work_item',
          work_item_id: item.item_id,
          correlation_id: 'handoff-1',
          source_ref: 'peer:peer-a',
          target_ref: 'peer:peer-b',
        }),
      }),
    });

    const released = releaseWorkItem({
      itemId: handed.item.item_id,
      leaseId: handed.toLease.lease_id,
      actorPeerId: 'peer-b',
      actorUserId: 'user-b',
      expectedVersion: handed.item.version,
      nextStatus: 'ready',
    });

    expect(released.item.status).toBe('ready');
    expect(released.item.lease_id).toBeUndefined();
    expect(listWorkItemAttempts(item.item_id)).toHaveLength(2);
    expect(listWorkItemAttempts(item.item_id)[1]).toMatchObject({
      status: 'released',
    });
  });

  it('updates items and clears leases for terminal statuses', () => {
    const item = createWorkItem({
      title: 'Close work item',
      description: 'A terminal update should release the lease',
      projectId: 'PRJ-1',
    });
    const claimed = claimWorkItem({
      itemId: item.item_id,
      actorPeerId: 'peer-a',
      purpose: 'implementation',
      ttlMs: 60_000,
      expectedVersion: 1,
    });

    const updated = updateWorkItem({
      itemId: item.item_id,
      expectedVersion: 2,
      status: 'done',
    });

    expect(updated.status).toBe('done');
    expect(updated.lease_id).toBeUndefined();
    expect(listWorkItems()[0].status).toBe('done');
    expect(
      listCoordinationEvents().some(
        (event) => event.event_type === 'item_released' && event.item_id === item.item_id
      )
    ).toBe(true);
    expect(listWorkItemAttempts(item.item_id)[0]).toMatchObject({
      status: 'completed',
    });
    expect(() =>
      releaseWorkItem({
        itemId: item.item_id,
        leaseId: claimed.lease.lease_id,
        actorPeerId: 'peer-a',
        expectedVersion: 3,
        nextStatus: 'ready',
      })
    ).toThrowError(/lease/i);
  });

  describe('QM-01 lease reaping and poison-pill parking', () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const makeItem = () =>
      createWorkItem({
        title: 'Reap target',
        description: 'lease semantics test',
        projectId: 'PRJ-REAP',
      });

    it('refuses renewal by a non-holder', async () => {
      const item = makeItem();
      const { lease } = claimWorkItem({
        itemId: item.item_id,
        actorPeerId: 'peer-a',
        purpose: 'work',
      });
      expect(() =>
        renewWorkItemLease({ leaseId: lease.lease_id, actorPeerId: 'peer-b' })
      ).toThrowError(/holder mismatch/i);
      expect(renewWorkItemLease({ leaseId: lease.lease_id, actorPeerId: 'peer-a' }).lease_id).toBe(
        lease.lease_id
      );
    });

    it('refuses renewal of a lapsed lease', async () => {
      const item = makeItem();
      const { lease } = claimWorkItem({
        itemId: item.item_id,
        actorPeerId: 'peer-a',
        purpose: 'work',
        ttlMs: 1,
      });
      await sleep(10);
      expect(() => renewWorkItemLease({ leaseId: lease.lease_id })).toThrowError(/lapsed/i);
    });

    it('recovers a stranded in_progress item back to ready', async () => {
      const item = makeItem();
      claimWorkItem({ itemId: item.item_id, actorPeerId: 'peer-a', purpose: 'work', ttlMs: 1 });
      await sleep(10);
      expect(listWorkItems()[0].status).toBe('in_progress');

      const result = reapExpiredWorkLeases();
      expect(result.recovered.map((i) => i.item_id)).toContain(item.item_id);
      const after = listWorkItems()[0];
      expect(after.status).toBe('ready');
      expect(after.lease_id).toBeUndefined();
      expect(after.claimed_by_peer_id).toBeUndefined();
      expect(listWorkItemAttempts(item.item_id)[0]).toMatchObject({
        status: 'released',
        failure_reason: 'lease_expired',
      });
    });

    it('replays durable completion evidence instead of discarding an orphan result', async () => {
      const item = makeItem();
      claimWorkItem({ itemId: item.item_id, actorPeerId: 'peer-a', purpose: 'work', ttlMs: 1 });
      await sleep(10);
      const result = reapExpiredWorkLeases({ completedEvidence: () => true });
      expect(result.replayed.map((entry) => entry.item_id)).toContain(item.item_id);
      expect(listWorkItems()[0]).toMatchObject({ status: 'done', metadata: { replayed: true } });
      expect(listWorkItemAttempts(item.item_id)[0].status).toBe('completed');
    });

    it('does not treat worker-controlled metadata as completion evidence', async () => {
      const item = createWorkItem({
        title: 'Untrusted evidence target',
        description: 'metadata must not complete an orphaned item',
        projectId: 'PRJ-REAP',
        metadata: { completed_evidence: true },
      });
      claimWorkItem({ itemId: item.item_id, actorPeerId: 'peer-a', purpose: 'work', ttlMs: 1 });
      await sleep(10);
      const result = reapExpiredWorkLeases();
      expect(result.replayed).toHaveLength(0);
      expect(result.recovered.map((entry) => entry.item_id)).toContain(item.item_id);
      expect(listWorkItems().find((entry) => entry.item_id === item.item_id)?.status).toBe('ready');
    });

    it('a zombie holder cannot release after the item was re-claimed', async () => {
      const item = makeItem();
      const zombie = claimWorkItem({
        itemId: item.item_id,
        actorPeerId: 'peer-a',
        purpose: 'work',
        ttlMs: 1,
      });
      await sleep(10);
      reapExpiredWorkLeases();
      const fresh = claimWorkItem({ itemId: item.item_id, actorPeerId: 'peer-b', purpose: 'work' });
      expect(() =>
        releaseWorkItem({
          itemId: item.item_id,
          leaseId: zombie.lease.lease_id,
          actorPeerId: 'peer-a',
        })
      ).toThrowError(/lease/i);
      expect(
        releaseWorkItem({
          itemId: item.item_id,
          leaseId: fresh.lease.lease_id,
          actorPeerId: 'peer-b',
          nextStatus: 'done',
        }).item.status
      ).toBe('done');
    });

    it('parks a crash-looping item after its attempt budget is exhausted', async () => {
      const item = makeItem();
      for (let round = 0; round < 3; round++) {
        claimWorkItem({ itemId: item.item_id, actorPeerId: 'peer-a', purpose: 'work', ttlMs: 1 });
        await sleep(10);
        const result = reapExpiredWorkLeases({ maxErrorAttempts: 3 });
        if (round < 2) {
          expect(result.parked).toHaveLength(0);
          expect(listWorkItems()[0].status).toBe('ready');
        } else {
          expect(result.parked.map((i) => i.item_id)).toContain(item.item_id);
        }
      }
      const after = listWorkItems()[0];
      expect(after.status).toBe('blocked');
      expect(after.metadata).toMatchObject({ parked: true });
      expect(String(after.metadata?.parked_reason)).toMatch(/attempt budget exhausted/);
      expect(
        listCoordinationEvents().some(
          (event) => event.event_type === 'item_blocked' && event.item_id === item.item_id
        )
      ).toBe(true);
    });
  });
});
