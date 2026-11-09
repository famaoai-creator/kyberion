/**
 * W2 (concept model v2): keep a parent Issue's status consistent with its
 * steps. The rules are pure (`resolveParentStatusSync` in
 * `work-item-hierarchy.ts`); this module only decides *when* they run — after
 * every committed item snapshot whose status or parent changed — and applies
 * the result through the store facade (`work-coordination.ts`), inside its
 * mutation fence.
 */
import type {
  AppendCoordinationEventInput,
  UpdateWorkItemInput,
  WorkItem,
  WorkItemStatus,
  WorkLease,
} from './work-coordination-types.js';
import { workEffectOwnership } from './work-effect-ownership.js';
import {
  MAX_WORK_ITEM_DEPTH,
  resolveParentStatusSync,
  type ParentStatusSyncDecision,
} from './work-item-hierarchy.js';

/** Store operations the sync needs; `work-coordination.ts` provides them under its fence. */
export interface ParentStatusStore {
  currentWorkItem(itemId: string): WorkItem | null;
  currentWorkItems(): readonly WorkItem[];
  activeLeaseForItem(itemId: string): WorkLease | null;
  appendItemSnapshot(item: WorkItem): WorkItem;
  /** Version bump + snapshot through the writer from {@link bindItemSnapshotWriter}. */
  updateItemSnapshot(current: WorkItem, patch: Partial<WorkItem>): WorkItem;
  appendEvent(input: AppendCoordinationEventInput): unknown;
}

export type SnapshotFacts = Pick<WorkItem, 'status' | 'parent_item_id'>;

// Re-entry depth: a parent write syncs the grandparent. The hierarchy is
// validated acyclic, but a legacy loop in the store is still cut off here.
let syncDepth = 0;

function writeAggregatedStatus(
  store: ParentStatusStore,
  parent: WorkItem,
  status: WorkItemStatus,
  stepCount: number
): void {
  const next = store.updateItemSnapshot(parent, { status, status_origin: 'children' });
  store.appendEvent({
    eventType: 'item_updated',
    itemId: next.item_id,
    status: next.status,
    note: `status aggregated from ${stepCount} step(s)`,
    payload: { changed_fields: ['status'], status_origin: 'children', step_count: stepCount },
  });
}

/** Re-aggregate the status of parent `parentId` from its steps now (rules in `resolveParentStatusSync`). */
export function syncParentStatus(
  parentId: string,
  store: ParentStatusStore
): ParentStatusSyncDecision | null {
  if (syncDepth >= MAX_WORK_ITEM_DEPTH) return null;
  const parent = store.currentWorkItem(parentId);
  if (!parent) return null;
  const children = store.currentWorkItems().filter((child) => child.parent_item_id === parentId);
  const claimed =
    Boolean(store.activeLeaseForItem(parentId)) || workEffectOwnership(parent)?.state === 'held';
  const decision = resolveParentStatusSync(parent, children, { claimed });
  if (!decision.apply) return decision;
  syncDepth += 1;
  try {
    writeAggregatedStatus(store, parent, decision.status, children.length);
  } finally {
    syncDepth -= 1;
  }
  return decision;
}

/**
 * Call after a snapshot of `written` was committed (`previous` = the snapshot
 * before it, null for a creation). Re-aggregates the parent when the step's
 * status or parent changed, and the former parent when the step moved away.
 * A write that changes neither is a no-op, so repeating it never rewrites.
 */
export function syncParentStatusAfterChange(
  written: SnapshotFacts,
  previous: SnapshotFacts | null,
  store: ParentStatusStore
): void {
  const parents = new Set<string>();
  const moved = previous?.parent_item_id !== written.parent_item_id;
  if (written.parent_item_id && (!previous || previous.status !== written.status || moved)) {
    parents.add(written.parent_item_id);
  }
  if (previous?.parent_item_id && moved) parents.add(previous.parent_item_id);
  for (const parentId of parents) syncParentStatus(parentId, store);
}

/**
 * The facade's one item-snapshot writer: append `item` (replacing
 * `previous`, null for a creation), then sync its parent Issue.
 */
export function bindItemSnapshotWriter(
  store: ParentStatusStore
): (previous: SnapshotFacts | null, item: WorkItem) => WorkItem {
  return (previous, item) => {
    const written = store.appendItemSnapshot(item);
    syncParentStatusAfterChange(written, previous, store);
    return written;
  };
}

/** After `statusFromChildren` handed `item` back: apply its aggregate now and return the latest record. */
export function handBack(store: ParentStatusStore, item: WorkItem): WorkItem {
  syncParentStatus(item.item_id, store);
  return store.currentWorkItem(item.item_id) ?? item;
}

/**
 * The `status_origin` an update writes: a direct status change on an Issue
 * that has steps pins it (`manual`); `statusFromChildren` without `status`
 * hands it back to aggregation (`children`); otherwise unchanged.
 */
export function nextStatusOrigin(
  store: Pick<ParentStatusStore, 'currentWorkItems'>,
  current: WorkItem,
  input: Pick<UpdateWorkItemInput, 'status' | 'statusFromChildren'>
): WorkItem['status_origin'] | undefined {
  if (input.status) {
    if (input.status === current.status) return undefined;
    const hasSteps = store
      .currentWorkItems()
      .some((item) => item.parent_item_id === current.item_id);
    return hasSteps ? 'manual' : undefined;
  }
  return input.statusFromChildren ? 'children' : undefined;
}
