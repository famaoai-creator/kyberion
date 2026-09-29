import type { DiscussionScope } from '@agent/core/discussion/discussion-types';
import {
  strictViewerScopeOrganizationIds,
  strictViewerScopeProjectIds,
  strictViewerScopeTenantSlugs,
  ViewerContextError,
  type ViewerContext,
} from './viewer-context';

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
  if (tenants !== 'all' && (!scope.tenant_slug || !tenants.includes(scope.tenant_slug))) {
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
