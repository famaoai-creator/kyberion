import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { NextRequest } from 'next/server';
import { humanActor } from '@agent/core/actor';
import { withExecutionContextAsync } from '@agent/core/authority';
import { isValidTenantSlug } from '@agent/core/entity-scope';
import { runInResourceAccessScope } from '@agent/core/foundation/resource-access-scope';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeReaddir } from '@agent/core/secure-io';
import { readTenantProfile, tenantProfilePath } from '@agent/core/organization/tenant-registry';
import {
  readSurfaceManagementResource,
  verifySurfaceManagementAuthorization,
  SurfaceManagementError,
  type SurfaceManagementAuthorization,
} from '@agent/core/surface/surface-management-mutations';
import { conciergeCredential, resolveConciergeViewer } from './viewer-context';

const ORGANIZATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const PROJECT_ID = /^PRJ-[A-Z0-9][A-Z0-9._-]*$/u;
function denied(message = 'A verified active owner credential is required.'): never {
  throw new SurfaceManagementError('forbidden', 403, message);
}
/** No loopback, flat localadmin, or same-origin fallback becomes ownership. */
export function managementAuthorization(
  req: NextRequest,
  requestedTenant?: string
): SurfaceManagementAuthorization {
  if (!conciergeCredential(req).token) denied();
  const resolved = resolveConciergeViewer(req);
  if (resolved.response)
    throw new SurfaceManagementError(
      'unauthenticated',
      401,
      'Sign in again to manage this tenant.'
    );
  const viewer = resolved.context;
  const principal = viewer.principal;
  if (
    !principal ||
    !['token', 'oidc'].includes(principal.source) ||
    principal.actor.kind !== 'human' ||
    principal.assurance === 'none' ||
    viewer.source !== 'token' ||
    viewer.role !== 'localadmin' ||
    principal.role !== 'localadmin' ||
    !principal.tierAccess.includes('confidential') ||
    !viewer.tierAccess.includes('confidential')
  )
    denied();
  const memberId = principal.memberId;
  if (!memberId || viewer.memberId !== memberId || principal.actor.id !== humanActor(memberId).id)
    denied();
  if (
    principal.expiresAt &&
    (!Number.isFinite(Date.parse(principal.expiresAt)) ||
      Date.parse(principal.expiresAt) <= Date.now())
  )
    denied('Sign in again to manage this tenant.');
  const tenant =
    requestedTenant ||
    (viewer.tenantSlugs !== 'all' && viewer.tenantSlugs.length === 1 ? viewer.tenantSlugs[0] : '');
  if (!isValidTenantSlug(tenant))
    throw new SurfaceManagementError('tenant_required', 400, 'Select one existing tenant.');
  if (viewer.tenantSlugs !== 'all' && !viewer.tenantSlugs.includes(tenant)) denied();
  if (principal.tenantSlugs !== 'all' && !principal.tenantSlugs.includes(tenant)) denied();
  const intersect = (left: string[] | 'all', right: string[] | 'all'): string[] | 'all' => {
    if (!left || !right) denied();
    if (left === 'all') return right;
    if (right === 'all') return left;
    return left.filter((id) => right.includes(id));
  };
  return {
    actorId: principal.actor.id,
    memberId,
    tenantSlug: tenant,
    allowedOrganizationIds: intersect(viewer.organizationIds, principal.organizationIds),
    allowedProjectIds: intersect(viewer.projectIds, principal.projectIds),
    ...(principal.expiresAt ? { expiresAt: principal.expiresAt } : {}),
  };
}
/** Binds a confirmed draft to the verified human and immutable grant scope, never a secret. */
export function managementContextId(auth: SurfaceManagementAuthorization): string {
  const grants = (value: readonly string[] | 'all') =>
    value === 'all' ? value : [...value].sort();
  return createHash('sha256')
    .update(
      JSON.stringify([
        auth.actorId,
        auth.memberId,
        auth.tenantSlug,
        grants(auth.allowedOrganizationIds),
        grants(auth.allowedProjectIds),
      ])
    )
    .digest('hex');
}
async function readExact<T>(
  auth: SurfaceManagementAuthorization,
  files: string[],
  fn: () => T
): Promise<T> {
  return runInResourceAccessScope(
    {
      tenantSlug: auth.tenantSlug,
      readExact: files.map((file) => pathResolver.toRepoRelative(file)),
      writeExact: [],
      mkdirExact: [],
      allowProductKnowledgeRead: true,
    },
    () => withExecutionContextAsync('concierge_management_reader', fn, undefined, auth.tenantSlug)
  );
}
export async function managementSnapshot(
  auth: SurfaceManagementAuthorization,
  organizationId?: string,
  projectId?: string
) {
  if (organizationId && !ORGANIZATION_ID.test(organizationId))
    throw new SurfaceManagementError('invalid_input', 400, 'Invalid organization selection.');
  if (projectId && (!organizationId || !PROJECT_ID.test(projectId)))
    throw new SurfaceManagementError('invalid_input', 400, 'A project requires its organization.');
  await verifySurfaceManagementAuthorization(auth);
  const root = path.dirname(
    pathResolver.organizationWorkspaceDir('scope-placeholder', 'confidential', auth.tenantSlug)
  );
  const ids =
    auth.allowedOrganizationIds === 'all'
      ? await readExact(auth, [root], () =>
          safeExistsSync(root)
            ? safeReaddir(root)
                .filter((id) => ORGANIZATION_ID.test(id))
                .sort()
            : []
        )
      : [...auth.allowedOrganizationIds].filter((id) => ORGANIZATION_ID.test(id)).sort();
  if (organizationId && !ids.includes(organizationId))
    denied('Organization is unavailable in this scope.');
  const organizations: Array<{ id: string; name: string; status: string }> = [];
  const projects: Array<{ id: string; name: string; organization_id: string; status: string }> = [];
  let selectedOrganization: {
    id: string;
    name: string;
    purpose: string;
    version: string;
    status: string;
  } | null = null;
  let selectedProject: {
    id: string;
    name: string;
    summary: string;
    version: string;
    status: string;
  } | null = null;
  for (const id of ids) {
    let entry;
    try {
      entry = await readSurfaceManagementResource(auth, { organizationId: id });
    } catch (error) {
      if (error instanceof SurfaceManagementError && error.status === 404 && id !== organizationId)
        continue;
      throw error;
    }
    if (entry.resource.kind !== 'organization') throw new Error('Invalid organization projection');
    const { state, purpose } = entry.resource;
    organizations.push({ id, name: state.name, status: state.status });
    if (id !== organizationId) continue;
    selectedOrganization = {
      id,
      name: state.name,
      purpose: purpose?.purpose ?? '',
      version: entry.version,
      status: state.status,
    };
    for (const child of state.active_project_ids ?? []) {
      if (
        !PROJECT_ID.test(child) ||
        (auth.allowedProjectIds !== 'all' && !auth.allowedProjectIds.includes(child))
      )
        continue;
      let item;
      try {
        item = await readSurfaceManagementResource(auth, { organizationId: id, projectId: child });
      } catch (error) {
        if (error instanceof SurfaceManagementError && error.status === 404 && child !== projectId)
          continue;
        throw error;
      }
      if (item.resource.kind !== 'project') throw new Error('Invalid project projection');
      const record = item.resource.record;
      projects.push({ id: child, name: record.name, organization_id: id, status: record.status });
      if (child === projectId)
        selectedProject = {
          id: child,
          name: record.name,
          summary: record.summary,
          version: item.version,
          status: record.status,
        };
    }
  }
  if (organizationId && !selectedOrganization)
    throw new SurfaceManagementError('not_found', 404, 'Organization not found.');
  if (projectId && !selectedProject)
    throw new SurfaceManagementError('not_found', 404, 'Project not found in this organization.');
  const tenant = await readExact(auth, [tenantProfilePath(auth.tenantSlug)], () =>
    readTenantProfile(auth.tenantSlug)
  );
  return {
    ok: true,
    contextId: managementContextId(auth),
    actorId: auth.actorId,
    tenants: [{ slug: auth.tenantSlug, name: tenant?.display_name ?? auth.tenantSlug }],
    organizations,
    projects,
    selected: {
      tenant: auth.tenantSlug,
      organizationId: organizationId ?? null,
      projectId: projectId ?? null,
    },
    canManage: true,
    capabilities: {
      createOrganization: auth.allowedOrganizationIds === 'all',
      createProject: selectedOrganization?.status === 'active' && auth.allowedProjectIds === 'all',
      editOrganization: Boolean(selectedOrganization),
      editProject: Boolean(selectedProject),
    },
    organization: selectedOrganization,
    project: selectedProject,
  };
}
