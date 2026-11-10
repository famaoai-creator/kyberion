import { withExecutionContext } from '@agent/core/authority';
import { getProjectManagementView } from '@agent/core/project/project-management';
import type { ProjectRecord } from '@agent/core/project/project-registry';

export interface IntelligenceProjectManagement {
  project: ReturnType<typeof getProjectManagementView>['project'];
  lineage: ReturnType<typeof getProjectManagementView>['lineage'];
}

/**
 * Project management views for projects the route already narrowed to the
 * viewer's tenants and tiers (server-side `ViewerContext`).
 *
 * The server runs with `KYBERION_BASE_ROLE=worker`, and `getProjectManagementView`
 * fences worker processes to their own `KYBERION_PROJECT_ID`
 * (`assertWorkerProjectScope`), so reading it under the ambient persona always
 * failed with [PROJECT_SCOPE_MISSING] and the project lineage stayed empty.
 * The read runs as `sovereign_concierge`, as the server's other read-only
 * mission/state reads do (lib/hygiene-server.ts), bound to the project's own
 * tenant, so the view never reaches beyond the already-authorized project.
 */
export function readProjectManagementForViewer(
  projects: readonly ProjectRecord[],
  readView: typeof getProjectManagementView = getProjectManagementView
): IntelligenceProjectManagement[] {
  return projects.map((project) => {
    const view = withExecutionContext(
      'sovereign_concierge',
      () => readView(project.project_id),
      undefined,
      project.tenant_slug ?? ''
    );
    return { project: view.project, lineage: view.lineage };
  });
}
