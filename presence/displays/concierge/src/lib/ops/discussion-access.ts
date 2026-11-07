import type { DiscussionScope } from '@agent/core/discussion/discussion-types';
import {
  admitsCustody,
  custodyOfScope,
  viewerPersonIds,
} from '@agent/core/surface/surface-authorization';
import {
  strictViewerScopeOrganizationIds,
  strictViewerScopeProjectIds,
  strictViewerScopeTenantSlugs,
  ViewerContextError,
  type ViewerContext,
} from './ops-viewer';

/**
 * Discussion rooms are visible only inside the viewer's scope. A room without
 * a tenant is system-scoped: it is hidden from tenant-limited viewers
 * (deny-unless-scoped) and a browser-supplied filter can only narrow.
 */
export function isDiscussionVisibleToViewer(
  viewer: ViewerContext,
  scope: DiscussionScope,
  requestedTenant?: string
): boolean {
  const tenants = strictViewerScopeTenantSlugs(viewer, requestedTenant);
  if (
    // `admitsCustody` decides for 'all' too: tenant/system custody admits, but
    // person custody stays identity-bound even for an all-tenant viewer.
    !admitsCustody(
      {
        tenantSlugs: tenants,
        includeUntenanted: viewer.includeUntenanted,
        personIds: viewerPersonIds(viewer),
      },
      custodyOfScope(scope)
    )
  ) {
    return false;
  }
  const organizations = strictViewerScopeOrganizationIds(viewer);
  if (
    organizations !== 'all' &&
    (!scope.organization_id || !organizations.includes(scope.organization_id))
  ) {
    return false;
  }
  const projects = strictViewerScopeProjectIds(viewer);
  if (projects !== 'all' && (!scope.project_id || !projects.includes(scope.project_id))) {
    return false;
  }
  return true;
}

export function assertDiscussionVisible(viewer: ViewerContext, scope: DiscussionScope): void {
  if (!isDiscussionVisibleToViewer(viewer, scope)) {
    throw new ViewerContextError(403, 'viewer is not authorized for this discussion room');
  }
}

/** Scope stamped on a new room: the viewer's own tenant can never be widened. */
export function resolveDiscussionCreateScope(
  viewer: ViewerContext,
  requestedTenant?: string,
  organizationId?: string,
  projectId?: string
): DiscussionScope {
  const tenants = strictViewerScopeTenantSlugs(viewer, requestedTenant);
  let tenant_slug: string | undefined;
  if (tenants !== 'all') {
    if (tenants.length !== 1) {
      throw new ViewerContextError(403, 'choose one tenant for this discussion room');
    }
    tenant_slug = tenants[0];
  } else if (requestedTenant) {
    tenant_slug = requestedTenant;
  }
  const organizations = strictViewerScopeOrganizationIds(viewer, organizationId);
  const projects = strictViewerScopeProjectIds(viewer, projectId);
  return {
    ...(tenant_slug ? { tenant_slug } : {}),
    ...(organizationId && (organizations === 'all' || organizations.includes(organizationId))
      ? { organization_id: organizationId }
      : {}),
    ...(projectId && (projects === 'all' || projects.includes(projectId))
      ? { project_id: projectId }
      : {}),
  };
}
