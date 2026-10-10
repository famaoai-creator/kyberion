import { checkAuthorizationShape, validate } from './surface-management-validation.js';
import {
  digest,
  fail,
  requireGrant,
  version,
  type SurfaceManagementAuthorization,
  type SurfaceManagementCommand,
  type SurfaceManagementResource,
  type SurfaceManagementResult,
} from './surface-management-contract.js';
export {
  SurfaceManagementError,
  organizationManagementVersion,
  projectManagementVersion,
  type SurfaceManagementAuthorization,
  type SurfaceManagementCommand,
  type SurfaceManagementResource,
  type SurfaceManagementResult,
} from './surface-management-contract.js';
/** Trusted HTTP mediator for four bounded, owner-authorized management commands. */
import * as path from 'node:path';
import { withExecutionContextAsync, resolveRole } from '../authority.js';
import { humanActor } from '../actor.js';
import { acquireLock, releaseLock } from '../foundation/lock-utils.js';
import { runInResourceAccessScope } from '../foundation/resource-access-scope.js';
import { readJsonIfPresent, writeJson } from '../foundation/json.js';
import { readTextFile } from '../foundation/text.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeMkdir, safeUnlinkSync, safeWriteFile } from '../secure-io.js';
import { auditChain } from '../governance/audit-chain.js';
import { readMemberProfile, memberProfilePath } from '../organization/member-registry.js';
import { readTenantProfile, tenantProfilePath } from '../organization/tenant-registry.js';
import {
  createManagedOrganization,
  updateManagedOrganizationMetadata,
} from '../organization/organization-management.js';
import {
  assertOrganizationId,
  loadOrganizationOperationalState,
  loadOrganizationPurpose,
  organizationOperationalStatePath,
  organizationPurposePath,
} from '../organization/organization-operating-model-persistence.js';
import {
  assertManagedProjectId,
  createManagedProjectForSurface,
  updateManagedProjectMetadata,
} from '../project/project-management.js';
import { assertProjectLifecycleOwner } from '../project/project-lifecycle-guards.js';
import { loadProjectRecord, projectRecordPath } from '../project/project-registry.js';
import {
  loadProjectOperationalState,
  projectOperationalStatePath,
} from '../project/project-operational-state-registry.js';

