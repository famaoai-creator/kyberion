import { SHARED_TENANT } from '@agent/core/owner-scope';
import type { SelectedTenantScope } from './selected-tenant';
import type { ConciergeViewerContext } from './viewer-context';

/** Where a delegated task's mission lives, or null when it cannot be resolved. */
export interface DelegatedMissionScope {
  tenant: string;
  tier: string;
}

/**
 * Delegated tasks of the selected scope only. Task records carry no tenant,
 * so each is attributed through its mission: a company sees its own
 * missions' tasks, the system view sees tasks with no (or no resolvable,
 * untenanted) mission, and the personal view lists none. A mission outside
 * the viewer's tiers is never shown.
 */
export function delegatedTasksForSelection<T extends { mission_id?: string }>(
  tasks: readonly T[],
  selection: SelectedTenantScope,
  viewer: Pick<ConciergeViewerContext, 'tierAccess'>,
  missionScope: (missionId: string) => DelegatedMissionScope | null
): T[] {
  if (selection.mode === 'personal') return [];
  return tasks.filter((task) => {
    const scope = task.mission_id ? missionScope(task.mission_id) : null;
    if (scope && !viewer.tierAccess.some((tier) => tier === scope.tier)) return false;
    if (selection.mode === 'tenant') return scope?.tenant === selection.tenant_slug;
    return !scope || scope.tenant === SHARED_TENANT;
  });
}
