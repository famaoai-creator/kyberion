import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { ConciergeViewerContext } from './viewer-context';
const mocks = vi.hoisted(() => ({
  viewer: null as ConciergeViewerContext | null,
  token: 'member-token',
  verify: vi.fn(),
  read: vi.fn(),
  directories: ['org-a', 'org-b'],
}));
vi.mock('./viewer-context', () => ({
  conciergeCredential: () => ({ token: mocks.token, source: 'header' }),
  resolveConciergeViewer: () => ({ context: mocks.viewer }),
}));
vi.mock('@agent/core/authority', () => ({
  withExecutionContextAsync: async (_role: string, fn: () => unknown) => fn(),
}));
vi.mock('@agent/core/foundation/resource-access-scope', () => ({
  runInResourceAccessScope: (_scope: unknown, fn: () => unknown) => fn(),
}));
vi.mock('@agent/core/secure-io', () => ({
  safeExistsSync: () => true,
  safeReaddir: () => mocks.directories,
}));
vi.mock('@agent/core/organization/tenant-registry', () => ({
  tenantProfilePath: (id: string) => 'knowledge/personal/tenants/' + id + '.json',
  readTenantProfile: () => ({ display_name: 'Tenant A' }),
}));
vi.mock('@agent/core/surface/surface-management-mutations', () => ({
  verifySurfaceManagementAuthorization: mocks.verify,
  readSurfaceManagementResource: mocks.read,
  SurfaceManagementError: class extends Error {
    constructor(
      public code: string,
      public status: number,
      message: string
    ) {
      super(message);
    }
  },
}));
import { managementAuthorization, managementSnapshot } from './management-server';
const request = () => new NextRequest('http://localhost/api/management?tenant=tenant-a');
function viewer(): ConciergeViewerContext {
  return {
    role: 'localadmin',
    tenantSlugs: ['tenant-a'],
    organizationIds: 'all',
    projectIds: 'all',
    tierAccess: ['confidential'],
    source: 'token',
    principalId: 'registered-owner',
    memberId: 'owner',
    principal: {
      actor: { kind: 'human', id: 'user:owner' },
      principalId: 'registered-owner',
      role: 'localadmin',
      tenantSlugs: ['tenant-a'],
      organizationIds: 'all',
      projectIds: 'all',
      tierAccess: ['confidential'],
      source: 'token',
      provider: 'test',
      assurance: 'high',
      memberId: 'owner',
    },
  };
}
beforeEach(() => {
  mocks.viewer = viewer();
  mocks.token = 'member-token';
  mocks.verify.mockReset().mockResolvedValue(undefined);
  mocks.read
    .mockReset()
    .mockImplementation(
      async (_auth: unknown, target: { organizationId: string; projectId?: string }) =>
        target.projectId
          ? {
              resource: {
                kind: 'project',
                record: {
                  project_id: target.projectId,
                  name: target.projectId,
                  summary: 'Summary',
                  status: 'active',
                },
                state: null,
              },
              version: 'project-version',
            }
          : {
              resource: {
                kind: 'organization',
                state: {
                  organization_id: target.organizationId,
                  name: target.organizationId,
                  status: 'active',
                  active_project_ids: target.organizationId === 'org-a' ? ['PRJ-A', 'PRJ-B'] : [],
                },
                purpose: { purpose: 'Purpose' },
              },
              version: 'org-version',
            }
    );
  mocks.directories = ['org-a', 'org-b'];
});
describe('management principal admission', () => {
  it('binds a human credential and one tenant without widening grants', () => {
    const auth = managementAuthorization(request());
    expect(auth).toMatchObject({
      actorId: 'user:owner',
      memberId: 'owner',
      tenantSlug: 'tenant-a',
    });
  });
  it('rejects a credential-less loopback owner', () => {
    mocks.token = '';
    expect(() => managementAuthorization(request())).toThrow(/credential/);
  });
  it.each(['loopback', 'anonymous', 'agent'] as const)('rejects principal source %s', (source) => {
    mocks.viewer!.principal!.source = source;
    expect(() => managementAuthorization(request())).toThrow();
  });
  it('rejects service actors and missing bound members', () => {
    mocks.viewer!.principal!.actor = { kind: 'service', id: 'service:test' };
    expect(() => managementAuthorization(request())).toThrow();
    mocks.viewer = viewer();
    mocks.viewer.memberId = undefined;
    expect(() => managementAuthorization(request())).toThrow();
  });
  it('rejects forged cross-tenant scope and expired credentials', () => {
    expect(() => managementAuthorization(request(), 'tenant-b')).toThrow();
    mocks.viewer!.principal!.expiresAt = '2000-01-01T00:00:00Z';
    expect(() => managementAuthorization(request())).toThrow();
  });
  it('intersects viewer and principal entity restrictions', () => {
    mocks.viewer!.organizationIds = ['org-a', 'org-b'];
    mocks.viewer!.principal!.organizationIds = ['org-b'];
    mocks.viewer!.projectIds = ['PRJ-A'];
    expect(managementAuthorization(request()).allowedOrganizationIds).toEqual(['org-b']);
    expect(managementAuthorization(request()).allowedProjectIds).toEqual(['PRJ-A']);
  });
  it('requires a tenant when more than one is allowed', () => {
    mocks.viewer!.tenantSlugs = ['tenant-a', 'tenant-b'];
    expect(() => managementAuthorization(request())).toThrow(/Select/);
  });
});
describe('management scoped projection', () => {
  it('keeps empty and sibling organizations visible after selecting one', async () => {
    const snapshot = await managementSnapshot(managementAuthorization(request()), 'org-a');
    expect(snapshot.organizations.map((org) => org.id)).toEqual(['org-a', 'org-b']);
    expect(snapshot.projects).toHaveLength(2);
    expect(snapshot.organization?.purpose).toBe('Purpose');
  });
  it('never reads an ungranted organization or project', async () => {
    mocks.viewer!.organizationIds = ['org-a'];
    mocks.viewer!.projectIds = ['PRJ-A'];
    const snapshot = await managementSnapshot(managementAuthorization(request()), 'org-a', 'PRJ-A');
    expect(snapshot.organizations).toHaveLength(1);
    expect(snapshot.projects.map((project) => project.id)).toEqual(['PRJ-A']);
    expect(
      mocks.read.mock.calls.every(
        (call) => call[1].organizationId === 'org-a' && call[1].projectId !== 'PRJ-B'
      )
    ).toBe(true);
    expect(snapshot.capabilities.createOrganization).toBe(false);
    expect(snapshot.capabilities.createProject).toBe(false);
  });
  it('rejects a project without a parent and unavailable child selection', async () => {
    const auth = managementAuthorization(request());
    await expect(managementSnapshot(auth, undefined, 'PRJ-A')).rejects.toThrow(/organization/);
    await expect(managementSnapshot(auth, 'org-b', 'PRJ-A')).rejects.toThrow(/not found/);
  });
  it('fails closed on fresh membership verification', async () => {
    mocks.verify.mockRejectedValue(new Error('suspended'));
    await expect(managementSnapshot(managementAuthorization(request()), 'org-a')).rejects.toThrow(
      'suspended'
    );
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
