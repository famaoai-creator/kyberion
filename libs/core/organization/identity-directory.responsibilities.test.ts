import { beforeEach, describe, expect, it, vi } from 'vitest';
const s = vi.hoisted(() => ({
  assignments: {} as Record<string, { status: string; role_ids: string[] }>,
}));
vi.mock('./member-registry.js', () => ({
  listMemberIds: () => ['owner', 'alice'],
  readMemberProfile: (id: string) => ({
    member_id: id,
    display_name: id,
    status: 'active',
    memberships: [{ tenant_slug: 'acme', role: id === 'owner' ? 'owner' : 'viewer' }],
  }),
}));
vi.mock('../agent/agent-identity.js', () => ({
  listAgentIdentities: () => [
    {
      nhi_id: 'kyberion://agent/org-home/helper',
      kind: 'agent',
      affiliation: { organization_id: 'org-home', tenant_slug: 'acme' },
      lifecycle_status: 'active',
    },
  ],
  getAgentIdentity: () => null,
}));
vi.mock('../nhi-lifecycle-governance.js', () => ({ listOrphanNhiIdentities: () => [] }));
vi.mock('./organization-participants.js', () => ({
  readOrganizationResponsibilityForActor: (
    scope: { organizationId: string; tenantSlug: string },
    actor: string
  ) =>
    scope.organizationId === 'org-selected' && scope.tenantSlug === 'acme'
      ? (s.assignments[actor] ?? null)
      : null,
}));
import { listIdentityDirectory, showIdentity } from './identity-directory.js';
describe('identity organizational responsibility projection', () => {
  beforeEach(() => {
    s.assignments = {};
  });
  it('marks the canonical local human owner', () => {
    expect(
      listIdentityDirectory({ kind: 'human' }).find((row) => row.actor === 'user:owner')
    ).toMatchObject({ is_local_owner: true });
    expect(showIdentity('user:owner')).toMatchObject({ is_local_owner: true });
  });
  it('filters human organization membership by responsibility assignment, not tenant access alone', () => {
    s.assignments['user:alice'] = { status: 'active', role_ids: ['reviewer', 'implementer'] };
    const rows = listIdentityDirectory({
      organization_id: 'org-selected',
      tenant_slug: 'acme',
      kind: 'human',
    });
    expect(rows.map((row) => row.actor)).toEqual(['user:alice']);
    expect(rows[0]).toMatchObject({
      organization_responsibilities: [{ role_ids: ['reviewer', 'implementer'] }],
    });
    expect(listIdentityDirectory({ organization_id: 'org-selected', kind: 'human' })).toEqual([]);
  });
  it('includes agents assigned outside their immutable home organization', () => {
    s.assignments['kyberion://agent/org-home/helper'] = {
      status: 'active',
      role_ids: ['reviewer'],
    };
    const rows = listIdentityDirectory({
      organization_id: 'org-selected',
      tenant_slug: 'acme',
      kind: 'agent',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      record: { affiliation: { organization_id: 'org-home' } },
      organization_responsibilities: [{ role_ids: ['reviewer'] }],
    });
    s.assignments['kyberion://agent/org-home/helper'].status = 'removed';
    expect(
      listIdentityDirectory({ organization_id: 'org-selected', tenant_slug: 'acme', kind: 'agent' })
    ).toEqual([]);
    expect(
      listIdentityDirectory({ organization_id: 'org-home', tenant_slug: 'acme', kind: 'agent' })
    ).toHaveLength(1);
  });
});
