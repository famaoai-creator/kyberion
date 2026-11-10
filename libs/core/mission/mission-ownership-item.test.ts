import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearWorkCoordinationNamespace,
  clearWorkCoordinationStore,
  createWorkItem,
  getWorkItem,
  listWorkItems,
  setWorkCoordinationNamespace,
} from '../workforce/work-coordination.js';
import {
  deriveMissionOwnershipItemId,
  ensureMissionOwnershipWorkItem,
  migrateMissionTaskWorkItemParents,
  resolveMissionTaskParentItemId,
} from './mission-ownership-item.js';
import { deriveMissionOwnershipItemId as fromOrchestratorSession } from './orchestrator-session.js';

beforeEach(() => {
  setWorkCoordinationNamespace('mission-ownership-item-test');
  clearWorkCoordinationStore();
});

afterEach(() => {
  clearWorkCoordinationStore();
  clearWorkCoordinationNamespace();
});

function taskItem(itemId: string, missionId: string, extra: Record<string, unknown> = {}) {
  return createWorkItem({
    itemId,
    title: itemId,
    description: itemId,
    context: { mission_id: missionId, task_id: itemId, ...(extra.context as object) },
  });
}

describe('mission ownership item as the mission Issue (D1)', () => {
  it('keeps one id derivation for orchestrator sessions and task parents', () => {
    expect(fromOrchestratorSession('msn-a')).toBe('mission-ownership:MSN-A');
    expect(deriveMissionOwnershipItemId('msn-a')).toBe('mission-ownership:MSN-A');
  });

  it('creates the ownership item once, top-level, with the first task scope', () => {
    const first = ensureMissionOwnershipWorkItem('msn-a', { tenant_slug: 'tenant-a' });
    expect(first).toMatchObject({
      item_id: 'mission-ownership:MSN-A',
      context: { tenant_slug: 'tenant-a' },
      metadata: { mission_id: 'MSN-A', kind: 'mission_ownership' },
    });
    expect(first.parent_item_id).toBeUndefined();
    const again = ensureMissionOwnershipWorkItem('MSN-A', { tenant_slug: 'tenant-b' });
    expect(again.version).toBe(first.version);
    expect(again.context?.tenant_slug).toBe('tenant-a');
  });

  it('resolves the parent for a task in the same scope and leaves a cross-tenant task top-level', () => {
    expect(resolveMissionTaskParentItemId('MSN-B', { mission_id: 'MSN-B', task_id: 'T1' })).toBe(
      'mission-ownership:MSN-B'
    );
    expect(
      resolveMissionTaskParentItemId('MSN-B', {
        mission_id: 'MSN-B',
        task_id: 'T2',
        tenant_slug: 'tenant-a',
      })
    ).toBeUndefined();
  });
});

describe('migrateMissionTaskWorkItemParents', () => {
  it('backfills mission task items: dry run first, apply writes, then idempotent', () => {
    ensureMissionOwnershipWorkItem('MSN-M');
    taskItem('t1', 'MSN-M');
    taskItem('t2', 'MSN-M');
    taskItem('t-no-owner', 'MSN-NONE');
    taskItem('t-tenant', 'MSN-M', { context: { tenant_slug: 'tenant-a' } });
    createWorkItem({
      itemId: 'issue-level',
      title: 'discussion outcome',
      description: 'mission-scoped Issue without a task',
      context: { mission_id: 'MSN-M' },
    });

    const dry = migrateMissionTaskWorkItemParents();
    expect(dry.migrated).toEqual([]);
    expect([...dry.remaining].sort()).toEqual(['t1', 't2']);
    expect(dry.skipped).toEqual(
      expect.arrayContaining([
        { item_id: 't-no-owner', reason: 'no_ownership_item' },
        { item_id: 't-tenant', reason: 'scope_mismatch' },
      ])
    );
    expect(getWorkItem('t1')?.parent_item_id).toBeUndefined();

    const applied = migrateMissionTaskWorkItemParents({ apply: true });
    expect([...applied.migrated].sort()).toEqual(['t1', 't2']);
    expect(getWorkItem('t1')?.parent_item_id).toBe('mission-ownership:MSN-M');
    expect(getWorkItem('issue-level')?.parent_item_id).toBeUndefined();
    expect(
      listWorkItems({ parentItemId: 'mission-ownership:MSN-M' })
        .map((item) => item.item_id)
        .sort()
    ).toEqual(['t1', 't2']);

    const rerun = migrateMissionTaskWorkItemParents({ apply: true });
    expect(rerun.migrated).toEqual([]);
    expect(rerun.remaining).toEqual([]);
  });
});
