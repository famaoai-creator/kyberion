import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveSurfaceManagementAuthorization } from './surface-management-mutations.js';
const st = vi.hoisted(() => ({
  member: {
    member_id: 'owner',
    status: 'active',
    memberships: [{ tenant_slug: 'acme', role: 'owner' }],
  },
  tenant: { tenant_slug: 'acme', status: 'active' },
  scope: vi.fn(),
  memberRead: vi.fn(),
  tenantRead: vi.fn(),
  tenantPath: vi.fn(),
}));
vi.mock('../authority.js', () => ({
  withExecutionContextAsync: async (_role: string, fn: () => unknown) => fn(),
  resolveRole: () => 'concierge',
}));
vi.mock('../foundation/resource-access-scope.js', () => ({
  runInResourceAccessScope: async (scope: unknown, fn: () => unknown) => {
    st.scope(scope);
    return fn();
  },
}));
vi.mock('../organization/member-registry.js', () => ({
  memberProfilePath: (id: string) => 'knowledge/personal/members/' + id + '.json',
  readMemberProfile: (id: string) => {
    st.memberRead(id);
    return st.member;
  },
}));
vi.mock('../organization/tenant-registry.js', () => ({
  tenantProfilePath: (id: string) => {
    st.tenantPath(id);
    return 'knowledge/personal/tenants/' + id + '.json';
  },
  readTenantProfile: (id: string) => {
    st.tenantRead(id);
    return st.tenant;
  },
}));
const auth = () => ({
  actorId: 'user:owner',
  memberId: 'owner',
  tenantSlug: 'acme',
  allowedOrganizationIds: 'all' as const,
  allowedProjectIds: 'all' as const,
});
beforeEach(() => {
  st.member = {
    member_id: 'owner',
    status: 'active',
    memberships: [{ tenant_slug: 'acme', role: 'owner' }],
  };
  st.tenant = { tenant_slug: 'acme', status: 'active' };
  vi.clearAllMocks();
});
describe('canonical company owner scope', () => {
  it('snapshots selector and grants before asynchronous member lookup', async () => {
    const input = { ...auth(), allowedOrganizationIds: ['acme'], allowedProjectIds: ['PRJ-ACME'] };
    const pending = resolveSurfaceManagementAuthorization(input);
    input.tenantSlug = 'other';
    input.allowedOrganizationIds.push('other');
    input.allowedProjectIds.push('PRJ-OTHER');
    const result = await pending;
    expect(result.tenantSlug).toBe('acme');
    expect(result.allowedOrganizationIds).toEqual(['acme']);
    expect(result.allowedProjectIds).toEqual(['PRJ-ACME']);
  });

  it('reconstructs an independent authorization from matching registry records', async () => {
    const input = auth();
    const result = await resolveSurfaceManagementAuthorization(input);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
    expect(st.scope.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ writeExact: [], mkdirExact: [] })
    );
    expect(st.scope.mock.calls[0]![0].metadataExact).toBeUndefined();
    expect(st.scope.mock.calls[0]![0].readExact).toEqual(['knowledge/personal/members/owner.json']);
    expect(st.tenantPath).toHaveBeenCalledWith('acme');
    expect(st.tenantRead).toHaveBeenCalledWith('acme');
  });
  it.each([
    '../acme',
    '/tmp/acme',
    'acme/../other',
    'acme\\other',
    '%2e%2e%2facme',
    'acme%2fother',
    'public',
    'acme\u0000',
  ])('rejects malformed selector %s before registry reads', async (tenantSlug) => {
    await expect(
      resolveSurfaceManagementAuthorization({ ...auth(), tenantSlug })
    ).rejects.toThrow();
    expect(st.memberRead).not.toHaveBeenCalled();
    expect(st.tenantPath).not.toHaveBeenCalled();
    expect(st.tenantRead).not.toHaveBeenCalled();
  });
  it('rejects an unowned valid tenant before forming any tenant path', async () => {
    await expect(
      resolveSurfaceManagementAuthorization({ ...auth(), tenantSlug: 'other' })
    ).rejects.toThrow();
    expect(st.memberRead).toHaveBeenCalledWith('owner');
    expect(st.tenantPath).not.toHaveBeenCalled();
    expect(st.tenantRead).not.toHaveBeenCalled();
  });
  it.each(['suspended', 'wrong-id', 'viewer'])(
    'rejects invalid member authority %s before tenant lookup',
    async (mode) => {
      if (mode === 'suspended') st.member.status = 'suspended';
      if (mode === 'wrong-id') st.member.member_id = 'another';
      if (mode === 'viewer') st.member.memberships[0]!.role = 'viewer';
      await expect(resolveSurfaceManagementAuthorization(auth())).rejects.toThrow();
      expect(st.tenantPath).not.toHaveBeenCalled();
    }
  );
  it.each(['suspended', 'mismatch'])('rejects invalid canonical tenant %s', async (mode) => {
    if (mode === 'suspended') st.tenant.status = 'suspended';
    else st.tenant.tenant_slug = 'other';
    await expect(resolveSurfaceManagementAuthorization(auth())).rejects.toThrow();
  });
});
