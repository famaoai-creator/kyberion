/**
 * D1 (concept model v2): a top-level WorkItem is the Issue; steps that need
 * their own ownership are child WorkItems carrying `parent_item_id`. Pure
 * rules only — the store facade (`work-coordination.ts`) applies them under
 * its mutation fence.
 */
import { WorkCoordinationError } from './work-coordination-error.js';
import type { WorkItem, WorkItemContext, WorkItemStatus } from './work-coordination-types.js';

/** Most levels (an item plus its ancestors) accepted; deeper chains are refused. */
export const MAX_WORK_ITEM_DEPTH = 8;

/**
 * Parent and child share a tenant scope when their tenants are equal (both
 * absent counts as equal) and, when both name an organization, it is the
 * same one. An Issue held at tenant level may own steps inside one of its
 * organizations; a step never crosses a tenant boundary.
 */
export function sharesWorkItemTenantScope(
  parent: WorkItemContext | undefined,
  child: WorkItemContext | undefined
): boolean {
  if ((parent?.tenant_slug || undefined) !== (child?.tenant_slug || undefined)) return false;
  const parentOrg = parent?.organization_id;
  const childOrg = child?.organization_id;
  return !parentOrg || !childOrg || parentOrg === childOrg;
}

/**
 * Validate `parentItemId` for the item `itemId` with typed `context`.
 * Rejects: empty id, self-parent, unknown parent, cross-tenant parent, and
 * any chain that loops back to `itemId` or exceeds {@link MAX_WORK_ITEM_DEPTH}.
 */
export function assertWorkItemParent(input: {
  itemId: string;
  context: WorkItemContext | undefined;
  parentItemId: string;
  lookup: (itemId: string) => Pick<WorkItem, 'item_id' | 'context' | 'parent_item_id'> | null;
}): void {
  const parentId = String(input.parentItemId || '').trim();
  if (!parentId) {
    throw new WorkCoordinationError('validation_error', 'parent_item_id must be non-empty');
  }
  if (parentId === input.itemId) {
    throw new WorkCoordinationError(
      'validation_error',
      `work item cannot be its own parent: ${input.itemId}`,
      { item_id: input.itemId }
    );
  }
  const parent = input.lookup(parentId);
  if (!parent) {
    throw new WorkCoordinationError('validation_error', `parent work item not found: ${parentId}`, {
      item_id: input.itemId,
      parent_item_id: parentId,
    });
  }
  if (!sharesWorkItemTenantScope(parent.context, input.context)) {
    throw new WorkCoordinationError(
      'validation_error',
      `parent work item ${parentId} is outside the tenant scope of ${input.itemId}`,
      { item_id: input.itemId, parent_item_id: parentId }
    );
  }
  // Levels = the item itself + its ancestors; an existing loop elsewhere in
  // the store is cut off by the same bound.
  let ancestors = 1;
  let cursor: Pick<WorkItem, 'item_id' | 'parent_item_id'> | null = parent;
  while (cursor?.parent_item_id) {
    if (cursor.parent_item_id === input.itemId) {
      throw new WorkCoordinationError(
        'validation_error',
        `parent link would form a cycle: ${input.itemId} -> ${parentId}`,
        { item_id: input.itemId, parent_item_id: parentId }
      );
    }
    ancestors += 1;
    if (ancestors >= MAX_WORK_ITEM_DEPTH) {
      throw new WorkCoordinationError(
        'validation_error',
        `work item hierarchy deeper than ${MAX_WORK_ITEM_DEPTH} levels at ${input.itemId}`,
        { item_id: input.itemId, parent_item_id: parentId }
      );
    }
    cursor = input.lookup(cursor.parent_item_id);
  }
}

/** True for an Issue (no parent); false for a step. */
export function isTopLevelWorkItem(item: Pick<WorkItem, 'parent_item_id'>): boolean {
  return !item.parent_item_id;
}

/**
 * Parent status derived from its children (one rule set; whether a parent
 * takes it is {@link resolveParentStatusSync}). Returns null when there are no children — the parent keeps its
 * own status. Precedence:
 *   all archived → archived; all done/archived → review (a human closes the
 *   Issue); any in_progress/review → in_progress; any blocked → blocked;
 *   partially done → in_progress; any ready → ready; otherwise backlog.
 */
export function aggregateParentStatus(
  children: ReadonlyArray<Pick<WorkItem, 'status'>>
): WorkItemStatus | null {
  if (children.length === 0) return null;
  const statuses = children.map((child) => child.status);
  const has = (status: WorkItemStatus) => statuses.includes(status);
  if (statuses.every((status) => status === 'archived')) return 'archived';
  if (statuses.every((status) => status === 'done' || status === 'archived')) return 'review';
  if (has('in_progress') || has('review')) return 'in_progress';
  if (has('blocked')) return 'blocked';
  if (has('done') || has('archived')) return 'in_progress';
  if (has('ready')) return 'ready';
  return 'backlog';
}

/** Why a parent keeps its status after a step changed (see {@link resolveParentStatusSync}). */
export type ParentStatusHoldReason =
  | 'no_children'
  | 'terminal'
  | 'claimed'
  | 'pinned'
  | 'unchanged'
  | 'aggregate_terminal'
  | 'not_forward';

export type ParentStatusSyncDecision =
  | { apply: true; status: WorkItemStatus }
  | { apply: false; reason: ParentStatusHoldReason; aggregate: WorkItemStatus | null };

/** Lifecycle order for the first aggregation of a parent that was never aggregated. */
const FORWARD_RANK: Partial<Record<WorkItemStatus, number>> = {
  backlog: 0,
  ready: 1,
  in_progress: 2,
  blocked: 2,
  review: 3,
};

