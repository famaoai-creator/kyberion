import {
  resolveChronosWorkspace,
  workspaceSelectionFromSearchParams,
} from '../../../lib/workspace-scope';
import path from 'node:path';
import { organizationWorkspaceDir } from '@agent/core/path-resolver';
import { safeExistsSync, safeReaddir } from '@agent/core/secure-io';
import { loadOrganizationOperationalState } from '@agent/core/organization/organization-operating-model-persistence';
import { NextRequest, NextResponse } from 'next/server';
import { listProjectRecords } from '@agent/core/project/project-registry';
import { listWorkspaceTenantOptions } from '@agent/core/surface/workspace-scope';
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
import { listOrganizationOperations } from '@agent/core/organization/organization-operating-model-operations';

export function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;
  try {
    const requested = readChronosOptionalStringParam(req.nextUrl.searchParams.get('tenant'));
    const workspace = resolveChronosWorkspace(
      resolvedViewer.context,
      workspaceSelectionFromSearchParams(req.nextUrl.searchParams)
    );
    const tenants = strictViewerScopeTenantSlugs(resolvedViewer.context, requested);
    const tenantOptions = withViewerExecutionContext(resolvedViewer.context, () =>
      listWorkspaceTenantOptions({
        ...resolvedViewer.context,
        tenantSlugs: tenants,
        organizationIds: 'all',
        projectIds: 'all',
        tierAccess: resolvedViewer.context.tierAccess ?? ['public', 'confidential'],
      })
    );
    const visibleSlugs = tenantOptions.map((option) => option.slug);
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
    const allowedTiers = workspace.selection.tier
      ? [workspace.selection.tier]
      : (resolvedViewer.context.tierAccess ?? ['public', 'confidential']);
    const projects = withViewerExecutionContext(resolvedViewer.context, () =>
      listProjectRecords().filter((project) => {
        // The selector is a tenant-boundary aid, so legacy/unscoped project
        // records must not appear as if they belonged to the selected tenant.
        if (!allowedTiers.includes(project.tier)) return false;
        if (
          project.tenant_slug
            ? !allowedTenants.has(project.tenant_slug)
            : tenants !== 'all' || Boolean(requested) || project.tier === 'confidential'
        )
          return false;
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
    const organizationRoots = allowedTiers.flatMap((tier) => [
      ...visibleSlugs.map((tenantSlug) => ({ tier, tenantSlug })),
      ...(tenants === 'all' && !requested && tier !== 'confidential'
        ? [{ tier, tenantSlug: undefined }]
        : []),
    ]);
    const organizations = withViewerExecutionContext(resolvedViewer.context, () =>
      organizationRoots.flatMap(({ tier, tenantSlug }) => {
        const root = path.dirname(
          organizationWorkspaceDir('scope-placeholder', tier, tenantSlug ?? 'shared')
        );
        const ids =
          organizationIds === 'all'
            ? safeExistsSync(root)
              ? safeReaddir(root)
              : []
            : organizationIds;
        return ids.flatMap((id) => {
          if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) return [];
          const state = loadOrganizationOperationalState(id, { tier, tenantSlug });
          return state ? [{ id, ...(tenantSlug ? { tenant_slug: tenantSlug } : {}), tier }] : [];
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
    const options = tenantOptions;
    const operations =
      projectIds === 'all'
        ? withViewerExecutionContext(resolvedViewer.context, () =>
            organizations.flatMap((organization) => {
              if (
                workspace.selection.organization_id &&
                workspace.selection.organization_id !== organization.id
              )
                return [];
              return listOrganizationOperations({
                organizationId: organization.id,
                tenantSlug: organization.tenant_slug,
                tier: organization.tier,
              }).map((operation) => ({
                id: operation.operation_id,
                name: operation.name,
                organization_id: operation.organization_id,
                tenant_slug: organization.tenant_slug,
                tier: organization.tier,
              }));
            })
          )
        : [];
    return NextResponse.json({
      ok: true,
      tenants: options,
      organizations,
      operations,
      workspace: workspace.selection,
      projects: projects.map((project) => ({
        id: project.project_id,
        name: project.name,
        organization_id: project.organization_id,
        tenant_slug: project.tenant_slug,
        status: project.status,
        tier: project.tier,
      })),
      selected:
        workspace.selection.kind !== 'tenant'
          ? workspace.selection.tenant_slug || null
          : requested || (options.length === 1 ? options[0].slug : null),
      selectedOrganization: workspace.selection.organization_id || null,
      selectedProject: workspace.selection.project_id || null,
      selectedOperation: workspace.selection.operation_id || null,
      source: resolvedViewer.context.source,
    });
  } catch (error) {
    return viewerErrorResponse(error, 403);
  }
}
