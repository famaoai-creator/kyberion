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
 * Parent status derived from its children (one rule set; W2 wires it into
 * boards). Returns null when there are no children — the parent keeps its
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
