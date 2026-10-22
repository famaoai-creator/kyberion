import { beforeEach, describe, expect, it, vi } from 'vitest';
const s = vi.hoisted(() => ({
  files: new Map<string, unknown>(),
  revoked: false,
  scopes: [] as Array<{ writes?: string[]; organizationId?: string }>,
  members: {
    owner: {
      member_id: 'owner',
      display_name: 'Owner',
      status: 'active',
      memberships: [{ tenant_slug: 'acme', role: 'owner' }],
    },
    alice: {
      member_id: 'alice',
      display_name: 'Alice',
      status: 'active',
      memberships: [{ tenant_slug: 'acme', role: 'viewer' }],
    },
  } as Record<
    string,
    {
      member_id: string;
      display_name: string;
      status: string;
      memberships: Array<{ tenant_slug: string; role: string }>;
    }
  >,
}));
vi.mock('../path-resolver.js', () => ({
  pathResolver: {
    rootDir: () => '/repo',
    rootResolve: (value: string) => '/repo/' + value,
    organizationStateDir: (id: string, tier: string, tenant: string) =>
      `/repo/active/organizations/${tier}/${tenant}/${id}`,
  },
}));
vi.mock('../foundation/governed-catalog.js', () => ({
  defineCatalog: () => ({ validate: (value: unknown) => value }),
}));
vi.mock('../foundation/json.js', () => ({
  readJsonIfPresent: (file: string) => structuredClone(s.files.get(file) ?? null),
  writeJson: (file: string, value: unknown) => s.files.set(file, structuredClone(value)),
}));
vi.mock('../secure-io.js', () => ({
  safeExistsSync: (file: string) =>
    file === '/members' ||
    [...s.files.keys()].some((key) => key === file || key.startsWith(file + '/')),
  safeReaddir: (file: string) =>
    file === '/members'
      ? Object.keys(s.members).map((id) => id + '.json')
      : [
          ...new Set(
            [...s.files.keys()]
              .filter((key) => key.startsWith(file + '/'))
              .map((key) => key.slice(file.length + 1).split('/')[0])
          ),
        ],
}));
vi.mock('../mission/mission-team-index.js', () => ({
  loadTeamRoleIndex: () => ({
    owner: { description: 'Own outcomes' },
    reviewer: { description: 'Review' },
    implementer: { description: 'Implement' },
  }),
}));
vi.mock('./member-registry.js', () => ({
  memberProfileDir: () => '/members',
  memberProfilePath: (id: string) => '/members/' + id + '.json',
  readMemberProfile: (id: string) => s.members[id] ?? null,
  isValidMemberId: (id: string) => /^[a-z][a-z0-9-]{1,30}$/.test(id),
}));
vi.mock('./organization-operating-model-persistence.js', () => ({
  assertOrganizationId: (id: string) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw new Error('invalid org');
  },
  recordPath: (kind: string, id: string, file: string, org: string, tier: string, tenant: string) =>
    `/repo/active/organizations/${tier}/${tenant}/${org}/${kind}/${id}/${file}`,
  organizationOperationalStatePath: (org: string, tier: string, tenant: string) =>
    `/repo/active/organizations/${tier}/${tenant}/${org}/organization-state.json`,
  loadOrganizationOperationalState: (org: string, query: { tenantSlug: string }) =>
    query.tenantSlug === 'acme' && ['org-a', 'org-b'].includes(org)
      ? {
          organization_id: org,
          tenant_slug: 'acme',
          tier: 'confidential',
          name: org,
          status: 'active',
        }
      : null,
}));
vi.mock('./organization-people-access.js', () => ({
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
    scope: { writes?: string[]; organizationId?: string },
    action: () => unknown
  ) => {
    s.scopes.push(scope);
    return action();
  },
}));
vi.mock('./organization-agent-management.js', () => ({
  listManagedOrganizationAgents: async () => [],
  showManagedOrganizationAgent: async () => null,
}));
import {
  listOrganizationParticipantCandidates,
  listOrganizationParticipants,
  removeOrganizationParticipant,
  setOrganizationParticipant,
} from './organization-participants.js';
const auth = {
  memberId: 'owner',
  actorId: 'user:owner',
  tenantSlug: 'acme',
  allowedOrganizationIds: 'all' as const,
  allowedProjectIds: 'all' as const,
};
describe('organization responsibility assignments', () => {
  beforeEach(() => {
    s.files.clear();
    s.revoked = false;
    s.scopes = [];
    s.members.alice.status = 'active';
    s.members.alice.memberships = [{ tenant_slug: 'acme', role: 'viewer' }];
  });
  it('supports multiple organizations and multiple responsibilities without changing human access', async () => {
    const first = await setOrganizationParticipant(auth, {
      organizationId: 'org-a',
      actor: 'user:alice',
      roleIds: ['reviewer', 'implementer', 'reviewer'],
    });
    await setOrganizationParticipant(auth, {
      organizationId: 'org-b',
      actor: 'user:alice',
      roleIds: ['owner'],
    });
    expect(first.participant.role_ids).toEqual(['implementer', 'reviewer']);
    expect(first.participant).toMatchObject({
      display_name: 'Alice',
      kind: 'human',
      is_local_owner: false,
    });
    expect(s.members.alice.memberships).toEqual([{ tenant_slug: 'acme', role: 'viewer' }]);
    expect((await listOrganizationParticipants(auth, 'org-a'))[0].version).toBe(first.version);
    expect((await listOrganizationParticipants(auth, 'org-b'))[0].role_ids).toEqual(['owner']);
  });
  it('requires a current version for existing records and prevents remove/readd ABA', async () => {
    const first = await setOrganizationParticipant(auth, {
      organizationId: 'org-a',
      actor: 'user:alice',
      roleIds: ['reviewer'],
    });
    await expect(
      setOrganizationParticipant(auth, {
        organizationId: 'org-a',
        actor: 'user:alice',
        roleIds: ['owner'],
      })
    ).rejects.toMatchObject({ status: 409 });
    const removed = await removeOrganizationParticipant(auth, {
      organizationId: 'org-a',
      actor: 'user:alice',
      expectedVersion: first.version,
    });
    await expect(
      setOrganizationParticipant(auth, {
        organizationId: 'org-a',
        actor: 'user:alice',
        roleIds: ['reviewer'],
        expectedVersion: first.version,
      })
    ).rejects.toMatchObject({ status: 409 });
    const restored = await setOrganizationParticipant(auth, {
      organizationId: 'org-a',
      actor: 'user:alice',
      roleIds: ['reviewer'],
      expectedVersion: removed.version,
    });
    expect(restored.version).not.toBe(first.version);
    expect(restored.participant.revision).toBe(3);
    await expect(
      removeOrganizationParticipant(auth, {
        organizationId: 'org-a',
        actor: 'user:alice',
        expectedVersion: first.version,
      })
    ).rejects.toMatchObject({ status: 409 });
  });
  it('rejects unavailable actors, foreign tenants, unknown roles and unauthorized organizations', async () => {
    s.members.alice.memberships = [{ tenant_slug: 'beta', role: 'viewer' }];
    await expect(
      setOrganizationParticipant(auth, {
        organizationId: 'org-a',
        actor: 'user:alice',
        roleIds: ['reviewer'],
      })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      setOrganizationParticipant(auth, {
        organizationId: 'org-a',
        actor: 'kyberion://agent/foreign/agent',
        roleIds: ['reviewer'],
      })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      setOrganizationParticipant(auth, {
        organizationId: 'org-a',
        actor: 'user:owner',
        roleIds: ['unregistered'],
      })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      setOrganizationParticipant(
        { ...auth, allowedOrganizationIds: ['org-b'] },
        { organizationId: 'org-a', actor: 'user:owner', roleIds: ['reviewer'] }
      )
    ).rejects.toMatchObject({ status: 403 });
    expect(s.files.size).toBe(0);
  });
  it('revalidates ownership under the mutation lock and binds writes to the exact target record', async () => {
    s.revoked = true;
    await expect(
      setOrganizationParticipant(auth, {
        organizationId: 'org-a',
        actor: 'user:alice',
        roleIds: ['reviewer'],
      })
    ).rejects.toMatchObject({ status: 403 });
    expect(s.files.size).toBe(0);
    s.revoked = false;
    await setOrganizationParticipant(auth, {
      organizationId: 'org-a',
      actor: 'user:alice',
      roleIds: ['reviewer'],
    });
    const write = s.scopes.find((scope) => scope.writes?.length);
    expect(write?.organizationId).toBe('org-a');
    expect(write?.writes).toHaveLength(1);
    expect(write?.writes?.[0]).toMatch(
      /^\/repo\/active\/organizations\/confidential\/acme\/org-a\/participants\/participant-[a-f0-9]{32}\/participant\.json$/
    );
  });
  it('projects candidates without external identity data and marks the actual owner', async () => {
    const rows = await listOrganizationParticipantCandidates(auth);
    expect(rows.find((row) => row.actor === 'user:owner')?.is_local_owner).toBe(true);
    expect(rows.find((row) => row.actor === 'user:alice')).toEqual({
      actor: 'user:alice',
      display_name: 'Alice',
      kind: 'human',
      identity_status: 'active',
      is_local_owner: false,
    });
    s.members.alice.status = 'suspended';
    expect(
      (await listOrganizationParticipantCandidates(auth)).some((row) => row.actor === 'user:alice')
    ).toBe(false);
  });
  it('rejects a stored record whose declared scope differs from its organization path', async () => {
    await setOrganizationParticipant(auth, {
      organizationId: 'org-a',
      actor: 'user:alice',
      roleIds: ['reviewer'],
    });
    const file = [...s.files.keys()][0];
    s.files.set(file, { ...(s.files.get(file) as object), tenant_slug: 'beta' });
    await expect(listOrganizationParticipants(auth, 'org-a')).rejects.toMatchObject({
      status: 409,
    });
  });
});
