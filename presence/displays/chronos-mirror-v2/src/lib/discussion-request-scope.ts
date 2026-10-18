import type { DiscussionScope } from '@agent/core/discussion/discussion-types';
import { isDiscussionVisibleToViewer, resolveDiscussionCreateScope } from './discussion-access';
import { buildMissionHistoryItems } from './su-surface-data';
import {
  strictViewerScopeTenantSlugs,
  strictViewerScopeOrganizationIds,
  strictViewerScopeProjectIds,
  strictViewerTier,
  ViewerContextError,
  withViewerExecutionContext,
  type ViewerContext,
} from './viewer-context';

export class DiscussionMissionScopeError extends Error {}
const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value.trim() || undefined : undefined;

/** Shared by inspection and creation; a browser can only narrow its server scope. */
export function resolveDiscussionRequestScope(
  viewer: ViewerContext,
  input: Record<string, unknown>
): DiscussionScope {
  strictViewerTier(viewer, 'confidential');
  const missionId = text(input.mission_id);
  const tenant = text(input.tenant),
    organization = text(input.organization_id),
    project = text(input.project_id);
  const mission = missionId
    ? withViewerExecutionContext(viewer, () =>
        buildMissionHistoryItems({
          missionId,
          tier: 'confidential',
          tenantSlugs: strictViewerScopeTenantSlugs(viewer, tenant),
          organizationIds: strictViewerScopeOrganizationIds(viewer, organization),
          projectIds: strictViewerScopeProjectIds(viewer, project),
          limit: 1,
        })
      ).find(
        (entry) =>
          entry.missionId.toUpperCase() === missionId.toUpperCase() &&
          entry.tier === 'confidential' &&
          isDiscussionVisibleToViewer(
            viewer,
            {
              tenant_slug: entry.tenantSlug,
              organization_id: entry.organizationId,
              project_id: entry.projectId,
            },
            tenant
          )
      )
    : undefined;
  if (missionId && !mission)
    throw new DiscussionMissionScopeError('mission not found in your scope');
  if (
    mission &&
    ((tenant && tenant !== mission.tenantSlug) ||
      (organization && organization !== mission.organizationId) ||
      (project && project !== mission.projectId))
  )
    throw new ViewerContextError(403, 'Selected scope does not match the linked mission.');
  // A linked mission supplies its canonical context; client values cannot relabel it.
  const scope = resolveDiscussionCreateScope(
    viewer,
    mission ? mission.tenantSlug : tenant,
    mission ? mission.organizationId : organization,
    mission ? mission.projectId : project
  );
  if (mission) {
    scope.mission_id = mission.missionId;
    scope.tier = 'confidential';
  }
  if (!isDiscussionVisibleToViewer(viewer, scope, tenant))
    throw new ViewerContextError(
      403,
      'Choose an existing mission or scope visible to this viewer.'
    );
  return scope;
}
