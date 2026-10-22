import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemberProfile } from './member-registry.js';
const s = vi.hoisted(() => ({
  profiles: {} as Record<string, MemberProfile>,
  writes: 0,
  worker: false,
  scopes: [] as unknown[],
}));
vi.mock('../authority.js', async (original) => ({
  ...(await original<typeof import('../authority.js')>()),
  withExecutionContextAsync: async (_role: string, action: () => unknown) => action(),
}));
vi.mock('../secure-io.js', async (original) => ({
  ...(await original<typeof import('../secure-io.js')>()),
  safeExistsSync: () => true,
  safeReaddir: () => Object.keys(s.profiles).map((id) => id + '.json'),
}));
vi.mock('./member-registry.js', () => ({
  isValidMemberId: (id: string) => /^[a-z][a-z0-9-]{1,30}$/.test(id),
  memberProfileDir: () => '/registry',
  memberProfilePath: (id: string) => '/registry/' + id + '.json',
  readMemberProfile: (id: string) => structuredClone(s.profiles[id] ?? null),
  writeMemberProfile: (profile: MemberProfile) => {
    s.writes++;
    s.profiles[profile.member_id] = structuredClone(profile);
    return profile;
  },
}));
vi.mock('./organization-people-access.js', () => ({
  withOrganizationPeopleMutation: (action: () => unknown) => action(),
  withPeopleResources: (_auth: unknown, scope: unknown, action: () => unknown) => {
    s.scopes.push(scope);
    return action();
  },
  recordPeopleManagementAudit: vi.fn(),
}));
vi.mock('../project/project-lifecycle-guards.js', () => ({
  assertProjectLifecycleOwner: () => {
    if (s.worker) throw new Error('workers cannot mutate');
  },
}));
vi.mock('../chronos-access-registry.js', () => ({
  issueChronosAccessToken: () => ({
    token: 'one-time-token',
    registration: { label: 'alice-token' },
  }),
}));
import {
  createManagedMember,
  listManagedMembers,
  managedMemberVersion,
  updateManagedMember,
} from './member-management.js';

