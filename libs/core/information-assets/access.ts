import * as path from 'node:path';
import { currentExecutionScope } from '../foundation/execution-scope.js';
import { loadOrganizationOperationalState } from '../organization/organization-operating-model-persistence.js';
import { loadProjectRecord } from '../project/project-registry.js';
import { loadServiceBindingRecord } from '../service/service-binding-registry.js';
import { resolveBindingOwner } from '../service/service-binding-owner.js';
import {
  fail,
  requireGrant,
  type SurfaceManagementAuthorization,
} from '../surface/surface-management-contract.js';
import { authorizeOrganizationPeople } from '../organization/organization-people-access.js';
import { pathResolver } from '../path-resolver.js';
import { safeLstat, assertSafeRepositoryPath } from '../secure-io.js';
import { withConciergeManagementAccess } from '../surface/concierge-management-access.js';
import type { InformationAssetScope, InformationAssetLocation } from './types.js';
import { subjectAuthorization } from '../foundation/authorization-registry.js';

/** The registry selects the supported authority path; owner/scope checks supply its detail. */
export function assertInformationAssetCatalogAuthorization(mutation = false): void {
  const entry = subjectAuthorization(
    mutation ? 'information-asset:catalog:write' : 'information-asset:catalog:read'
  );
  const supported =
    entry.declared &&
    entry.source === 'code' &&
    (mutation
      ? entry.effectClass === 'internal_decision' &&
        entry.authority.kind === 'admission' &&
        entry.authority.boundary === 'internal'
      : entry.effectClass === 'local_only' && entry.authority.kind === 'free');
  if (!supported)
    fail(
      'authorization_required',
      403,
      'Information asset catalog requires its declared authority path.'
    );
}

export interface InformationAssetOptions {
  rootDir?: string;
}
export function assertInformationAssetScope(scope: InformationAssetScope): void {
  for (const value of [
    scope.tenant_slug,
    scope.organization_id,
    ...(scope.project_id === undefined ? [] : [scope.project_id]),
  ])
    if (
      typeof value !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value) ||
      ['shared', 'system', 'personal', 'confidential', 'public'].includes(value)
    )
      fail('invalid_scope', 400, 'Information asset scope requires explicit entity identifiers.');
}
export function assertCurrentInformationAssetScope(scope: InformationAssetScope): void {
  assertInformationAssetScope(scope);
  const current = currentExecutionScope();
  if (
    !current?.tenantBound ||
    current.tenantSlug !== scope.tenant_slug ||
    current.organizationId !== scope.organization_id ||
    (current.executionIdentity?.projectId &&
      current.executionIdentity.projectId !== scope.project_id)
  )
    fail('forbidden', 403, 'Information asset scope does not match current execution scope.');
}
export function assertInformationAssetParents(
  scope: InformationAssetScope,
  options: InformationAssetOptions = {}
): void {
  assertInformationAssetScope(scope);
  const org = loadOrganizationOperationalState(scope.organization_id, {
    tier: 'confidential',
    tenantSlug: scope.tenant_slug,
    ...options,
  });
  if (
    !org ||
    org.status !== 'active' ||
    org.tenant_slug !== scope.tenant_slug ||
    org.organization_id !== scope.organization_id
  )
    fail(
      'invalid_scope',
      403,
      'Information asset organization is missing, inactive or outside tenant.'
    );
  if (scope.project_id) {
    const project = loadProjectRecord(scope.project_id, options);
    if (
      !project ||
      project.status !== 'active' ||
      project.tenant_slug !== scope.tenant_slug ||
      project.organization_id !== scope.organization_id
    )
      fail(
        'invalid_scope',
        403,
        'Information asset project is missing, inactive or outside organization.'
      );
  }
}
export async function authorizeInformationAssetManagement(
  auth: SurfaceManagementAuthorization,
  scope: InformationAssetScope,
  mutation = false
) {
  assertInformationAssetScope(scope);
  const resolved = await authorizeOrganizationPeople(auth, scope.organization_id, mutation);
  assertInformationAssetCatalogAuthorization(mutation);
  if (resolved.tenantSlug !== scope.tenant_slug)
    fail('forbidden', 403, 'Information asset tenant mismatch.');
  if (scope.project_id) requireGrant(resolved.allowedProjectIds, scope.project_id);
  return resolved;
}
/** Grant only exact catalog resources; metadata checks include ancestors, never listings. */
export function withInformationAssetResources<T>(
  auth: SurfaceManagementAuthorization,
  scope: InformationAssetScope,
  files: string[],
  write: boolean,
  action: () => T,
  additionalReads: string[] = []
): T {
  const root = pathResolver.rootDir();
  const relative = (file: string) => {
    const result = path.relative(root, file).split(path.sep).join('/');
    if (!result || result.startsWith('../') || path.isAbsolute(result))
      fail('invalid_path', 400, 'Information asset resource outside repository.');
    return result;
  };
  const exact = files.map(relative);
  const reads = [...exact, ...additionalReads.map(relative)];
  const parents = new Set<string>();
  for (const file of reads)
    for (let dir = path.posix.dirname(file); dir !== '.'; dir = path.posix.dirname(dir))
      parents.add(dir);
  return withConciergeManagementAccess(
    {
      tenantSlug: scope.tenant_slug,
      organizationId: scope.organization_id,
      ...(scope.project_id ? { projectId: scope.project_id } : {}),
      reads,
      writes: write ? exact : [],
      metadata: [...reads, ...parents],
      mkdir: write ? [...parents] : [],
      writer: write,
      identity: { projectId: scope.project_id ?? null },
    },
    action
  );
}
export function assertInformationAssetRegularPath(file: string): void {
  const root = pathResolver.rootDir();
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative))
    fail('invalid_path', 400, 'Catalog outside repository.');
  assertSafeRepositoryPath(file, { allowMissingLeaf: true });
  try {
    const stat = safeLstat(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      fail('invalid_path', 400, 'Information asset catalog must be a regular file.');
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
  }
}
export function assertInformationAssetBinding(
  location: InformationAssetLocation,
  operation?: string
): void {
  const binding = loadServiceBindingRecord(location.binding_id);
  if (!binding) fail('binding_unavailable', 403, 'Information asset binding is unavailable.');
  const owner = resolveBindingOwner(binding);
  if (
    owner.owner_kind !== 'organization' ||
    owner.owner_ref !== location.scope.tenant_slug ||
    binding.tenant_slug !== location.scope.tenant_slug ||
    binding.service_id !== location.service_id ||
    (binding.project_id ?? undefined) !== location.scope.project_id
  )
    fail('binding_scope', 403, 'Information asset binding owner, service or project mismatch.');
  if (
    operation &&
    (!binding.allowed_actions.includes(operation) ||
      binding.approval_policy[operation] !== 'allowed')
  )
    fail('binding_policy', 403, 'Information asset capture action is not explicitly allowed.');
}
