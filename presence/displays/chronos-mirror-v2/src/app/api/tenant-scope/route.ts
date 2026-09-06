import { NextRequest, NextResponse } from 'next/server';
import { listProjectRecords } from '@agent/core/project-registry';
import { listTenantProfileSlugs, readTenantProfile } from '@agent/core/tenant-registry';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import {
  resolveViewerContextForRequest,
  strictViewerScopeOrganizationIds,
  strictViewerScopeProjectIds,
  strictViewerScopeTenantSlugs,
  viewerErrorResponse,
  withViewerExecutionContext,
} from '../../../lib/viewer-context';
import { readChronosOptionalStringParam } from '../../../lib/request-input';

export function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;
  try {
    const requested = readChronosOptionalStringParam(req.nextUrl.searchParams.get('tenant'));
    const tenants = strictViewerScopeTenantSlugs(resolvedViewer.context, requested);
    const visibleSlugs = withViewerExecutionContext(resolvedViewer.context, () =>
      tenants === 'all'
        ? listTenantProfileSlugs()
        : tenants.filter((slug) => listTenantProfileSlugs().includes(slug))
    );
    const organizationIds = strictViewerScopeOrganizationIds(
      resolvedViewer.context,
      readChronosOptionalStringParam(req.nextUrl.searchParams.get('organization_id'))
    );
    const projectIds = strictViewerScopeProjectIds(
      resolvedViewer.context,
      readChronosOptionalStringParam(req.nextUrl.searchParams.get('project_id'))
    );
    const allowedTenants = new Set(visibleSlugs);
    const allowedOrganizations = organizationIds === 'all' ? null : new Set(organizationIds);
    const allowedProjects = projectIds === 'all' ? null : new Set(projectIds);
    const projects = withViewerExecutionContext(resolvedViewer.context, () =>
      listProjectRecords().filter((project) => {
        // The selector is a tenant-boundary aid, so legacy/unscoped project
        // records must not appear as if they belonged to the selected tenant.
        if (!project.tenant_slug || !allowedTenants.has(project.tenant_slug)) return false;
        if (
          allowedOrganizations &&
          (!project.organization_id || !allowedOrganizations.has(project.organization_id))
        )
          return false;
        if (allowedProjects && !allowedProjects.has(project.project_id)) return false;
        if (requested && project.tenant_slug !== requested) return false;
        return Boolean(project.organization_id || project.project_id);
      })
    );
    const organizations = Array.from(
      new Map(
        projects
          .filter((project) => project.organization_id)
          .map((project) => [
            project.organization_id!,
            { id: project.organization_id!, tenant_slug: project.tenant_slug },
          ])
      ).values()
    ).sort((a, b) => a.id.localeCompare(b.id));
    const options = visibleSlugs.flatMap((slug) => {
      const profile = readTenantProfile(slug);
      return profile ? [{ slug, displayName: profile.display_name, status: profile.status }] : [];
    });
    return NextResponse.json({
      ok: true,
      tenants: options,
      organizations,
      projects: projects.map((project) => ({
        id: project.project_id,
        name: project.name,
        organization_id: project.organization_id,
        tenant_slug: project.tenant_slug,
        status: project.status,
      })),
      selected: requested || (options.length === 1 ? options[0].slug : null),
      selectedOrganization:
        readChronosOptionalStringParam(req.nextUrl.searchParams.get('organization_id')) || null,
      selectedProject:
        readChronosOptionalStringParam(req.nextUrl.searchParams.get('project_id')) || null,
      source: resolvedViewer.context.source,
    });
  } catch (error) {
    return viewerErrorResponse(error, 403);
  }
}
