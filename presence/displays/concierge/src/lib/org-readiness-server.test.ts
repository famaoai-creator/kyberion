import { beforeEach, describe, expect, it, vi } from 'vitest';

const members = vi.hoisted(() => ({
  byMember: {} as Record<string, { id: string; display_name: string; role?: 'owner' | 'approver' }>,
}));
vi.mock('./front-desk-member', () => ({
  resolveConciergeDecidedBy: vi.fn((viewer: { memberId?: string }, tenant?: string) => {
    const who = viewer.memberId ? members.byMember[viewer.memberId] : undefined;
    return who && tenant === 'acme' ? who : who ? { ...who, role: undefined } : null;
  }),
}));
vi.mock('@agent/core/organization/tenant-registry', () => ({
  listTenantProfileSlugs: vi.fn(() => ['acme', 'other-co']),
  readTenantProfile: vi.fn(),
}));
vi.mock('@agent/core/organization/member-registry', () => ({
  listMemberIds: vi.fn(() => []),
  readMemberProfile: vi.fn(),
}));
vi.mock('@agent/core/service/service-binding-registry', () => ({
  listServiceBindingRecords: vi.fn(() => []),
}));

import { readOrgReadiness, type OrgReadinessDeps } from './org-readiness-server';

const NOW = new Date('2026-10-01T09:00:00.000Z');
const viewer = (over: Record<string, unknown> = {}) =>
  ({ tenantSlugs: ['acme'], source: 'token', role: 'localadmin', ...over }) as never;
const deps = (over: Partial<OrgReadinessDeps> = {}): OrgReadinessDeps => ({
  tenantStatus: () => 'active',
  memberCount: () => 1,
  pendingInvites: () => 0,
  organizationConnections: () => 0,
  charterInForce: () => false,
  ...over,
});

describe('readOrgReadiness', () => {
  beforeEach(() => {
    members.byMember = {
      owner: { id: 'user:owner', display_name: 'Owner', role: 'owner' },
      approver: { id: 'user:approver', display_name: 'Appr', role: 'approver' },
      viewer: { id: 'user:viewer', display_name: 'View' },
    };
  });
  it('owners and approvers of the tenant see its list; viewers and strangers see nothing', () => {
    expect(readOrgReadiness(viewer({ memberId: 'owner' }), NOW, deps())).toHaveLength(1);
    expect(readOrgReadiness(viewer({ memberId: 'approver' }), NOW, deps())).toHaveLength(1);
    expect(readOrgReadiness(viewer({ memberId: 'viewer' }), NOW, deps())).toEqual([]);
    expect(readOrgReadiness(viewer({}), NOW, deps())).toEqual([]);
  });
  it("only the viewer's own tenants are listed, however the client asks", () => {
    const r = readOrgReadiness(viewer({ memberId: 'owner', tenantSlugs: ['acme'] }), NOW, deps());
    expect(r.map((o) => o.tenant_slug)).toEqual(['acme']);
  });
  it('reflects what the data sources report', () => {
    const [org] = readOrgReadiness(
      viewer({ memberId: 'owner' }),
      NOW,
      deps({ memberCount: () => 3, organizationConnections: () => 1, charterInForce: () => true })
    );
    expect(org.steps.map((s) => [s.id, s.done])).toEqual([
      ['organization', true],
      ['members', true],
      ['connections', true],
      ['charter', true],
    ]);
    expect(org.all_done).toBe(true);
  });
});
