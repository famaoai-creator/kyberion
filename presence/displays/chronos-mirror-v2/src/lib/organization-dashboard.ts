import type { WorkspaceSelection } from '@agent/core/surface/workspace-scope';
import { workspaceWorkItemVisible } from '@agent/core/surface/workspace-work';
import { listWorkItems } from '@agent/core/workforce/work-coordination';
import { authorizeSurfaceContextOperation } from '@agent/core/surface/surface-authn';
import { resolveChronosWorkspace } from './workspace-scope';
import {
  toSurfaceAuthorizationContext,
  ViewerContextError,
  withViewerExecutionContext,
  type ViewerContext,
} from './viewer-context';

export type DashboardMode = 'organization' | 'scope' | 'mine';

/** Views never grant authority. Resolve owners and tiers before counting or selecting rows. */
export function collectOrganizationDashboard(
  viewer: ViewerContext,
  requested: WorkspaceSelection,
  mode: DashboardMode
) {
  if (
    mode === 'organization' &&
    (!requested.organization_id ||
      requested.project_id ||
      requested.operation_id ||
      viewer.projectIds !== 'all')
  )
    throw new ViewerContextError(
      403,
      'Select an authorized organization without project or operation scope.'
    );
  if (mode === 'mine' && !viewer.memberId)
    throw new ViewerContextError(403, 'A bound member identity is required for My work.');
  const scope = resolveChronosWorkspace(viewer, requested);
  const allowed = authorizeSurfaceContextOperation({
    context: toSurfaceAuthorizationContext(viewer),
    operation: {
      operationId: 'chronos.workspace.read',
      effect: 'read',
      requiredRole: 'readonly',
      requiredPermissions: ['surface.headless.read'],
    },
    resource: {
      tenantSlug: scope.selection.tenant_slug,
      organizationId: scope.selection.organization_id,
      projectId: scope.selection.project_id,
      tier: scope.selection.tier,
    },
    surface: 'chronos',
  });
  if (!allowed.allowed) throw new ViewerContextError(403, allowed.reason);
  const narrowed = {
    ...viewer,
    tenantSlugs: scope.tenantSlugs,
    organizationIds: scope.organizationIds,
    projectIds: scope.projectIds,
    tierAccess: scope.tierAccess,
  };
  // Failure is a failed response, never a healthy zero count.
  const items = withViewerExecutionContext(narrowed, () =>
    listWorkItems({
      tenantSlugs: scope.tenantSlugs === 'all' ? undefined : scope.tenantSlugs,
      organizationIds: scope.organizationIds === 'all' ? undefined : scope.organizationIds,
      projectIds: scope.projectIds === 'all' ? undefined : scope.projectIds,
    }).filter(
      (item) =>
        (mode !== 'mine' || item.assignee_user_id === viewer.memberId) &&
        workspaceWorkItemVisible(item, scope)
    )
  );
  const attention = items.filter((item) => ['blocked', 'review', 'ready'].includes(item.status));
  const rank = { blocked: 0, review: 1, ready: 2 };
  const priority = { urgent: 0, high: 1, normal: 2, low: 3 };
  attention.sort(
    (a, b) =>
      rank[a.status as keyof typeof rank] - rank[b.status as keyof typeof rank] ||
      priority[a.priority] - priority[b.priority] ||
      a.item_id.localeCompare(b.item_id, 'en')
  );
  return {
    ok: true as const,
    mode,
    selection: scope.selection,
    generatedAt: new Date().toISOString(),
    viewer: {
      id: viewer.memberId || viewer.principalId || viewer.source,
      role: viewer.role,
      tenants: scope.tenantSlugs,
      organizations: scope.organizationIds,
      projects: scope.projectIds,
      tiers: scope.tierAccess,
    },
    available: {
      mine: Boolean(viewer.memberId),
      organization: Boolean(scope.selection.organization_id) && viewer.projectIds === 'all',
    },
    counts: {
      total: items.length,
      active: items.filter((item) => ['ready', 'in_progress', 'review'].includes(item.status))
        .length,
      blocked: items.filter((item) => item.status === 'blocked').length,
      review: items.filter((item) => item.status === 'review').length,
      ready: items.filter((item) => item.status === 'ready').length,
    },
    attentionTotal: attention.length,
    attention: attention.slice(0, 10).map((item) => ({
      id: item.item_id,
      title: item.title,
      status: item.status,
      updatedAt: item.updated_at,
    })),
  };
}

export type OrganizationDashboardData = ReturnType<typeof collectOrganizationDashboard>;
