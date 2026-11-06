import { withExecutionContext } from '@agent/core/authority';
import { listProjectRecords, type ProjectRecord } from '@agent/core/project/project-registry';
import type { ConciergeViewerContext } from './viewer-context';

import type { SelectableProject } from './project-selection';

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;

/**
 * Pure. The projects of one company the viewer may narrow to: registered
 * under that tenant with an organization, not archived, and inside the
 * viewer's organization / project scope. Sorted by name for the selector.
 */
export function selectableProjects(
  records: readonly ProjectRecord[],
  scope: Pick<ConciergeViewerContext, 'organizationIds' | 'projectIds'> & { tenantSlug: string }
): SelectableProject[] {
  return records
    .filter(
      (record) =>
        PROJECT_ID.test(record.project_id) &&
        record.tenant_slug === scope.tenantSlug &&
        Boolean(record.organization_id) &&
        record.status !== 'archived' &&
        (scope.organizationIds === 'all' ||
          scope.organizationIds.includes(record.organization_id as string)) &&
        (scope.projectIds === 'all' || scope.projectIds.includes(record.project_id))
    )
    .map((record) => ({
      project_id: record.project_id,
      name: record.name?.trim() || record.project_id,
      organization_id: record.organization_id as string,
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.project_id.localeCompare(b.project_id));
}

/** The selected company's projects from the governed registry (fails closed to none). */
export function readSelectableProjects(
  viewer: Pick<ConciergeViewerContext, 'organizationIds' | 'projectIds'>,
  tenantSlug: string
): SelectableProject[] {
  try {
    const records = withExecutionContext('sovereign_concierge', () => listProjectRecords());
    return selectableProjects(records, { ...viewer, tenantSlug });
  } catch {
    return [];
  }
}
