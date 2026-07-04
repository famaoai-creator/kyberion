import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
  handoffWorkItem,
  setWorkCoordinationNamespace,
  updateWorkItem,
} from './work-coordination.js';

beforeEach(() => {
  setWorkCoordinationNamespace('work-coordination-core-test');
  clearWorkCoordinationStore();
});

afterEach(() => {
  clearWorkCoordinationStore();
  clearWorkCoordinationNamespace();
});

describe('work coordination', () => {
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
});
