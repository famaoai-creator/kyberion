import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claimWorkItem,
  clearWorkCoordinationNamespace,
  clearWorkCoordinationStore,
  createWorkItem,
  getWorkItem,
  listCoordinationEvents,
  releaseWorkItem,
  setWorkCoordinationNamespace,
  updateWorkItem,
} from './work-coordination.js';
import { resolveParentStatusSync, summarizeChildProgress } from './work-item-hierarchy.js';
import type { WorkItemStatus } from './work-coordination-types.js';

beforeEach(() => {
  setWorkCoordinationNamespace('work-item-parent-status-test');
  clearWorkCoordinationStore();
});

afterEach(() => {
  clearWorkCoordinationStore();
  clearWorkCoordinationNamespace();
});

function item(itemId: string, extra: Record<string, unknown> = {}) {
  return createWorkItem({ itemId, title: itemId, description: itemId, ...extra });
}

function setStatus(itemId: string, status: WorkItemStatus) {
  return updateWorkItem({ itemId, expectedVersion: getWorkItem(itemId)!.version, status });
}

const statusOf = (itemId: string) => getWorkItem(itemId)?.status;

describe('resolveParentStatusSync (W2 rule table)', () => {
  const steps = (...statuses: WorkItemStatus[]) => statuses.map((status) => ({ status }));
  const free = { claimed: false };

  it('keeps the parent when it has no steps, is closed, claimed or pinned', () => {
    expect(resolveParentStatusSync({ status: 'ready' }, [], free)).toMatchObject({
      apply: false,
      reason: 'no_children',
    });
    for (const status of ['done', 'archived'] as const) {
      expect(resolveParentStatusSync({ status }, steps('ready'), free)).toMatchObject({
        apply: false,
        reason: 'terminal',
      });
    }
    expect(
      resolveParentStatusSync({ status: 'ready' }, steps('done'), { claimed: true })
    ).toMatchObject({ apply: false, reason: 'claimed', aggregate: 'review' });
    expect(
      resolveParentStatusSync({ status: 'blocked', status_origin: 'manual' }, steps('done'), free)
    ).toMatchObject({ apply: false, reason: 'pinned' });
  });

  it('is idempotent and never closes an Issue because every step was withdrawn', () => {
    expect(
      resolveParentStatusSync({ status: 'review', status_origin: 'children' }, steps('done'), free)
    ).toMatchObject({ apply: false, reason: 'unchanged' });
    expect(
      resolveParentStatusSync(
        { status: 'in_progress', status_origin: 'children' },
        steps('archived'),
        free
      )
    ).toMatchObject({ apply: false, reason: 'aggregate_terminal' });
  });

  it('follows the aggregate once aggregated; before that only moves the parent forward', () => {
    expect(
      resolveParentStatusSync(
        { status: 'review', status_origin: 'children' },
        steps('done', 'ready'),
        free
      )
    ).toEqual({ apply: true, status: 'in_progress' });
    expect(resolveParentStatusSync({ status: 'backlog' }, steps('done', 'done'), free)).toEqual({
      apply: true,
      status: 'review',
    });
    expect(
      resolveParentStatusSync({ status: 'in_progress' }, steps('backlog'), free)
    ).toMatchObject({ apply: false, reason: 'not_forward' });
    expect(
      resolveParentStatusSync({ status: 'in_progress' }, steps('blocked'), free)
    ).toMatchObject({ apply: false, reason: 'not_forward' });
  });
});