/**
 * W2: whether a parent Issue takes the status aggregated from its steps.
 * The one rule table (documented in the WorkItem/Lease plan, W2), first
 * match wins:
 *   1. no steps → keep;
 *   2. parent done/archived → keep (a person closed the Issue);
 *   3. parent claimed (active lease or held effect) → keep (the holder owns it);
 *   4. parent status set directly while it had steps (`manual`) → keep until
 *      handed back with `statusFromChildren`;
 *   5. aggregate equals the parent status → keep (idempotent, no write);
 *   6. aggregate archived (every step withdrawn) → keep (never closes an Issue);
 *   7. parent already aggregated (`children`) → take the aggregate;
 *   8. parent never aggregated → take the aggregate only when it moves the
 *      parent forward (backlog → ready → in_progress/blocked → review).
 */
export function resolveParentStatusSync(
  parent: Pick<WorkItem, 'status' | 'status_origin'>,
  children: ReadonlyArray<Pick<WorkItem, 'status'>>,
  options: { claimed: boolean }
): ParentStatusSyncDecision {
  const aggregate = aggregateParentStatus(children);
  const hold = (reason: ParentStatusHoldReason): ParentStatusSyncDecision => ({
    apply: false,
    reason,
    aggregate,
  });
  if (aggregate === null) return hold('no_children');
  if (parent.status === 'done' || parent.status === 'archived') return hold('terminal');
  if (options.claimed) return hold('claimed');
  if (parent.status_origin === 'manual') return hold('pinned');
  if (aggregate === parent.status) return hold('unchanged');
  if (aggregate === 'archived') return hold('aggregate_terminal');
  if (parent.status_origin === 'children') return { apply: true, status: aggregate };
  const from = FORWARD_RANK[parent.status] ?? 0;
  const to = FORWARD_RANK[aggregate] ?? 0;
  return to > from ? { apply: true, status: aggregate } : hold('not_forward');
}

/** Progress of an Issue's steps for boards: how many there are and how many are finished. */
export interface WorkItemChildProgress {
  total: number;
  /** Steps that are done or archived. */
  done: number;
}

/** Step counts per parent id, in one pass over `items`. */
export function summarizeChildProgress(
  items: ReadonlyArray<Pick<WorkItem, 'status' | 'parent_item_id'>>
): Map<string, WorkItemChildProgress> {
  const progress = new Map<string, WorkItemChildProgress>();
  for (const child of items) {
    if (!child.parent_item_id) continue;
    const entry = progress.get(child.parent_item_id) ?? { total: 0, done: 0 };
    entry.total += 1;
    if (child.status === 'done' || child.status === 'archived') entry.done += 1;
    progress.set(child.parent_item_id, entry);
  }
  return progress;
}

/**
 * Board items as Issues (W2): drop the steps whose Issue is among `items`
 * (they open inside it) and attach step progress counted over `allItems`. A
 * step whose Issue is not in `items` stays, so no item becomes unreachable.
 */
export function issueBoardView<T extends Pick<WorkItem, 'item_id' | 'status' | 'parent_item_id'>>(
  items: readonly T[],
  allItems: ReadonlyArray<Pick<WorkItem, 'status' | 'parent_item_id'>>
): Array<T & { steps?: WorkItemChildProgress }> {
  const ids = new Set(items.map((item) => item.item_id));
  const progress = summarizeChildProgress(allItems);
  return items
    .filter((item) => !item.parent_item_id || !ids.has(item.parent_item_id))
    .map((item) => {
      const steps = progress.get(item.item_id);
      return steps ? { ...item, steps } : item;
    });
}

type HierarchyLookup = (
  itemId: string
) => Pick<WorkItem, 'item_id' | 'context' | 'parent_item_id'> | null;

/** Validate the parent of a new item (no-op for a top-level item). */
export function assertCreatedWorkItemParent(
  item: Pick<WorkItem, 'item_id' | 'context' | 'parent_item_id'>,
  lookup: HierarchyLookup
): void {
  if (!item.parent_item_id) return;
  assertWorkItemParent({
    itemId: item.item_id,
    context: item.context,
    parentItemId: item.parent_item_id,
    lookup,
  });
}

/**
 * Validate an update against the hierarchy and return the parent patch to
 * apply. A parent link (new or kept) must stay valid under the item's next
 * context, and a tenant/organization change must not strand a child in
 * another tenant. `parentItemId`: string sets, null detaches, undefined keeps.
 */
export function workItemHierarchyUpdate(
  current: WorkItem,
  input: { context?: WorkItemContext; parentItemId?: string | null },
  store: { lookup: HierarchyLookup; items: () => readonly WorkItem[] }
): Pick<WorkItem, 'parent_item_id'> | Record<string, never> {
  const nextContext = input.context ?? current.context;
  const nextParent =
    input.parentItemId === undefined ? current.parent_item_id : input.parentItemId || undefined;
  if (nextParent && (nextParent !== current.parent_item_id || input.context)) {
    assertWorkItemParent({
      itemId: current.item_id,
      context: nextContext,
      parentItemId: nextParent,
      lookup: store.lookup,
    });
  }
  const scopeChanged =
    input.context &&
    (input.context.tenant_slug !== current.context?.tenant_slug ||
      input.context.organization_id !== current.context?.organization_id);
  const stranded = scopeChanged
    ? store
        .items()
        .find(
          (child) =>
            child.parent_item_id === current.item_id &&
            !sharesWorkItemTenantScope(nextContext, child.context)
        )
    : undefined;
  if (stranded) {
    throw new WorkCoordinationError(
      'validation_error',
      `scope change would move ${current.item_id} out of the tenant scope of its child ${stranded.item_id}`,
      { item_id: current.item_id, child_item_id: stranded.item_id }
    );
  }
  return input.parentItemId === undefined ? {} : { parent_item_id: nextParent };
}
