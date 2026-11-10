/**
 * The mission ownership WorkItem (SO-03) and its role as the Issue of a
 * mission (D1, concept model v2): every mission task WorkItem is a child of
 * it. One module owns the id, the creation envelope, the parent resolution
 * used by dispatch, and the backfill for items created before parents existed.
 */
import { logger } from '../core.js';
import {
  createWorkItemIfAbsent,
  getWorkItem,
  listWorkItems,
  updateWorkItem,
  WorkCoordinationError,
} from '../workforce/work-coordination.js';
import type { WorkItem, WorkItemContext } from '../workforce/work-coordination-types.js';
import { sharesWorkItemTenantScope } from '../workforce/work-item-hierarchy.js';

/** SO-03: deterministic namespace-safe id prefix for a mission's ownership work item. */
const MISSION_OWNERSHIP_ITEM_PREFIX = 'mission-ownership:';

/**
 * The deterministic work-item id backing `missionId`'s ownership claim.
 * Prefixed and namespaced so it can never collide with a real work item
 * dispatched through the normal WorkItem flow (see work-coordination.ts).
 */
export function deriveMissionOwnershipItemId(missionId: string): string {
  return `${MISSION_OWNERSHIP_ITEM_PREFIX}${missionId.toUpperCase()}`;
}

/** Tenant scope carried by the ownership item when a scoped task creates it first. */
export type MissionOwnershipScope = Pick<WorkItemContext, 'tenant_slug' | 'organization_id'>;

/**
 * Idempotent: create the mission ownership work item on first use only and
 * return it. `scope` applies only to the first creation; an existing item
 * keeps its scope. A concurrent creation with another scope resolves to
 * whichever creation committed first.
 */
export function ensureMissionOwnershipWorkItem(
  missionId: string,
  scope: MissionOwnershipScope = {}
): WorkItem {
  const normalizedMissionId = missionId.toUpperCase();
  const itemId = deriveMissionOwnershipItemId(normalizedMissionId);
  const existing = getWorkItem(itemId);
  if (existing) return existing;
  const context: WorkItemContext = {
    ...(scope.tenant_slug ? { tenant_slug: scope.tenant_slug } : {}),
    ...(scope.organization_id ? { organization_id: scope.organization_id } : {}),
  };
  try {
    return createWorkItemIfAbsent({
      itemId,
      title: `Mission ownership: ${normalizedMissionId}`,
      description:
        `SO-03 mission-ownership claim item for mission ${normalizedMissionId}. It is the ` +
        'mission-level Issue (D1): mission task WorkItems are its children, and ' +
        'orchestrator-session.ts serializes "who owns this mission" across processes through ' +
        'its lease.',
      projectId: 'orchestrator-sessions',
      ...(Object.keys(context).length > 0 ? { context } : {}),
      metadata: { mission_id: normalizedMissionId, kind: 'mission_ownership' },
    });
  } catch (error) {
    const winner = getWorkItem(itemId);
    if (error instanceof WorkCoordinationError && error.code === 'idempotency_conflict' && winner)
      return winner;
    throw error;
  }
}

/**
 * D1: the parent for a mission task WorkItem — the mission ownership item,
 * created on first use with the task's tenant scope. Returns undefined (the
 * task stays top-level, with a warning) when the ownership item is in another
 * tenant scope or cannot be created; dispatch never fails on the parent link.
 */
export function resolveMissionTaskParentItemId(
  missionId: string,
  taskContext: WorkItemContext | undefined
): string | undefined {
  try {
    const owner = ensureMissionOwnershipWorkItem(missionId, {
      tenant_slug: taskContext?.tenant_slug,
      organization_id: taskContext?.organization_id,
    });
    if (sharesWorkItemTenantScope(owner.context, taskContext)) return owner.item_id;
    logger.warn(
      `mission task WorkItem left without a parent — the mission ownership item is in another tenant scope | reconcile the ownership item's context, then run work_coordination migrate-parents --apply | mission=${missionId} owner_tenant=${owner.context?.tenant_slug ?? '-'} task_tenant=${taskContext?.tenant_slug ?? '-'}`
    );
  } catch (error) {
    logger.warn(
      `mission task WorkItem left without a parent — the mission ownership item could not be ensured | run work_coordination migrate-parents --apply once the store is healthy | mission=${missionId} error=${error instanceof Error ? error.message : String(error)}`
    );
  }
  return undefined;
}

export interface MissionTaskParentMigrationResult {
  /** Items whose parent was set by this run (apply only). */
  migrated: string[];
  /** Items that would be linked (dry run) — zero after a complete apply. */
  remaining: string[];
  /** Items that cannot be linked yet, with the reason. */
  skipped: Array<{ item_id: string; reason: 'no_ownership_item' | 'scope_mismatch' }>;
}

/**
 * Backfill for WorkItems created before D1: an item whose typed context names
 * a mission task (`mission_id` + `task_id`) and that has no parent gets the
 * mission ownership item as parent when that item exists and shares its
 * tenant scope. Dry run by default; `apply` writes. Idempotent: linked items
 * are never revisited.
 */
export function migrateMissionTaskWorkItemParents(
  options: { apply?: boolean; rootDir?: string } = {}
): MissionTaskParentMigrationResult {
  const result: MissionTaskParentMigrationResult = { migrated: [], remaining: [], skipped: [] };
  const read = { rootDir: options.rootDir };
  for (const item of listWorkItems({}, read)) {
    const missionId = item.context?.mission_id;
    if (!missionId || !item.context?.task_id || item.parent_item_id) continue;
    const parentId = deriveMissionOwnershipItemId(missionId);
    if (parentId === item.item_id) continue;
    const parent = getWorkItem(parentId, read);
    if (!parent) {
      result.skipped.push({ item_id: item.item_id, reason: 'no_ownership_item' });
      continue;
    }
    if (!sharesWorkItemTenantScope(parent.context, item.context)) {
      result.skipped.push({ item_id: item.item_id, reason: 'scope_mismatch' });
      continue;
    }
    if (!options.apply) {
      result.remaining.push(item.item_id);
      continue;
    }
    updateWorkItem({
      itemId: item.item_id,
      expectedVersion: item.version,
      parentItemId: parentId,
      ...(options.rootDir ? { rootDir: options.rootDir } : {}),
    });
    result.migrated.push(item.item_id);
  }
  return result;
}
