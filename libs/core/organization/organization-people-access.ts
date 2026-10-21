/** Shared owner authorization and exact IO boundaries for people management. */
import * as path from 'node:path';
import { withExecutionContext, withExecutionContextAsync, resolveRole } from '../authority.js';
import { runInResourceAccessScope } from '../foundation/resource-access-scope.js';
import { pathResolver } from '../path-resolver.js';
import { assertProjectLifecycleOwner } from '../project/project-lifecycle-guards.js';
import {
  resolveSurfaceManagementAuthorization,
  verifySurfaceManagementAuthorization,
} from '../surface/surface-management-mutations.js';
import {
  fail,
  requireGrant,
  type SurfaceManagementAuthorization,
} from '../surface/surface-management-contract.js';
import { assertOrganizationId } from './organization-operating-model-persistence.js';
import { acquireLock, releaseLock } from '../foundation/lock-utils.js';
import { auditChain } from '../governance/audit-chain.js';

export type OrganizationPeopleAuthorization = SurfaceManagementAuthorization;

export async function authorizeOrganizationPeople(
  auth: OrganizationPeopleAuthorization,
  organizationId?: string,
  mutation = false
): Promise<OrganizationPeopleAuthorization> {
  if (mutation) assertProjectLifecycleOwner();
  const resolved = await resolveSurfaceManagementAuthorization(auth);
  if (organizationId !== undefined) {
    assertOrganizationId(organizationId);
    requireGrant(resolved.allowedOrganizationIds, organizationId);
  }
  return resolved;
}

export async function verifyOrganizationPeople(
  auth: OrganizationPeopleAuthorization
): Promise<void> {
  await verifySurfaceManagementAuthorization(auth);
}

export async function withOrganizationPeopleMutation<T>(action: () => Promise<T>): Promise<T> {
  if (!(await acquireLock('organization-people-management')))
    fail('busy', 409, 'People management is busy. Refresh and retry.');
  try {
    return await action();
  } finally {
    releaseLock('organization-people-management');
  }
}

export async function recordPeopleManagementAudit(
  auth: Pick<OrganizationPeopleAuthorization, 'actorId' | 'tenantSlug'>,
  action: string,
  operation: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await withExecutionContextAsync(
    resolveRole() ?? 'sovereign_concierge',
    () =>
      auditChain.record({
        agentId: auth.actorId,
        action,
        operation,
        result: 'completed',
        tenantSlug: auth.tenantSlug,
        metadata,
      }),
    undefined,
    auth.tenantSlug
  );
}

function relative(file: string): string {
  const value = path.relative(pathResolver.rootDir(), file).split(path.sep).join('/');
  if (!value || value.startsWith('../') || path.isAbsolute(value))
    fail('invalid_path', 400, 'People management path is outside the repository.');
  return value;
}

export function withPeopleResourcesSync<T>(
  auth: OrganizationPeopleAuthorization,
  resources: {
    organizationId?: string;
    reads: string[];
    writes?: string[];
    role?: 'sovereign_concierge' | 'mission_controller';
  },
  action: () => T
): T {
  const writes = resources.writes ?? [];
  const mkdir = new Set<string>();
  for (const file of writes)
    for (let dir = path.posix.dirname(relative(file)); dir !== '.'; dir = path.posix.dirname(dir))
      mkdir.add(dir);
  return runInResourceAccessScope(
    {
      tenantSlug: auth.tenantSlug,
      ...(resources.organizationId ? { organizationId: resources.organizationId } : {}),
      readExact: [...new Set([...resources.reads, ...writes].map(relative))],
      writeExact: writes.map(relative),
      mkdirExact: [...mkdir],
      allowProductKnowledgeRead: true,
    },
    () =>
      withExecutionContext(
        resources.role ??
          (writes.length ? 'concierge_management_writer' : 'concierge_management_reader'),
        action,
        undefined,
        auth.tenantSlug,
        resources.organizationId
      )
  );
}

export async function withPeopleResources<T>(
  auth: OrganizationPeopleAuthorization,
  resources: Parameters<typeof withPeopleResourcesSync>[1],
  action: () => T
): Promise<T> {
  return withPeopleResourcesSync(auth, resources, action);
}
