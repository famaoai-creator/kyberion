import { acquireLock } from '../foundation/lock-utils.js';
import * as io from '../secure-io.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeRmSync } from '../secure-io.js';
import { writeTenantProfile, tenantProfilePath } from '../organization/tenant-registry.js';
import {
  writeMemberProfile,
  memberProfilePath,
  readMemberProfile,
} from '../organization/member-registry.js';
import {
  loadOrganizationOperationalState,
  saveOrganizationOperationalState,
} from '../organization/organization-operating-model-persistence.js';
import { readTextFile } from '../foundation/text.js';
import * as json from '../foundation/json.js';
import * as projects from '../project/project-registry.js';
import * as states from '../project/project-operational-state-registry.js';
import {
  executeSurfaceManagementMutation,
  readSurfaceManagementResource,
  type SurfaceManagementAuthorization,
  type SurfaceManagementCommand,
} from './surface-management-mutations.js';
import { auditChain } from '../governance/audit-chain.js';

vi.mock('../governance/audit-chain.js', () => ({ auditChain: { record: vi.fn() } }));
vi.mock('../foundation/lock-utils.js', () => ({
  acquireLock: vi.fn(async () => true),
  releaseLock: vi.fn(),
  registerLockIo: vi.fn(),
}));
const tenant = 'tenant-surface-management-test';
const member = 'surface-management-owner-test';
const auth: SurfaceManagementAuthorization = {
  actorId: 'user:' + member,
  memberId: member,
  tenantSlug: tenant,
  allowedOrganizationIds: 'all',
  allowedProjectIds: 'all',
};
const projectIds = new Set<string>();
function rememberId(command: SurfaceManagementCommand): void {
  if (command.operation === 'project.create')
    projectIds.add(
      'PRJ-' +
        createHash('sha256')
          .update(JSON.stringify([auth.actorId, tenant, command.requestId]))
          .digest('hex')
          .slice(0, 32)
          .toUpperCase()
    );
}
async function execute(command: SurfaceManagementCommand, authorization = auth) {
  rememberId(command);
  return executeSurfaceManagementMutation(authorization, command);
}
async function createOrg(requestId = 'org-create-001') {
  return execute({
    operation: 'organization.create',
    requestId,
    name: 'Operations',
    purpose: 'Deliver safely',
  });
}
async function createProject(organizationId: string, requestId = 'project-create-001') {
  return execute({
    operation: 'project.create',
    requestId,
    organizationId,
    name: 'Delivery',
    summary: 'Bounded project',
  });
}
function cleanup(): void {
  for (const id of projectIds) safeRmSync(projects.projectRecordPath(id), { force: true });
  projectIds.clear();
  for (const prefix of [
    'active/organizations/confidential/',
    'active/projects/confidential/',
    'active/shared/runtime/surface-management/confidential/',
    'knowledge/confidential/',
  ])
    safeRmSync(pathResolver.rootResolve(prefix + tenant), { recursive: true, force: true });
  safeRmSync(memberProfilePath(member), { force: true });
  safeRmSync(tenantProfilePath(tenant), { force: true });
}
beforeEach(() => {
  vi.stubEnv('KYBERION_SUDO', 'true');
  vi.stubEnv('KYBERION_PERSONA', 'sovereign');
  vi.stubEnv('MISSION_ROLE', '');
  vi.stubEnv('SYSTEM_ROLE', '');
  vi.stubEnv('KYBERION_TENANT', tenant);
  vi.stubEnv('KYBERION_ENTITY_GOVERNANCE', 'enforce');
  cleanup();
  writeTenantProfile({
    tenant_slug: tenant,
    display_name: 'Management test',
    status: 'active',
    assigned_role: 'customer',
  });
  writeMemberProfile({
    member_id: member,
    display_name: 'Test owner',
    status: 'active',
    memberships: [{ tenant_slug: tenant, role: 'owner' }],
    access_registrations: [],
    created_at: '2026-10-10T00:00:00Z',
    updated_at: '2026-10-10T00:00:00Z',
  });
  vi.mocked(auditChain.record).mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.stubEnv('KYBERION_PERSONA', 'sovereign');
  cleanup();
  vi.unstubAllEnvs();
});
describe('bounded surface management service', () => {
  it('runs admitted owner operations without SUDO or sovereign persona', async () => {
    vi.stubEnv('KYBERION_SUDO', 'false');
    vi.stubEnv('KYBERION_PERSONA', '');
    vi.stubEnv('SYSTEM_ROLE', 'concierge');
    try {
      const org = await createOrg();
      const project = await createProject(org.organizationId);
      expect(project.resource).toMatchObject({
        kind: 'project',
        record: { tenant_slug: tenant, organization_id: org.organizationId },
      });
      const edited = await execute({
        operation: 'project.update',
        requestId: 'project-update-001',
        organizationId: org.organizationId,
        projectId: project.projectId!,
        expectedVersion: project.version,
        name: 'Owner edit',
      });
      expect(edited.resource).toMatchObject({ kind: 'project', record: { name: 'Owner edit' } });
    } finally {
      vi.stubEnv('KYBERION_SUDO', 'true');
      vi.stubEnv('SYSTEM_ROLE', '');
    }
  });
  it('creates and edits an organization, exact replays never repeat mutation', async () => {
    const command = {
      operation: 'organization.create',
      requestId: 'org-create-001',
      name: 'Operations',
      purpose: 'Deliver safely',
    } as const;
    const first = await execute(command);
    expect(first.resource).toMatchObject({
      kind: 'organization',
      state: { tenant_slug: tenant, name: 'Operations' },
      purpose: { purpose: 'Deliver safely' },
    });
    expect(first.replayed).toBe(false);
    expect(await execute(command)).toMatchObject({
      organizationId: first.organizationId,
      version: first.version,
      replayed: true,
    });
    const update = await execute({
      operation: 'organization.update',
      requestId: 'org-update-001',
      organizationId: first.organizationId,
      expectedVersion: first.version,
      name: 'New operations',
    });
    expect(update.version).not.toBe(first.version);
    expect(update.resource).toMatchObject({
      kind: 'organization',
      purpose: { name: 'New operations', purpose: 'Deliver safely' },
    });
    expect(
      await readSurfaceManagementResource(auth, { organizationId: first.organizationId })
    ).toMatchObject({ version: update.version });
  });
  it('rejects stale edits and conflicting request IDs', async () => {
    const org = await createOrg();
    await expect(
      execute({ operation: 'organization.create', requestId: 'org-create-001', name: 'Different' })
    ).rejects.toMatchObject({ code: 'idempotency_conflict', status: 409 });
    await execute({
      operation: 'organization.update',
      requestId: 'org-update-001',
      organizationId: org.organizationId,
      expectedVersion: org.version,
      name: 'New',
    });
    await expect(
      execute({
        operation: 'organization.update',
        requestId: 'org-update-002',
        organizationId: org.organizationId,
        expectedVersion: org.version,
        name: 'Stale',
      })
    ).rejects.toMatchObject({ code: 'version_conflict', status: 409 });
  });
  it('links project creation to its parent and metadata does not reconcile or change lifecycle', async () => {
    const org = await createOrg();
    const project = await createProject(org.organizationId);
    const id = project.projectId!;
    expect(
      loadOrganizationOperationalState(org.organizationId, {
        tier: 'confidential',
        tenantSlug: tenant,
      })?.active_project_ids
    ).toEqual([id]);
    states.saveProjectOperationalState({
      project_id: id,
      tier: 'confidential',
      tenant_slug: tenant,
      name: 'Delivery',
      summary: 'Bounded project',
      status: 'paused',
      active_mission_ids: ['MSN-KEEP'],
      active_track_ids: ['TRK-KEEP'],
      active_task_session_ids: ['TSK-KEEP'],
    });
    const before = await readSurfaceManagementResource(auth, {
      organizationId: org.organizationId,
      projectId: id,
    });
    vi.spyOn(states, 'listProjectOperationalStates').mockImplementation(() => {
      throw new Error('No enumeration');
    });
    vi.spyOn(projects, 'listProjectRecords').mockImplementation(() => {
      throw new Error('No enumeration');
    });
    const edited = await execute({
      operation: 'project.update',
      requestId: 'project-update-001',
      organizationId: org.organizationId,
      projectId: id,
      expectedVersion: before.version,
      name: 'Renamed',
      summary: 'Updated',
    });
    expect(edited.resource).toMatchObject({
      kind: 'project',
      record: { name: 'Renamed', summary: 'Updated', status: 'draft' },
      state: {
        name: 'Renamed',
        summary: 'Updated',
        status: 'paused',
        active_mission_ids: ['MSN-KEEP'],
        active_track_ids: ['TRK-KEEP'],
        active_task_session_ids: ['TSK-KEEP'],
      },
    });
  });
  it('rolls back creation and parent links when receipt persistence fails', async () => {
    const org = await createOrg();
    const before = loadOrganizationOperationalState(org.organizationId, {
      tier: 'confidential',
      tenantSlug: tenant,
    });
    const actual = json.writeJson;
    vi.spyOn(json, 'writeJson').mockImplementationOnce(() => {
      throw new Error('Receipt unavailable');
    });
    await expect(createProject(org.organizationId)).rejects.toThrow('Receipt unavailable');
    expect(
      loadOrganizationOperationalState(org.organizationId, {
        tier: 'confidential',
        tenantSlug: tenant,
      })
    ).toEqual(before);
    for (const id of projectIds) expect(projects.loadProjectRecord(id)).toBeNull();
    vi.mocked(json.writeJson).mockImplementation(actual);
    expect((await createProject(org.organizationId)).replayed).toBe(false);
  });
  it('restores exact project and projection bytes after projection write failure', async () => {
    const org = await createOrg();
    const project = await createProject(org.organizationId);
    const id = project.projectId!;
    states.saveProjectOperationalState({
      project_id: id,
      tier: 'confidential',
      tenant_slug: tenant,
      name: 'Delivery',
      summary: 'Bounded project',
      status: 'draft',
    });
    const statePath = states.projectOperationalStatePath(id, 'confidential', tenant);
    const before = [readTextFile(projects.projectRecordPath(id)), readTextFile(statePath)];
    const resource = await readSurfaceManagementResource(auth, {
      organizationId: org.organizationId,
      projectId: id,
    });
    const actualWrite = io.safeWriteFile;
    let failed = false;
    vi.spyOn(io, 'safeWriteFile').mockImplementation((file, data, options) => {
      if (file === statePath && !failed) {
        failed = true;
        throw new Error('Projection unavailable');
      }
      return actualWrite(file, data, options);
    });
    await expect(
      execute({
        operation: 'project.update',
        requestId: 'project-update-001',
        organizationId: org.organizationId,
        projectId: id,
        expectedVersion: resource.version,
        name: 'New',
      })
    ).rejects.toThrow('Projection unavailable');
    expect([readTextFile(projects.projectRecordPath(id)), readTextFile(statePath)]).toEqual(before);
  });
  it('keeps optional fields absent in a sparse existing projection', async () => {
    const org = await createOrg();
    const project = await createProject(org.organizationId);
    const id = project.projectId!;
    const file = states.projectOperationalStatePath(id, 'confidential', tenant);
    io.safeWriteFile(
      file,
      JSON.stringify({
        project_id: id,
        tier: 'confidential',
        tenant_slug: tenant,
        name: 'Delivery',
        summary: 'Bounded project',
        status: 'draft',
        updated_at: '2026-10-10T00:00:00Z',
      })
    );
    const current = await readSurfaceManagementResource(auth, {
      organizationId: org.organizationId,
      projectId: id,
    });
    await execute({
      operation: 'project.update',
      requestId: 'sparse-update-001',
      organizationId: org.organizationId,
      projectId: id,
      expectedVersion: current.version,
      name: 'Renamed',
    });
    expect(json.readJson<Record<string, unknown>>(file)).not.toHaveProperty('active_mission_ids');
  });
  it('retains commitment after completion-audit failure and retries only the audit', async () => {
    vi.mocked(auditChain.record).mockImplementation((entry) => {
      if (entry.action === 'surface.management.completed') throw new Error('Audit unavailable');
      return undefined as never;
    });
    const first = await createOrg();
    expect(first.auditPending).toBe(true);
    vi.mocked(auditChain.record).mockReset();
    const replay = await createOrg();
    expect(replay).toMatchObject({ replayed: true, version: first.version });
    expect(replay.auditPending).toBeUndefined();
    expect(vi.mocked(auditChain.record).mock.calls[0]?.[0]).toMatchObject({
      actor: { kind: 'human', id: auth.actorId },
      scope: { tenant_slug: tenant, organization_id: first.organizationId },
      result: 'completed',
    });
  });
  it('fails before writing when admission audit is unavailable', async () => {
    vi.mocked(auditChain.record).mockImplementation(() => {
      throw new Error('Audit unavailable');
    });
    await expect(createOrg()).rejects.toThrow('Audit unavailable');
    expect(
      safeExistsSync(pathResolver.rootResolve('active/organizations/confidential/' + tenant))
    ).toBe(false);
  });
  it('freshly rejects suspended members and narrowed grants including replays', async () => {
    const org = await createOrg();
    await expect(createOrgWithAuth({ ...auth, allowedOrganizationIds: [] })).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      readSurfaceManagementResource(
        { ...auth, allowedOrganizationIds: [] },
        { organizationId: org.organizationId }
      )
    ).rejects.toMatchObject({ status: 403 });
    writeMemberProfile({ ...readMemberProfile(member)!, status: 'suspended' });
    await expect(createOrg()).rejects.toMatchObject({ status: 403 });
  });
  it('rechecks credential expiry after waiting for the lock and before replay', async () => {
    const now = Date.now();
    vi.mocked(acquireLock).mockImplementationOnce(async () => {
      vi.setSystemTime(now + 2000);
      return true;
    });
    await expect(
      createOrgWithAuth({ ...auth, expiresAt: new Date(now + 1000).toISOString() })
    ).rejects.toMatchObject({ code: 'expired', status: 403 });
    expect(
      safeExistsSync(pathResolver.rootResolve('active/organizations/confidential/' + tenant))
    ).toBe(false);
    vi.useRealTimers();
    await createOrg();
    await expect(
      createOrgWithAuth({ ...auth, expiresAt: new Date(now - 1000).toISOString() })
    ).rejects.toMatchObject({ code: 'expired' });
    await expect(createOrgWithAuth({ ...auth, expiresAt: 'not-a-date' })).rejects.toMatchObject({
      code: 'expired',
    });
  });
  it('rejects unsupported fields, blank patches and worker contexts', async () => {
    await expect(
      execute({
        operation: 'organization.create',
        requestId: 'org-create-001',
        name: 'No',
        tier: 'personal',
      } as never)
    ).rejects.toMatchObject({ status: 400 });
    const org = await createOrg();
    await expect(
      execute({
        operation: 'organization.update',
        requestId: 'org-update-001',
        organizationId: org.organizationId,
        expectedVersion: org.version,
      })
    ).rejects.toMatchObject({ status: 400 });
    vi.stubEnv('KYBERION_PERSONA', 'worker');
    await expect(createProject(org.organizationId)).rejects.toThrow('mission owner');
  });
  it('refuses creation under a paused organization', async () => {
    const org = await createOrg();
    const query = { tier: 'confidential' as const, tenantSlug: tenant };
    saveOrganizationOperationalState({
      ...loadOrganizationOperationalState(org.organizationId, query)!,
      status: 'paused',
    });
    await expect(createProject(org.organizationId)).rejects.toThrow('project creation is denied');
  });
});
async function createOrgWithAuth(authorization: SurfaceManagementAuthorization) {
  return execute(
    {
      operation: 'organization.create',
      requestId: 'org-create-001',
      name: 'Operations',
      purpose: 'Deliver safely',
    },
    authorization
  );
}
