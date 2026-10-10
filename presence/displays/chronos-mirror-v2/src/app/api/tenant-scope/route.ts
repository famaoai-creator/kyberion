import path from 'node:path';
import { organizationWorkspaceDir } from '@agent/core/path-resolver';
import { safeExistsSync, safeReaddir } from '@agent/core/secure-io';
import { loadOrganizationOperationalState } from '@agent/core/organization/organization-operating-model-persistence';
import { NextRequest, NextResponse } from 'next/server';
import { listProjectRecords } from '@agent/core/project/project-registry';
import {
  listTenantProfileSlugs,
  readTenantProfile,
} from '@agent/core/organization/tenant-registry';
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
    // Validate the selection independently; selectors must retain authorized siblings.
    strictViewerScopeOrganizationIds(
      resolvedViewer.context,
      readChronosOptionalStringParam(req.nextUrl.searchParams.get('organization_id'))
    );
    strictViewerScopeProjectIds(
      resolvedViewer.context,
      readChronosOptionalStringParam(req.nextUrl.searchParams.get('project_id'))
    );
    const organizationIds = strictViewerScopeOrganizationIds(resolvedViewer.context);
    const projectIds = strictViewerScopeProjectIds(resolvedViewer.context);
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
    const organizations = withViewerExecutionContext(resolvedViewer.context, () =>
      visibleSlugs.flatMap((tenantSlug) => {
        const root = path.dirname(
          organizationWorkspaceDir('scope-placeholder', 'confidential', tenantSlug)
        );
        const ids =
          organizationIds === 'all'
            ? safeExistsSync(root)
              ? safeReaddir(root)
              : []
            : organizationIds;
        return ids.flatMap((id) => {
          if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) return [];
          const state = loadOrganizationOperationalState(id, { tier: 'confidential', tenantSlug });
          return state ? [{ id, tenant_slug: tenantSlug }] : [];
        });
      })
    ).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const selectedOrganization = readChronosOptionalStringParam(
      req.nextUrl.searchParams.get('organization_id')
    );
    const selectedProject = readChronosOptionalStringParam(
      req.nextUrl.searchParams.get('project_id')
    );
    if (
      selectedOrganization &&
      !organizations.some((organization) => organization.id === selectedOrganization)
    ) {
      throw new Error('Organization is unavailable in this tenant scope.');
    }
    if (
      selectedProject &&
      !projects.some(
        (project) =>
          project.project_id === selectedProject &&
          (!selectedOrganization || project.organization_id === selectedOrganization)
      )
    ) {
      throw new Error('Project is unavailable in this organization scope.');
    }
    const options = visibleSlugs.flatMap((slug) => {
      const profile = withViewerExecutionContext(resolvedViewer.context, () =>
        readTenantProfile(slug)
      );
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
