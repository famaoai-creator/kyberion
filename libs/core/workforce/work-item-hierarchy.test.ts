import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearWorkCoordinationNamespace,
  clearWorkCoordinationStore,
  createWorkItem,
  createWorkItemIfAbsent,
  getWorkItem,
  importExternalWorkItem,
  listWorkItems,
  setWorkCoordinationNamespace,
  updateWorkItem,
} from './work-coordination.js';
import {
  aggregateParentStatus,
  isTopLevelWorkItem,
  MAX_WORK_ITEM_DEPTH,
  sharesWorkItemTenantScope,
} from './work-item-hierarchy.js';
import type { WorkItemStatus } from './work-coordination-types.js';

beforeEach(() => {
  setWorkCoordinationNamespace('work-item-hierarchy-test');
  clearWorkCoordinationStore();
});

afterEach(() => {
  clearWorkCoordinationStore();
  clearWorkCoordinationNamespace();
});

function item(itemId: string, extra: Record<string, unknown> = {}) {
  return createWorkItem({ itemId, title: itemId, description: itemId, ...extra });
}

describe('work item hierarchy (D1)', () => {
  it('persists parent_item_id on a child and leaves an Issue top-level', () => {
    const issue = item('issue');
    const step = item('step', { parentItemId: 'issue' });
    expect(issue.parent_item_id).toBeUndefined();
    expect(isTopLevelWorkItem(issue)).toBe(true);
    expect(step.parent_item_id).toBe('issue');
    expect(getWorkItem('step')?.parent_item_id).toBe('issue');
    expect(isTopLevelWorkItem(step)).toBe(false);
  });

  it('rejects an unknown parent, a self parent and a cross-tenant parent', () => {
    expect(() => item('orphan', { parentItemId: 'missing' })).toThrow(/parent work item not found/);
    expect(() => item('self', { parentItemId: 'self' })).toThrow(/its own parent/);
    item('tenant-a-issue', { context: { tenant_slug: 'tenant-a' } });
    expect(() =>
      item('tenant-b-step', {
        parentItemId: 'tenant-a-issue',
        context: { tenant_slug: 'tenant-b' },
      })
    ).toThrow(/outside the tenant scope/);
    expect(() => item('system-step', { parentItemId: 'tenant-a-issue' })).toThrow(
      /outside the tenant scope/
    );
    expect(getWorkItem('tenant-b-step')).toBeNull();
  });

  it('lets a tenant-level Issue own a step inside one of its organizations, never another one', () => {
    item('tenant-issue', { context: { tenant_slug: 'tenant-a' } });
    item('org-issue', { context: { tenant_slug: 'tenant-a', organization_id: 'org-1' } });
    expect(
      item('org-step', {
        parentItemId: 'tenant-issue',
        context: { tenant_slug: 'tenant-a', organization_id: 'org-1' },
      }).parent_item_id
    ).toBe('tenant-issue');
    expect(() =>
      item('other-org-step', {
        parentItemId: 'org-issue',
        context: { tenant_slug: 'tenant-a', organization_id: 'org-2' },
      })
    ).toThrow(/outside the tenant scope/);
  });

  it('refuses a cycle and a chain deeper than the limit through update', () => {
    item('a');
    item('b', { parentItemId: 'a' });
    const a = getWorkItem('a')!;
    expect(() =>
      updateWorkItem({ itemId: 'a', expectedVersion: a.version, parentItemId: 'b' })
    ).toThrow(/cycle/);
    for (let index = 0; index < MAX_WORK_ITEM_DEPTH; index += 1) {
      item(`chain-${index}`, index === 0 ? {} : { parentItemId: `chain-${index - 1}` });
    }
    expect(() => item('too-deep', { parentItemId: `chain-${MAX_WORK_ITEM_DEPTH - 1}` })).toThrow(
      /deeper than/
    );
  });

  it('attaches, keeps and detaches a parent through update', () => {
    item('issue');
    const step = item('step');
    const linked = updateWorkItem({
      itemId: 'step',
      expectedVersion: step.version,
      parentItemId: 'issue',
    });
    expect(linked.parent_item_id).toBe('issue');
    const kept = updateWorkItem({ itemId: 'step', expectedVersion: linked.version, title: 'x' });
    expect(kept.parent_item_id).toBe('issue');
    const detached = updateWorkItem({
      itemId: 'step',
      expectedVersion: kept.version,
      parentItemId: null,
    });
    expect(detached.parent_item_id).toBeUndefined();
    expect(getWorkItem('step')?.parent_item_id).toBeUndefined();
  });

  it('refuses a scope change that would strand a child in another tenant', () => {
    const issue = item('issue', { context: { tenant_slug: 'tenant-a' } });
    item('step', { parentItemId: 'issue', context: { tenant_slug: 'tenant-a' } });
    expect(() =>
      updateWorkItem({
        itemId: 'issue',
        expectedVersion: issue.version,
        context: { tenant_slug: 'tenant-b' },
      })
    ).toThrow(/out of the tenant scope of its child/);
  });

  it('filters top-level items and the children of one parent; defaults list everything', () => {
    item('issue-1');
    item('issue-2');
    item('step-1a', { parentItemId: 'issue-1' });
    item('step-1b', { parentItemId: 'issue-1' });
    item('step-2a', { parentItemId: 'issue-2' });
    const ids = (filter: Parameters<typeof listWorkItems>[0]) =>
      listWorkItems(filter)
        .map((entry) => entry.item_id)
        .sort();
    expect(ids({})).toHaveLength(5);
    expect(ids({ topLevelOnly: true })).toEqual(['issue-1', 'issue-2']);
    expect(ids({ parentItemId: 'issue-1' })).toEqual(['step-1a', 'step-1b']);
  });

  it('imports a step with its parent and keeps the parent on a re-sync that omits it', () => {
    item('issue');
    const imported = importExternalWorkItem({
      source: 'local',
      sourceRef: 'mission:MSN-X:T1',
      title: 'T1',
      description: 'T1',
      status: 'ready',
      parentItemId: 'issue',
    });
    expect(imported.parent_item_id).toBe('issue');
    const resynced = importExternalWorkItem({
      source: 'local',
      sourceRef: 'mission:MSN-X:T1',
      title: 'T1 renamed',
      description: 'T1',
      status: 'ready',
    });
    expect(resynced.item_id).toBe(imported.item_id);
    expect(resynced.parent_item_id).toBe('issue');
  });

  it('treats a later parent link as structure, so the original creation still replays', () => {
    item('issue');
    const input = { itemId: 'replayed', title: 'r', description: 'r' };
    const created = createWorkItemIfAbsent(input);
    updateWorkItem({ itemId: 'replayed', expectedVersion: created.version, parentItemId: 'issue' });
    expect(createWorkItemIfAbsent(input).parent_item_id).toBe('issue');
    expect(createWorkItemIfAbsent({ ...input, parentItemId: 'issue' }).item_id).toBe('replayed');
  });
});