interface Receipt {
  commandHash: string;
  actorId: string;
  result: SurfaceManagementResult;
  auditPending: boolean;
}
const LOCK = 'surface-management-mutations';
const TIER = 'confidential' as const;
function relative(file: string): string {
  const result = path.relative(pathResolver.rootDir(), file).split(path.sep).join('/');
  if (!result || result.startsWith('../') || path.isAbsolute(result))
    fail('invalid_path', 400, 'A management path is outside the repository.');
  return result;
}
function directories(files: string[]): string[] {
  const result = new Set<string>();
  for (const file of files)
    for (let dir = path.posix.dirname(relative(file)); dir !== '.'; dir = path.posix.dirname(dir))
      result.add(dir);
  return [...result];
}
async function scoped<T>(
  auth: SurfaceManagementAuthorization,
  target: { organizationId?: string; projectId?: string },
  reads: string[],
  writes: string[],
  callback: () => T
): Promise<T> {
  return runInResourceAccessScope(
    {
      tenantSlug: auth.tenantSlug,
      ...target,
      readExact: [...new Set([...reads, ...writes].map(relative))],
      writeExact: writes.map(relative),
      mkdirExact: writes.length ? directories(writes) : [],
      allowProductKnowledgeRead: true,
      metadataExact: ['customer/' + auth.tenantSlug],
    },
    () =>
      withExecutionContextAsync(
        writes.length ? 'concierge_management_writer' : 'concierge_management_reader',
        callback,
        undefined,
        auth.tenantSlug,
        target.organizationId
      )
  );
}
/** Re-read authoritative membership and tenant after acquiring the mutation lock. */
export async function verifySurfaceManagementAuthorization(
  auth: SurfaceManagementAuthorization
): Promise<void> {
  checkAuthorizationShape(auth);
  await scoped(
    auth,
    {},
    [memberProfilePath(auth.memberId), tenantProfilePath(auth.tenantSlug)],
    [],
    () => {
      const member = readMemberProfile(auth.memberId);
      if (
        !member ||
        member.status !== 'active' ||
        !member.memberships.some(
          (membership) => membership.tenant_slug === auth.tenantSlug && membership.role === 'owner'
        )
      )
        fail('forbidden', 403, 'An active owner membership is required.');
      if (readTenantProfile(auth.tenantSlug)?.status !== 'active')
        fail('forbidden', 403, 'The tenant is not active.');
    }
  );
}
function targetFor(
  auth: SurfaceManagementAuthorization,
  command: SurfaceManagementCommand
): { organizationId: string; projectId?: string } {
  const id = digest([auth.actorId, auth.tenantSlug, command.requestId]).slice(0, 32);
  return {
    organizationId:
      command.operation === 'organization.create' ? 'org-' + id : command.organizationId,
    ...(command.operation === 'project.create'
      ? { projectId: 'PRJ-' + id.toUpperCase() }
      : command.operation === 'project.update'
        ? { projectId: command.projectId }
        : {}),
  };
}
function assertTargetGrants(
  auth: SurfaceManagementAuthorization,
  target: { organizationId: string; projectId?: string },
  operation?: SurfaceManagementCommand['operation']
): void {
  if (operation === 'organization.create') {
    if (auth.allowedOrganizationIds !== 'all')
      fail('forbidden', 403, 'Organization creation requires tenant-wide organization access.');
  } else requireGrant(auth.allowedOrganizationIds, target.organizationId);
  if (operation === 'project.create') {
    if (auth.allowedProjectIds !== 'all')
      fail('forbidden', 403, 'Project creation requires tenant-wide project access.');
  } else if (target.projectId) requireGrant(auth.allowedProjectIds, target.projectId);
}
function resourceFiles(
  auth: SurfaceManagementAuthorization,
  target: { organizationId: string; projectId?: string }
): string[] {
  return [
    organizationOperationalStatePath(target.organizationId, TIER, auth.tenantSlug),
    organizationPurposePath(target.organizationId, TIER, auth.tenantSlug),
    ...(target.projectId
      ? [
          projectRecordPath(target.projectId),
          projectOperationalStatePath(target.projectId, TIER, auth.tenantSlug),
        ]
      : []),
  ];
}
function readResource(
  auth: SurfaceManagementAuthorization,
  target: { organizationId: string; projectId?: string }
): SurfaceManagementResource {
  const query = { tier: TIER, tenantSlug: auth.tenantSlug };
  const organization = loadOrganizationOperationalState(target.organizationId, query);
  if (!organization) fail('not_found', 404, 'Organization not found.');
  if (!target.projectId) {
    const purpose = loadOrganizationPurpose(target.organizationId, query);
    if (
      safeExistsSync(organizationPurposePath(target.organizationId, TIER, auth.tenantSlug)) &&
      !purpose
    )
      fail('invalid_state', 409, 'Organization purpose is invalid.');
    return { kind: 'organization', state: organization, purpose };
  }
  const record = loadProjectRecord(target.projectId);
  if (
    !record ||
    record.tier !== TIER ||
    record.tenant_slug !== auth.tenantSlug ||
    record.organization_id !== target.organizationId
  )
    fail('not_found', 404, 'Project not found in this organization.');
  const state = loadProjectOperationalState(target.projectId, query);
  if (
    safeExistsSync(projectOperationalStatePath(target.projectId, TIER, auth.tenantSlug)) &&
    !state
  )
    fail('invalid_state', 409, 'Project operational state is invalid.');
  return { kind: 'project', record, state };
}
export async function readSurfaceManagementResource(
  auth: SurfaceManagementAuthorization,
  target: { organizationId: string; projectId?: string }
): Promise<{ resource: SurfaceManagementResource; version: string }> {
  checkAuthorizationShape(auth);
  assertOrganizationId(target.organizationId);
  if (target.projectId) assertManagedProjectId(target.projectId);
  assertTargetGrants(auth, target);
  if (!(await acquireLock(LOCK))) fail('busy', 409, 'Management is busy. Retry this request.');
  try {
    await verifySurfaceManagementAuthorization(auth);
    return await scoped(auth, target, resourceFiles(auth, target), [], () => {
      const resource = readResource(auth, target);
      return { resource, version: version(resource) };
    });
  } finally {
    releaseLock(LOCK);
  }
}
async function audit(
  auth: SurfaceManagementAuthorization,
  command: SurfaceManagementCommand,
  target: { organizationId: string; projectId?: string },
  result: 'allowed' | 'completed' | 'failed'
): Promise<void> {
  const role = resolveRole();
  if (!role) fail('runtime_unavailable', 503, 'Management runtime role is unavailable.');
  await withExecutionContextAsync(
    role,
    () =>
      auditChain.record({
        agentId: auth.actorId,
        actor: humanActor(auth.memberId),
        action: 'surface.management.' + result,
        operation: command.operation,
        result,
        correlationId: digest([auth.actorId, auth.tenantSlug, command.requestId]),
        tenantSlug: auth.tenantSlug,
        scope: {
          scope_kind: 'tenant',
          tier: TIER,
          tenant_slug: auth.tenantSlug,
          organization_id: target.organizationId,
          ...(target.projectId ? { project_id: target.projectId } : {}),
        },
        metadata: {
          member_id: auth.memberId,
          fields: Object.keys(command).filter((key) =>
            ['name', 'purpose', 'summary'].includes(key)
          ),
        },
      }),
    undefined,
    auth.tenantSlug,
    target.organizationId
  );
}
export async function executeSurfaceManagementMutation(
  auth: SurfaceManagementAuthorization,
  command: SurfaceManagementCommand
): Promise<SurfaceManagementResult> {
  checkAuthorizationShape(auth);
  validate(command);
  // An ambient worker must not escape its lifecycle prohibition by assuming a role.
  assertProjectLifecycleOwner();
  const target = targetFor(auth, command);
  assertTargetGrants(auth, target, command.operation);
  const receiptPath = pathResolver.rootResolve(
    'active/shared/runtime/surface-management/confidential/' +
      auth.tenantSlug +
      '/receipts/' +
      digest([auth.actorId, command.requestId]) +
      '.json'
  );
  const files = resourceFiles(auth, target);
  const writes = command.operation.startsWith('organization.')
    ? files
    : command.operation === 'project.create'
      ? [files[0]!, files[2]!]
      : [files[2]!, files[3]!];
  const reads = [...files, tenantProfilePath(auth.tenantSlug), receiptPath];
  let admitted = false;
  if (!(await acquireLock(LOCK))) fail('busy', 409, 'Management is busy. Retry this request.');
  try {
    await verifySurfaceManagementAuthorization(auth);
    const commandHash = digest(command);
    const previous = await scoped(auth, target, [receiptPath], [], () =>
      readJsonIfPresent<Receipt>(receiptPath)
    );
    let receipt: Receipt;
    let replayed = false;
    if (previous) {
      if (previous.commandHash !== commandHash || previous.actorId !== auth.actorId)
        fail(
          'idempotency_conflict',
          409,
          'This requestId was already used for a different command.'
        );
      receipt = previous;
      replayed = true;
    } else {
      await audit(auth, command, target, 'allowed');
      admitted = true;
      receipt = await scoped(auth, target, reads, [...writes, receiptPath], () => {
        const before = new Map(
          [...writes, receiptPath].map((file) => [
            file,
            safeExistsSync(file) ? readTextFile(file) : null,
          ])
        );
        if (command.operation === 'organization.create') {
          if (safeExistsSync(files[0]!) || safeExistsSync(files[1]!))
            fail('conflict', 409, 'Organization already exists.');
        } else {
          const resource = readResource(
            auth,
            command.operation === 'project.create'
              ? { organizationId: target.organizationId }
              : target
          );
          if ('expectedVersion' in command && command.expectedVersion !== version(resource))
            fail('version_conflict', 409, 'This record changed. Reload before editing.');
          if (command.operation === 'project.create' && safeExistsSync(files[2]!))
            fail('conflict', 409, 'Project already exists.');
        }
        try {
          if (command.operation === 'organization.create')
            createManagedOrganization({
              organizationId: target.organizationId,
              tenantSlug: auth.tenantSlug,
              tier: TIER,
              name: command.name,
              purpose: command.purpose,
            });
          else if (command.operation === 'organization.update')
            updateManagedOrganizationMetadata(
              { organizationId: target.organizationId, tenantSlug: auth.tenantSlug, tier: TIER },
              {
                ...(command.name !== undefined ? { name: command.name } : {}),
                ...(command.purpose !== undefined ? { purpose: command.purpose } : {}),
              }
            );
          else if (command.operation === 'project.create')
            createManagedProjectForSurface({
              project_id: target.projectId!,
              organization_id: target.organizationId,
              tenant_slug: auth.tenantSlug,
              tier: TIER,
              name: command.name,
              summary: command.summary,
            });
          else
            updateManagedProjectMetadata(
              { ...target, projectId: target.projectId!, tenantSlug: auth.tenantSlug },
              {
                ...(command.name !== undefined ? { name: command.name } : {}),
                ...(command.summary !== undefined ? { summary: command.summary } : {}),
              }
            );
          const resource = readResource(auth, target);
          const next: Receipt = {
            commandHash,
            actorId: auth.actorId,
            auditPending: true,
            result: {
              operation: command.operation,
              ...target,
              resource,
              version: version(resource),
              replayed: false,
            },
          };
          safeMkdir(path.dirname(receiptPath), { recursive: true });
          writeJson(receiptPath, next);
          return next;
        } catch (error) {
          for (const [file, content] of before) {
            if (content !== null) safeWriteFile(file, content);
            else if (safeExistsSync(file)) safeUnlinkSync(file);
          }
          throw error;
        }
      });
    }
    if (receipt.auditPending) {
      try {
        await audit(auth, command, target, 'completed');
        const completed = { ...receipt, auditPending: false };
        await scoped(auth, target, [receiptPath], [receiptPath], () =>
          writeJson(receiptPath, completed)
        );
        receipt = completed;
      } catch {
        // The durable receipt proves commitment. Retry audit, never replay writes.
      }
    }
    return {
      ...receipt.result,
      replayed,
      ...(receipt.auditPending ? { auditPending: true as const } : {}),
    };
  } catch (error) {
    if (admitted) {
      try {
        await audit(auth, command, target, 'failed');
      } catch {
        /* Preserve the mutation error. */
      }
    }
    throw error;
  } finally {
    releaseLock(LOCK);
  }
}