function member(
  id: string,
  roles: Array<[string, 'owner' | 'operator' | 'approver' | 'viewer']>,
  extra: Partial<MemberProfile> = {}
): MemberProfile {
  return {
    member_id: id,
    display_name: id,
    status: 'active',
    memberships: roles.map(([tenant_slug, role]) => ({ tenant_slug, role })),
    access_registrations: [],
    created_at: '2026-10-22T00:00:00.000Z',
    updated_at: '2026-10-22T00:00:00.000Z',
    ...extra,
  };
}
const principal = { memberId: 'owner', allowedTenantSlugs: 'all' as const };
describe('shared human management', () => {
  beforeEach(() => {
    s.profiles = {
      owner: member('owner', [['acme', 'owner']]),
      alice: member('alice', [['acme', 'viewer']]),
    };
    s.writes = 0;
    s.worker = false;
    s.scopes = [];
  });
  it('creates through the shared member store and returns token only on request', async () => {
    const result = await createManagedMember(principal, {
      memberId: 'carol',
      displayName: 'Carol',
      tenantSlug: 'acme',
      role: 'operator',
    });
    expect(result.member.memberships).toEqual([{ tenant_slug: 'acme', role: 'operator' }]);
    expect(result.token).toBeUndefined();
    expect(s.writes).toBe(1);
    await expect(
      createManagedMember(principal, {
        memberId: 'carol',
        displayName: 'Again',
        tenantSlug: 'acme',
        role: 'operator',
      })
    ).rejects.toMatchObject({ status: 409 });
  });
  it('requires fresh registered owner and verified tenant scope', async () => {
    await expect(
      createManagedMember(
        { ...principal, allowedTenantSlugs: ['beta'] },
        { memberId: 'carol', displayName: 'Carol', tenantSlug: 'acme', role: 'viewer' }
      )
    ).rejects.toMatchObject({ status: 403 });
    s.profiles.owner.status = 'suspended';
    await expect(
      updateManagedMember(principal, { memberId: 'alice', displayName: 'Alice' })
    ).rejects.toMatchObject({ status: 403 });
    expect(s.writes).toBe(0);
  });
  it('requires owner on all memberships for global name, status and external identity changes', async () => {
    s.profiles.alice.memberships.push({ tenant_slug: 'beta', role: 'operator' });
    for (const patch of [
      { displayName: 'New name' },
      { status: 'suspended' as const },
      { externalIdentity: { issuer: 'https://id.example', subject: 'alice' } },
    ])
      await expect(
        updateManagedMember(principal, { memberId: 'alice', ...patch })
      ).rejects.toMatchObject({ status: 403 });
    expect(s.writes).toBe(0);
  });
  it('keeps a tenant-only role edit separate from global changes and supports removal', async () => {
    s.profiles.alice.memberships.push({ tenant_slug: 'beta', role: 'operator' });
    const changed = await updateManagedMember(principal, {
      memberId: 'alice',
      tenantSlug: 'acme',
      role: 'approver',
    });
    expect(changed.memberships).toEqual([
      { tenant_slug: 'acme', role: 'approver' },
      { tenant_slug: 'beta', role: 'operator' },
    ]);
    const removed = await updateManagedMember(principal, {
      memberId: 'alice',
      removeTenantSlug: 'acme',
    });
    expect(removed.memberships).toEqual([{ tenant_slug: 'beta', role: 'operator' }]);
  });
  it('prevents self lockout and removing the last owner', async () => {
    await expect(
      updateManagedMember(principal, { memberId: 'owner', status: 'suspended' })
    ).rejects.toMatchObject({ code: 'self_lockout' });
    s.profiles.carol = member('carol', [['beta', 'owner']]);
    s.profiles.owner.memberships.push({ tenant_slug: 'beta', role: 'operator' });
    await expect(
      updateManagedMember(
        { memberId: 'carol', allowedTenantSlugs: 'all' },
        { memberId: 'carol', removeTenantSlug: 'beta' }
      )
    ).rejects.toMatchObject({ code: 'self_lockout' });
    // Even another owner on a different tenant cannot remove beta's final owner.
    await expect(
      updateManagedMember(principal, { memberId: 'carol', removeTenantSlug: 'beta' })
    ).rejects.toMatchObject({ status: 403 });
    expect(s.writes).toBe(0);
  });
  it('renames and checks an optional version fence', async () => {
    const version = managedMemberVersion(s.profiles.alice);
    const changed = await updateManagedMember(principal, {
      memberId: 'alice',
      displayName: 'Alice human',
      expectedVersion: version,
    });
    expect(changed.display_name).toBe('Alice human');
    await expect(
      updateManagedMember(principal, {
        memberId: 'alice',
        displayName: 'Stale',
        expectedVersion: version,
      })
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('normalizes identities, is idempotent, and takes over only the matching SCIM binding', async () => {
    s.profiles.alice.external_identities = [
      {
        issuer: 'https://id.example/',
        subject: 'alice',
        provisioned_by: 'scim:scim-0123456789abcdef',
      },
      { issuer: 'https://slack.com', subject: 'U1', provisioned_by: 'scim:scim-0123456789abcdef' },
    ];
    const changed = await updateManagedMember(principal, {
      memberId: 'alice',
      externalIdentity: { issuer: 'https://id.example/', subject: 'alice' },
    });
    expect(changed.external_identities).toEqual([
      { issuer: 'https://id.example/', subject: 'alice' },
      { issuer: 'https://slack.com', subject: 'U1', provisioned_by: 'scim:scim-0123456789abcdef' },
    ]);
    const removed = await updateManagedMember(principal, {
      memberId: 'alice',
      removeExternalIdentity: { issuer: 'https://id.example', subject: 'alice' },
    });
    expect(removed.external_identities).toHaveLength(1);
  });
  it('clears SCIM suspension provenance only on an explicit owner status decision', async () => {
    s.profiles.alice = {
      ...s.profiles.alice,
      status: 'suspended',
      suspended_by: 'scim:scim-0123456789abcdef',
    };
    const renamed = await updateManagedMember(principal, {
      memberId: 'alice',
      displayName: 'Alice',
    });
    expect(renamed.suspended_by).toBe('scim:scim-0123456789abcdef');
    const resumed = await updateManagedMember(principal, { memberId: 'alice', status: 'active' });
    expect(resumed.suspended_by).toBeUndefined();
  });
  it('lists only selected tenant memberships with a fence and local-owner marker', async () => {
    s.profiles.alice.memberships.push({ tenant_slug: 'beta', role: 'operator' });
    s.profiles.alice.external_identities = [
      { issuer: 'https://id.example', subject: 'private', email: 'private@example.com' },
    ];
    const rows = await listManagedMembers(principal, 'acme');
    expect(rows.find((row) => row.member_id === 'alice')).toMatchObject({
      memberships: [{ tenant_slug: 'acme', role: 'viewer' }],
      version: managedMemberVersion(s.profiles.alice),
      external_identities: undefined,
    });
    expect(rows.find((row) => row.member_id === 'owner')?.is_local_owner).toBe(true);
  });
  it('rejects invalid identities, mixed identity edits and worker mutations before writing', async () => {
    await expect(
      updateManagedMember(principal, {
        memberId: 'alice',
        externalIdentity: { issuer: 'bad issuer', subject: 'alice' },
      })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      updateManagedMember(principal, {
        memberId: 'alice',
        externalIdentity: { issuer: 'https://id.example', subject: 'alice' },
        status: 'active',
      })
    ).rejects.toMatchObject({ status: 400 });
    s.worker = true;
    await expect(
      updateManagedMember(principal, { memberId: 'alice', displayName: 'Alice' })
    ).rejects.toThrow('workers');
    expect(s.writes).toBe(0);
  });
});