describe('sharesWorkItemTenantScope', () => {
  it('requires the same tenant and, when both name one, the same organization', () => {
    expect(sharesWorkItemTenantScope(undefined, {})).toBe(true);
    expect(sharesWorkItemTenantScope({ tenant_slug: 'a' }, { tenant_slug: 'a' })).toBe(true);
    expect(sharesWorkItemTenantScope({ tenant_slug: 'a' }, {})).toBe(false);
    expect(
      sharesWorkItemTenantScope(
        { tenant_slug: 'a', organization_id: 'o1' },
        { tenant_slug: 'a', organization_id: 'o2' }
      )
    ).toBe(false);
    expect(
      sharesWorkItemTenantScope({ tenant_slug: 'a' }, { tenant_slug: 'a', organization_id: 'o2' })
    ).toBe(true);
  });
});

describe('aggregateParentStatus', () => {
  const of = (...statuses: WorkItemStatus[]) =>
    aggregateParentStatus(statuses.map((status) => ({ status })));

  it('derives the parent status from its children', () => {
    expect(of()).toBeNull();
    expect(of('archived', 'archived')).toBe('archived');
    expect(of('done', 'archived')).toBe('review');
    expect(of('done', 'done')).toBe('review');
    expect(of('in_progress', 'blocked')).toBe('in_progress');
    expect(of('review', 'ready')).toBe('in_progress');
    expect(of('blocked', 'ready')).toBe('blocked');
    expect(of('done', 'ready')).toBe('in_progress');
    expect(of('ready', 'backlog')).toBe('ready');
    expect(of('backlog')).toBe('backlog');
  });
});