describe('parent status follows its steps (W2 wiring)', () => {
  it('moves the Issue to review when every step is done, writing once', () => {
    item('issue');
    item('step-a', { parentItemId: 'issue' });
    item('step-b', { parentItemId: 'issue' });
    setStatus('step-a', 'in_progress');
    expect(statusOf('issue')).toBe('in_progress');
    setStatus('step-a', 'done');
    expect(statusOf('issue')).toBe('in_progress');
    setStatus('step-b', 'done');
    const issue = getWorkItem('issue')!;
    expect(issue.status).toBe('review');
    expect(issue.status_origin).toBe('children');

    // Idempotent: a step write that changes no status leaves the Issue untouched.
    updateWorkItem({
      itemId: 'step-b',
      expectedVersion: getWorkItem('step-b')!.version,
      title: 'renamed',
    });
    expect(getWorkItem('issue')!.version).toBe(issue.version);
    const aggregated = listCoordinationEvents({ item_id: 'issue', event_type: 'item_updated' });
    expect(aggregated.map((event) => event.status)).toEqual(['in_progress', 'review']);
  });

  it('reopens an aggregated Issue when a new step arrives, and never reopens a closed one', () => {
    item('issue');
    item('step-a', { parentItemId: 'issue' });
    setStatus('step-a', 'done');
    expect(statusOf('issue')).toBe('review');
    item('step-b', { parentItemId: 'issue', status: 'ready' });
    expect(statusOf('issue')).toBe('in_progress');

    setStatus('step-b', 'done');
    setStatus('issue', 'done');
    item('step-c', { parentItemId: 'issue', status: 'ready' });
    expect(statusOf('issue')).toBe('done');
  });

  it('pins a status a person set on an Issue with steps until it is handed back', () => {
    item('issue');
    item('step-a', { parentItemId: 'issue' });
    item('step-b', { parentItemId: 'issue' });
    const pinned = setStatus('issue', 'blocked');
    expect(pinned.status_origin).toBe('manual');
    setStatus('step-a', 'done');
    setStatus('step-b', 'done');
    expect(statusOf('issue')).toBe('blocked');

    const handedBack = updateWorkItem({
      itemId: 'issue',
      expectedVersion: getWorkItem('issue')!.version,
      statusFromChildren: true,
    });
    expect(handedBack.status).toBe('review');
    expect(handedBack.status_origin).toBe('children');
  });

  it('leaves a claimed Issue to its lease holder', () => {
    item('issue');
    item('step', { parentItemId: 'issue' });
    const { lease } = claimWorkItem({ itemId: 'issue', actorPeerId: 'owner', purpose: 'own' });
    setStatus('step', 'done');
    expect(statusOf('issue')).toBe('in_progress');
    releaseWorkItem({ itemId: 'issue', leaseId: lease.lease_id, actorPeerId: 'owner' });
    expect(statusOf('issue')).toBe('ready');
  });

  it('re-aggregates the former parent when a step moves to another Issue', () => {
    item('issue-1');
    item('issue-2');
    item('step-done', { parentItemId: 'issue-1', status: 'done' });
    item('step-open', { parentItemId: 'issue-1', status: 'ready' });
    expect(statusOf('issue-1')).toBe('in_progress');
    updateWorkItem({
      itemId: 'step-open',
      expectedVersion: getWorkItem('step-open')!.version,
      parentItemId: 'issue-2',
    });
    expect(statusOf('issue-1')).toBe('review');
    expect(statusOf('issue-2')).toBe('ready');
  });

  it('carries progress up a chain of Issues', () => {
    item('epic');
    item('issue', { parentItemId: 'epic' });
    item('step', { parentItemId: 'issue' });
    setStatus('step', 'in_progress');
    expect(statusOf('issue')).toBe('in_progress');
    expect(statusOf('epic')).toBe('in_progress');
  });
});

describe('summarizeChildProgress', () => {
  it('counts steps and finished steps per parent', () => {
    const progress = summarizeChildProgress([
      { status: 'done', parent_item_id: 'a' },
      { status: 'archived', parent_item_id: 'a' },
      { status: 'ready', parent_item_id: 'a' },
      { status: 'ready', parent_item_id: 'b' },
      { status: 'ready' },
    ]);
    expect(progress.get('a')).toEqual({ total: 3, done: 2 });
    expect(progress.get('b')).toEqual({ total: 1, done: 0 });
    expect(progress.size).toBe(2);
  });
});
