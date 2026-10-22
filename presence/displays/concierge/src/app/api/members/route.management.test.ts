import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
const s = vi.hoisted(() => ({
  create: vi.fn(),
  hash: vi.fn(),
  viewer: {
    source: 'loopback',
    role: 'localadmin',
    tenantSlugs: ['acme', 'beta'],
    organizationIds: 'all',
    projectIds: 'all',
    tierAccess: ['confidential', 'personal'],
  },
}));
vi.mock('@agent/core/authority', () => ({
  withExecutionContext: (_role: string, action: () => unknown) => action(),
}));
vi.mock('@agent/core/organization/member-registry', () => ({
  isValidMemberId: (id: string) => /^[a-z][a-z0-9-]{1,30}$/.test(id),
  listMemberIds: () => ['owner'],
  readMemberProfile: () => ({
    member_id: 'owner',
    display_name: 'Owner',
    status: 'active',
    memberships: [
      { tenant_slug: 'acme', role: 'owner' },
      { tenant_slug: 'beta', role: 'owner' },
    ],
    access_registrations: [],
  }),
}));
vi.mock('@agent/core/organization/member-management', () => ({
  createManagedMember: s.create,
  managedMemberVersion: () => 'v'.repeat(64),
}));
vi.mock('../../../lib/api-guard', () => ({ requireConciergeMutationAccess: () => null }));
vi.mock('../../../lib/viewer-context', () => ({
  resolveConciergeViewer: () => ({ context: s.viewer }),
  conciergeErrorResponse: (error: unknown, status: number) =>
    new Response(JSON.stringify({ error: String(error) }), { status }),
}));
vi.mock('../../../lib/selected-tenant', () => ({
  resolveConciergeSelectedViewer: () => ({
    viewer: s.viewer,
    context: { ...s.viewer, tenantSlugs: ['acme'] },
  }),
  scopeMembershipList: (rows: unknown[]) => rows,
}));
vi.mock('../../../lib/front-desk-member', () => ({
  conciergeFrontDeskRoleForTenant: () => 'owner',
}));
vi.mock('../../../lib/member-management-server', async () => {
  const { SurfaceManagementError } =
    await import('@agent/core/surface/surface-management-mutations');
  return {
    memberManagementPrincipal: () => ({ memberId: 'owner', allowedTenantSlugs: ['acme', 'beta'] }),
    memberManagementContextId: s.hash,
    assertMemberManagementContext: (_viewer: unknown, expected: unknown) => {
      if (expected !== undefined && expected !== 'a'.repeat(64))
        throw new SurfaceManagementError('context_changed', 403, 'Refresh identity');
    },
  };
});
import { GET, POST } from './route.js';
function request(body: unknown = {}): NextRequest {
  return { headers: new Headers(), json: async () => body } as unknown as NextRequest;
}
describe('member list/create identity binding', () => {
  beforeEach(() => {
    s.hash.mockReset();
    s.hash.mockReturnValue('a'.repeat(64));
    s.create.mockReset();
    s.create.mockResolvedValue({
      member: {
        member_id: 'carol',
        display_name: 'Carol',
        status: 'active',
        memberships: [{ tenant_slug: 'acme', role: 'viewer' }],
        access_registrations: [],
      },
    });
  });
  it('binds GET to the full authenticated viewer rather than the selected narrowing', async () => {
    const response = GET(request());
    const payload = await response.json();
    expect(payload.context_id).toBe('a'.repeat(64));
    expect(s.hash).toHaveBeenCalledWith(s.viewer);
    expect(payload.members[0]).toMatchObject({ version: 'v'.repeat(64), is_local_owner: true });
  });
  it('rejects a stale identity context before creating or issuing a token', async () => {
    const response = await POST(
      request({
        member_id: 'carol',
        display_name: 'Carol',
        tenant_slug: 'acme',
        role: 'viewer',
        issue_token: true,
        expected_context_id: 'b'.repeat(64),
      })
    );
    expect(response.status).toBe(403);
    expect(s.create).not.toHaveBeenCalled();
  });
  it('delegates a matching create context to the same shared service as CLI', async () => {
    const response = await POST(
      request({
        member_id: 'carol',
        display_name: 'Carol',
        tenant_slug: 'acme',
        role: 'viewer',
        expected_context_id: 'a'.repeat(64),
      })
    );
    expect(response.status).toBe(200);
    expect(s.create).toHaveBeenCalledWith(
      { memberId: 'owner', allowedTenantSlugs: ['acme', 'beta'] },
      {
        memberId: 'carol',
        displayName: 'Carol',
        tenantSlug: 'acme',
        role: 'viewer',
        issueToken: false,
      }
    );
  });
});
