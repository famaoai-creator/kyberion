import { resolveRole, withExecutionContext } from '../authority.js';
import type { WorkItem } from './work-coordination.js';
import { latestById } from './work-coordination-inventory.js';

/**
 * Synchronous immutable inventory under the existing claim/mutation fence.
 * Lock order for mission settings is team-plan, then coordination; this callback
 * must not await, acquire a team-plan lock, or mutate snapshot objects. All WorkItem
 * changes continue through the existing governed mutation APIs. The lock and reader
 * are injected by work-coordination; this module owns no independent store or lock.
 */
export function withImmutableWorkItemInventorySnapshot<T>(
  callback: (items: readonly WorkItem[]) => T,
  withMutation: <R>(work: () => R) => R,
  readItems: () => WorkItem[]
): T {
  const callerRole = resolveRole();
  if (!callerRole) throw new Error('work_inventory_snapshot_requires_caller_context');
  return withMutation(() =>
    withExecutionContext(callerRole, () => {
      const snapshot = structuredClone(readItems());
      const freeze = (value: unknown): void => {
        if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
      };
      freeze(snapshot);
      // Sentinel authority is confined to lock acquisition/release; data reads
      // and caller work retain the original authority and its tenant scope.
      return callback(snapshot);
    })
  );
}

/** Normalize the latest persisted WorkItem view without exposing journal objects. */
export function selectCurrentWorkItems(records: WorkItem[]): WorkItem[] {
  return latestById(records, 'item_id')
    .map((item) => ({
      ...item,
      ...(item.attempts ? { attempts: item.attempts.map((attempt) => ({ ...attempt })) } : {}),
    }))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}
