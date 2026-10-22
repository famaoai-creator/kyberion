import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentIdentityRecord } from '../agent/agent-identity.js';
const s = vi.hoisted(() => ({
  records: {} as Record<string, AgentIdentityRecord>,
  revisions: {} as Record<string, number>,
  ownerActive: true,
  homeActive: true,
  revoked: false,
  writes: 0,
  scopes: [] as Array<{ role?: string; writes?: string[] }>,
}));
function effect(id: string, patch: Partial<AgentIdentityRecord>): AgentIdentityRecord {
  s.writes++;
  s.revisions[id] = (s.revisions[id] ?? 0) + 1;
  return (s.records[id] = { ...s.records[id], ...patch });
}
vi.mock('../agent/agent-identity.js', () => ({
  withAgentIdentityStoreAccess: (
    access: (resources: unknown, run: () => unknown) => unknown,
    run: () => unknown
  ) =>
    access(
      {
        reads: ['/journal/identities.jsonl'],
        writes: [
          '/journal/identities.jsonl',
          '/journal/writer-lease.json',
          '/journal/writer-lease-metrics.json',
        ],
      },
      run
    ),
  getAgentIdentity: (id: string) => s.records[id] ?? null,
  getAgentIdentityRevision: (id: string) => s.revisions[id] ?? 0,
  listAgentIdentities: () => Object.values(s.records),
  issueAgentIdentity: (input: {
    organizationId: string;
    slug: string;
    kind: 'agent' | 'service';
    displayName?: string;
    accountableHumanId: string;
    affiliation: { tenant_slug: string };
  }) => {
    const id = `kyberion://agent/${input.organizationId}/${input.slug}`;
    if (s.records[id])
      throw Object.assign(new Error('identity conflict'), { name: 'AgentIdentityConflictError' });
    return effect(id, {
      nhi_id: id,
      display_name: input.displayName ?? input.slug,
      kind: input.kind,
      accountable_human_id: input.accountableHumanId,
      affiliation: { organization_id: input.organizationId, ...input.affiliation },
      lifecycle_status: 'provisioned',
      created_at: '2026-10-22T00:00:00.000Z',
    });
  },
  activateAgentIdentity: (id: string) => effect(id, { lifecycle_status: 'active' }),
  suspendAgentIdentity: (id: string) => effect(id, { lifecycle_status: 'suspended' }),
  retireAgentIdentity: (id: string) => effect(id, { lifecycle_status: 'retired' }),
  reassignAgentIdentityAccountability: (input: { nhiId: string; accountableHumanId: string }) =>
    effect(input.nhiId, { accountable_human_id: input.accountableHumanId }),
}));
vi.mock('./member-registry.js', () => ({
  isValidMemberId: (id: string) => /^[a-z][a-z0-9-]{1,30}$/.test(id),
  memberProfilePath: (id: string) => '/members/' + id + '.json',
  readMemberProfile: (id: string) =>
    id === 'owner' || id === 'alice'
      ? {
          member_id: id,
          status: s.ownerActive ? 'active' : 'suspended',
          memberships: [{ tenant_slug: 'acme', role: 'owner' }],
        }
      : null,
}));
vi.mock('./organization-operating-model-persistence.js', () => ({
  organizationOperationalStatePath: (id: string) => '/org/' + id + '.json',
  loadOrganizationOperationalState: () => (s.homeActive ? { status: 'active' } : null),
}));
vi.mock('./organization-people-access.js', () => ({
  withPeopleResourcesSync: (
    _auth: unknown,
    scope: { role?: string; writes?: string[] },
    action: () => unknown
  ) => {
    s.scopes.push(scope);
    return action();
  },
  authorizeOrganizationPeople: async (
    auth: { allowedOrganizationIds: string[] | 'all' },
    id?: string
  ) => {
    if (id && auth.allowedOrganizationIds !== 'all' && !auth.allowedOrganizationIds.includes(id))
      throw Object.assign(new Error('forbidden'), { status: 403 });
    return auth;
  },
  verifyOrganizationPeople: async () => {
    if (s.revoked) throw Object.assign(new Error('revoked'), { status: 403 });
  },
  withOrganizationPeopleMutation: (action: () => unknown) => action(),
  recordPeopleManagementAudit: vi.fn(),
  withPeopleResources: (
    _auth: unknown,
    scope: { role?: string; writes?: string[] },
    action: () => unknown
  ) => {
    s.scopes.push(scope);
    return action();
  },
}));
import {
  changeManagedOrganizationAgentLifecycle,
  issueManagedOrganizationAgent,
  listManagedOrganizationAgents,
  reassignManagedOrganizationAgentAccountable,
  showManagedOrganizationAgent,
} from './organization-agent-management.js';
const auth = {
  memberId: 'owner',
  actorId: 'user:owner',
  tenantSlug: 'acme',
  allowedOrganizationIds: 'all' as const,
  allowedProjectIds: 'all' as const,
};
function record(org: string, slug: string, tenant = 'acme'): AgentIdentityRecord {
  return {
    nhi_id: `kyberion://agent/${org}/${slug}`,
    display_name: slug,
    kind: 'agent',
    accountable_human_id: 'user:owner',
    affiliation: { organization_id: org, tenant_slug: tenant },
    lifecycle_status: 'provisioned',
    created_at: '2026-10-22T00:00:00.000Z',
  };
}
describe('owner-authorized organization agent management', () => {
  beforeEach(() => {
    s.records = {};
    s.revisions = {};
    s.ownerActive = true;
    s.homeActive = true;
    s.revoked = false;
    s.writes = 0;
    s.scopes = [];
    const a = record('org-a', 'helper');
    s.records[a.nhi_id] = a;
  });
  it('scopes the directory to tenant and authorized immutable home organizations', async () => {
    for (const r of [record('org-b', 'other'), record('org-a', 'foreign', 'beta')])
      s.records[r.nhi_id] = r;
    const rows = await listManagedOrganizationAgents({
      ...auth,
      allowedOrganizationIds: ['org-a'],
    });
    expect(rows.map((row) => row.nhi_id)).toEqual(['kyberion://agent/org-a/helper']);
    expect(
      await showManagedOrganizationAgent(
        { ...auth, allowedOrganizationIds: ['org-a'] },
        'kyberion://agent/org-b/other'
      )
    ).toBeNull();
  });
  it('issues a provisioned identity with a registered active accountable member and exact journal capability', async () => {
    const issued = await issueManagedOrganizationAgent(auth, {
      organizationId: 'org-a',
      slug: 'new-helper',
      accountableHumanId: 'user:alice',
    });
    expect(issued).toMatchObject({
      lifecycle_status: 'provisioned',
      home_organization_id: 'org-a',
      tenant_slug: 'acme',
      accountable_human_id: 'user:alice',
    });
    expect(s.scopes.find((scope) => scope.writes?.length)).toEqual({
      reads: ['/journal/identities.jsonl'],
      writes: [
        '/journal/identities.jsonl',
        '/journal/writer-lease.json',
        '/journal/writer-lease-metrics.json',
      ],
      role: 'mission_controller',
    });
    await expect(
      issueManagedOrganizationAgent(auth, {
        organizationId: 'org-a',
        slug: 'bad-owner',
        accountableHumanId: 'human:legacy',
      })
    ).rejects.toMatchObject({ status: 400 });
  });
  it('fences lifecycle changes and rejects stale or terminal edits', async () => {
    const initial = (await listManagedOrganizationAgents(auth))[0];
    const active = await changeManagedOrganizationAgentLifecycle(auth, {
      nhiId: initial.nhi_id,
      expectedVersion: initial.version,
      action: 'activate',
    });
    expect(active.lifecycle_status).toBe('active');
    await expect(
      changeManagedOrganizationAgentLifecycle(auth, {
        nhiId: initial.nhi_id,
        expectedVersion: initial.version,
        action: 'suspend',
      })
    ).rejects.toMatchObject({ status: 409 });
    const retired = await changeManagedOrganizationAgentLifecycle(auth, {
      nhiId: active.nhi_id,
      expectedVersion: active.version,
      action: 'retire',
      reason: 'Offboard',
    });
    await expect(
      changeManagedOrganizationAgentLifecycle(auth, {
        nhiId: retired.nhi_id,
        expectedVersion: retired.version,
        action: 'activate',
      })
    ).rejects.toMatchObject({ status: 409 });
  });
  it('changes accountable ownership without changing identity or home and blocks invalid accountable members', async () => {
    const initial = (await listManagedOrganizationAgents(auth))[0];
    const next = await reassignManagedOrganizationAgentAccountable(auth, {
      nhiId: initial.nhi_id,
      expectedVersion: initial.version,
      accountableHumanId: 'user:alice',
      reason: 'Owner handover',
    });
    expect(next.nhi_id).toBe(initial.nhi_id);
    expect(next.home_organization_id).toBe(initial.home_organization_id);
    expect(next.accountable_human_id).toBe('user:alice');
    await expect(
      reassignManagedOrganizationAgentAccountable(auth, {
        nhiId: next.nhi_id,
        expectedVersion: next.version,
        accountableHumanId: 'user:missing',
        reason: 'Invalid',
      })
    ).rejects.toMatchObject({ status: 400 });
  });
  it('blocks activation when accountable human or home organization is unavailable, while permitting offboarding', async () => {
    let initial = (await listManagedOrganizationAgents(auth))[0];
    s.ownerActive = false;
    await expect(
      changeManagedOrganizationAgentLifecycle(auth, {
        nhiId: initial.nhi_id,
        expectedVersion: initial.version,
        action: 'activate',
      })
    ).rejects.toMatchObject({ status: 400 });
    s.ownerActive = true;
    s.homeActive = false;
    await expect(
      changeManagedOrganizationAgentLifecycle(auth, {
        nhiId: initial.nhi_id,
        expectedVersion: initial.version,
        action: 'activate',
      })
    ).rejects.toMatchObject({ status: 409 });
    initial = await changeManagedOrganizationAgentLifecycle(auth, {
      nhiId: initial.nhi_id,
      expectedVersion: initial.version,
      action: 'suspend',
    });
    expect(initial.lifecycle_status).toBe('suspended');
  });
  it('revalidates ownership after admission and denies cross-tenant effects', async () => {
    const initial = (await listManagedOrganizationAgents(auth))[0];
    s.revoked = true;
    await expect(
      changeManagedOrganizationAgentLifecycle(auth, {
        nhiId: initial.nhi_id,
        expectedVersion: initial.version,
        action: 'suspend',
      })
    ).rejects.toMatchObject({ status: 403 });
    s.revoked = false;
    s.records[initial.nhi_id].affiliation.tenant_slug = 'beta';
    await expect(
      changeManagedOrganizationAgentLifecycle(auth, {
        nhiId: initial.nhi_id,
        expectedVersion: initial.version,
        action: 'suspend',
      })
    ).rejects.toMatchObject({ status: 404 });
    expect(s.writes).toBe(0);
  });
});
