// FD-07: member-registry hermetic tests. Same fixture-rootDir pattern as
// front-desk-identity.test.ts / tenant-registry.test.ts — no real
// knowledge/personal file is ever touched.
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as pathResolver from './path-resolver.js';
import { safeRmSync, safeWriteFile } from './secure-io.js';
import { writeTenantProfile } from './tenant-registry.js';

vi.mock('./operator-identity.js', () => ({
  resolveOperatorDisplayName: vi.fn((fallback?: string) => `mocked-operator(${fallback ?? ''})`),
}));

import {
  ensureOwnerMember,
  externalIdentityBindingDenied,
  findMemberByExternalIdentity,
  isValidMemberId,
  listMemberIds,
  memberBindingDenied,
  memberProfilePath,
  ownerAccountableHumanId,
  readMemberProfile,
  resolveAccountableHuman,
  resolveMemberByPrincipal,
  writeMemberProfile,
  type MemberProfile,
} from './member-registry.js';

function makeMember(overrides: Partial<MemberProfile> = {}): MemberProfile {
  return {
    member_id: 'alice',
    display_name: 'Alice A.',
    status: 'active',
    memberships: [{ tenant_slug: 'acme-corp', role: 'viewer' }],
    access_registrations: [{ label: 'alice-token' }],
    created_at: '2026-09-13T00:00:00.000Z',
    updated_at: '2026-09-13T00:00:00.000Z',
    ...overrides,
  };
}

describe('member-registry', () => {
  let fixtureRoot = '';
  let savedPersona: string | undefined;
  let savedRole: string | undefined;

  beforeAll(() => {
    fixtureRoot = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `member-registry-${randomUUID()}`
    );
    savedPersona = process.env.KYBERION_PERSONA;
    savedRole = process.env.MISSION_ROLE;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
  });

  afterAll(() => {
    if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedPersona;
    if (savedRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = savedRole;
    if (fixtureRoot) safeRmSync(fixtureRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('isValidMemberId', () => {
    it('accepts the member id grammar', () => {
      expect(isValidMemberId('owner')).toBe(true);
      expect(isValidMemberId('alice-2')).toBe(true);
    });

    it('rejects invalid ids', () => {
      expect(isValidMemberId('Alice')).toBe(false);
      expect(isValidMemberId('a')).toBe(false);
      expect(isValidMemberId('')).toBe(false);
    });
  });

  describe('write / read / list', () => {
    it('round-trips a member profile', () => {
      const written = writeMemberProfile(makeMember(), { rootDir: fixtureRoot });
      const read = readMemberProfile('alice', { rootDir: fixtureRoot });
      expect(read).toEqual(written);
    });

    it('returns null for a missing profile', () => {
      expect(readMemberProfile('nobody', { rootDir: fixtureRoot })).toBeNull();
    });

    it('rejects a schema-invalid profile at write time', () => {
      expect(() =>
        writeMemberProfile(
          { ...makeMember(), status: 'deleted' as unknown as 'active' },
          { rootDir: fixtureRoot }
        )
      ).toThrow(/invalid member profile/);
    });

    it('lists member ids sorted', () => {
      writeMemberProfile(makeMember({ member_id: 'zeta' }), { rootDir: fixtureRoot });
      writeMemberProfile(makeMember({ member_id: 'bravo' }), { rootDir: fixtureRoot });
      const ids = listMemberIds({ rootDir: fixtureRoot });
      expect(ids).toContain('alice');
      expect(ids.indexOf('bravo')).toBeLessThan(ids.indexOf('zeta'));
    });

    it('resolves the member profile path deterministically', () => {
      expect(memberProfilePath('alice', { rootDir: fixtureRoot })).toBe(
        path.join(fixtureRoot, 'knowledge', 'personal', 'members', 'alice.json')
      );
    });
  });

  describe('ensureOwnerMember', () => {
    let ownerFixtureRoot = '';

    beforeEach(() => {
      ownerFixtureRoot = path.join(
        pathResolver.rootDir(),
        'active',
        'shared',
        'tmp',
        `member-registry-owner-${randomUUID()}`
      );
      writeTenantProfile(
        {
          tenant_slug: 'acme-corp',
          display_name: 'Acme Corp',
          status: 'active',
          assigned_role: 'owner',
        },
        { rootDir: ownerFixtureRoot }
      );
    });

    afterEach(() => {
      if (ownerFixtureRoot) safeRmSync(ownerFixtureRoot, { recursive: true, force: true });
    });

    it('creates the owner from my-identity.json with an owner membership per tenant', () => {
      const owner = ensureOwnerMember({ rootDir: ownerFixtureRoot });
      expect(owner.member_id).toBe('owner');
      expect(owner.display_name).toBe('mocked-operator(owner)');
      expect(owner.memberships).toEqual([{ tenant_slug: 'acme-corp', role: 'owner' }]);
    });

    it('is idempotent: calling twice does not change an already-complete record', () => {
      const first = ensureOwnerMember({ rootDir: ownerFixtureRoot });
      const second = ensureOwnerMember({ rootDir: ownerFixtureRoot });
      expect(second).toEqual(first);
    });

    it('adds a missing tenant membership without downgrading existing ones', () => {
      ensureOwnerMember({ rootDir: ownerFixtureRoot });
      writeTenantProfile(
        {
          tenant_slug: 'beta-co',
          display_name: 'Beta Co',
          status: 'active',
          assigned_role: 'owner',
        },
        { rootDir: ownerFixtureRoot }
      );
      const updated = ensureOwnerMember({ rootDir: ownerFixtureRoot });
      expect(updated.memberships).toEqual(
        expect.arrayContaining([
          { tenant_slug: 'acme-corp', role: 'owner' },
          { tenant_slug: 'beta-co', role: 'owner' },
        ])
      );
    });

    it('never downgrades an existing owner record even if a membership role changed by hand', () => {
      ensureOwnerMember({ rootDir: ownerFixtureRoot });
      const manual = readMemberProfile('owner', { rootDir: ownerFixtureRoot })!;
      writeMemberProfile(
        {
          ...manual,
          memberships: [{ tenant_slug: 'acme-corp', role: 'viewer' }],
        },
        { rootDir: ownerFixtureRoot }
      );
      const result = ensureOwnerMember({ rootDir: ownerFixtureRoot });
      // No new tenant appeared, so ensureOwnerMember must not touch the
      // manually-set (downgraded) role — it only ever adds missing tenants.
      expect(result.memberships).toEqual([{ tenant_slug: 'acme-corp', role: 'viewer' }]);
    });
  });

  describe('resolveMemberByPrincipal', () => {
    it('resolves the active owner member for loopback', () => {
      writeMemberProfile(makeMember({ member_id: 'owner', display_name: 'Owner' }), {
        rootDir: fixtureRoot,
      });
      const resolved = resolveMemberByPrincipal(
        { source: 'loopback', principalId: 'anything' },
        { rootDir: fixtureRoot }
      );
      expect(resolved?.member_id).toBe('owner');
    });

    it('returns null for loopback when no owner record exists', () => {
      const resolved = resolveMemberByPrincipal(
        { source: 'loopback' },
        { rootDir: path.join(fixtureRoot, 'no-owner-here') }
      );
      expect(resolved).toBeNull();
    });

    it('resolves a token viewer by matching access_registrations label', () => {
      writeMemberProfile(
        makeMember({ member_id: 'bob', access_registrations: [{ label: 'bob-token' }] }),
        { rootDir: fixtureRoot }
      );
      const resolved = resolveMemberByPrincipal(
        { source: 'token', registrationLabel: 'bob-token' },
        { rootDir: fixtureRoot }
      );
      expect(resolved?.member_id).toBe('bob');
    });

    it('returns null for a token with no matching registration label', () => {
      const resolved = resolveMemberByPrincipal(
        { source: 'token', registrationLabel: 'unknown-label' },
        { rootDir: fixtureRoot }
      );
      expect(resolved).toBeNull();
    });

    it('returns null for a suspended member', () => {
      writeMemberProfile(
        makeMember({
          member_id: 'carol',
          status: 'suspended',
          access_registrations: [{ label: 'carol-token' }],
        }),
        { rootDir: fixtureRoot }
      );
      const resolved = resolveMemberByPrincipal(
        { source: 'token', registrationLabel: 'carol-token' },
        { rootDir: fixtureRoot }
      );
      expect(resolved).toBeNull();
    });

    it('returns null for anonymous', () => {
      expect(
        resolveMemberByPrincipal({ source: 'anonymous' }, { rootDir: fixtureRoot })
      ).toBeNull();
    });

    it('resolves an authn-verified memberId directly (OIDC-mapped member)', () => {
      writeMemberProfile(makeMember({ member_id: 'dave' }), { rootDir: fixtureRoot });
      const resolved = resolveMemberByPrincipal(
        { source: 'token', memberId: 'dave' },
        { rootDir: fixtureRoot }
      );
      expect(resolved?.member_id).toBe('dave');
    });

    it('a memberId binding never falls back to label or loopback resolution', () => {
      writeMemberProfile(makeMember({ member_id: 'owner' }), { rootDir: fixtureRoot });
      writeMemberProfile(
        makeMember({ member_id: 'bob', access_registrations: [{ label: 'bob-token' }] }),
        { rootDir: fixtureRoot }
      );
      // Missing member id: must not resolve the owner via loopback or bob via label.
      expect(
        resolveMemberByPrincipal(
          { source: 'loopback', memberId: 'ghost' },
          { rootDir: fixtureRoot }
        )
      ).toBeNull();
      expect(
        resolveMemberByPrincipal(
          { source: 'token', memberId: 'ghost', registrationLabel: 'bob-token' },
          { rootDir: fixtureRoot }
        )
      ).toBeNull();
    });

    it('a suspended member never resolves via memberId', () => {
      writeMemberProfile(makeMember({ member_id: 'eve', status: 'suspended' }), {
        rootDir: fixtureRoot,
      });
      expect(
        resolveMemberByPrincipal({ source: 'token', memberId: 'eve' }, { rootDir: fixtureRoot })
      ).toBeNull();
    });

    it('the label scan skips a corrupt profile instead of aborting', () => {
      const isolatedRoot = path.join(fixtureRoot, `corrupt-label-${randomUUID()}`);
      writeMemberProfile(
        makeMember({ member_id: 'aaa-first', access_registrations: [{ label: 'aaa-token' }] }),
        { rootDir: isolatedRoot }
      );
      writeMemberProfile(
        makeMember({ member_id: 'bob', access_registrations: [{ label: 'bob-token' }] }),
        { rootDir: isolatedRoot }
      );
      // Corrupt the alphabetically-first profile — the scan must keep going
      // so one bad file can't hide a suspended binding or break resolution.
      const corruptPath = memberProfilePath('aaa-first', { rootDir: isolatedRoot });
      safeWriteFile(corruptPath, '{not json', { encoding: 'utf8' });
      expect(
        resolveMemberByPrincipal(
          { source: 'token', registrationLabel: 'bob-token' },
          { rootDir: isolatedRoot }
        )?.member_id
      ).toBe('bob');
    });
  });

  describe('memberBindingDenied', () => {
    it('returns true for an asserted memberId that did not resolve', () => {
      expect(
        memberBindingDenied({ source: 'token', memberId: 'ghost' }, { rootDir: fixtureRoot })
      ).toBe(true);
    });

    it('returns true when a suspended member binds the registration label', () => {
      writeMemberProfile(
        makeMember({
          member_id: 'carol',
          status: 'suspended',
          access_registrations: [{ label: 'carol-token' }],
        }),
        { rootDir: fixtureRoot }
      );
      expect(
        memberBindingDenied(
          { source: 'token', registrationLabel: 'carol-token' },
          { rootDir: fixtureRoot }
        )
      ).toBe(true);
    });

    it('returns false for a label bound to no member', () => {
      expect(
        memberBindingDenied(
          { source: 'token', registrationLabel: 'unbound-token' },
          { rootDir: fixtureRoot }
        )
      ).toBe(false);
    });

    it('fails closed when a profile is unreadable — the binding cannot be disproven', () => {
      const isolatedRoot = path.join(fixtureRoot, `corrupt-denied-${randomUUID()}`);
      writeMemberProfile(makeMember({ member_id: 'aaa-first' }), { rootDir: isolatedRoot });
      const corruptPath = memberProfilePath('aaa-first', { rootDir: isolatedRoot });
      safeWriteFile(corruptPath, '{not json', { encoding: 'utf8' });
      // Any unreadable profile denies — it may be the suspended binding.
      expect(
        memberBindingDenied(
          { source: 'token', registrationLabel: 'any-token' },
          { rootDir: isolatedRoot }
        )
      ).toBe(true);
    });
  });

  describe('ownerAccountableHumanId', () => {
    it('is the owner actor id', () => {
      expect(ownerAccountableHumanId()).toBe('user:owner');
    });
  });

  describe('findMemberByExternalIdentity', () => {
    const ISS = 'https://accounts.google.com';

    it('resolves an active member by issuer + subject', () => {
      writeMemberProfile(
        makeMember({
          member_id: 'carol',
          external_identities: [{ issuer: ISS, subject: 'sub-123', email: 'c@example.com' }],
        }),
        { rootDir: fixtureRoot }
      );
      const resolved = findMemberByExternalIdentity(ISS, 'sub-123', { rootDir: fixtureRoot });
      expect(resolved?.member_id).toBe('carol');
    });

    it('returns null when the subject is bound under a different issuer', () => {
      writeMemberProfile(
        makeMember({
          member_id: 'carol',
          external_identities: [{ issuer: 'https://other-idp.example', subject: 'sub-123' }],
        }),
        { rootDir: fixtureRoot }
      );
      expect(findMemberByExternalIdentity(ISS, 'sub-123', { rootDir: fixtureRoot })).toBeNull();
    });

    it('returns null for a suspended member (resolves as unregistered)', () => {
      writeMemberProfile(
        makeMember({
          member_id: 'carol',
          status: 'suspended',
          external_identities: [{ issuer: ISS, subject: 'sub-123' }],
        }),
        { rootDir: fixtureRoot }
      );
      expect(findMemberByExternalIdentity(ISS, 'sub-123', { rootDir: fixtureRoot })).toBeNull();
    });

    it('externalIdentityBindingDenied flags the suspended binding findMemberByExternalIdentity skips', () => {
      writeMemberProfile(
        makeMember({
          member_id: 'carol',
          status: 'suspended',
          external_identities: [{ issuer: ISS, subject: 'sub-123' }],
        }),
        { rootDir: fixtureRoot }
      );
      // The fail-closed companion: "unregistered" must not mean "degrade to
      // ext-" when the identity is bound to a suspended member.
      expect(externalIdentityBindingDenied(ISS, 'sub-123', { rootDir: fixtureRoot })).toBe(true);
      // Active binding → not denied (it resolves).
      writeMemberProfile(
        makeMember({
          member_id: 'carol',
          status: 'active',
          external_identities: [{ issuer: ISS, subject: 'sub-123' }],
        }),
        { rootDir: fixtureRoot }
      );
      expect(externalIdentityBindingDenied(ISS, 'sub-123', { rootDir: fixtureRoot })).toBe(false);
      expect(externalIdentityBindingDenied(ISS, 'nobody', { rootDir: fixtureRoot })).toBe(false);
      expect(externalIdentityBindingDenied('', 'sub-123', { rootDir: fixtureRoot })).toBe(false);
    });

    it('returns null when no member binds the identity', () => {
      writeMemberProfile(makeMember({ member_id: 'carol' }), { rootDir: fixtureRoot });
      expect(findMemberByExternalIdentity(ISS, 'nobody', { rootDir: fixtureRoot })).toBeNull();
    });

    it('skips a corrupt profile instead of aborting the scan', () => {
      writeMemberProfile(
        makeMember({
          member_id: 'carol',
          external_identities: [{ issuer: ISS, subject: 'sub-123' }],
        }),
        { rootDir: fixtureRoot }
      );
      // Plant a profile whose file cannot parse — earlier members must not
      // take every other external login down with them.
      const corruptRoot = path.join(fixtureRoot, `corrupt-${randomUUID()}`);
      writeMemberProfile(makeMember({ member_id: 'aaa-first' }), { rootDir: corruptRoot });
      writeMemberProfile(
        makeMember({
          member_id: 'carol',
          external_identities: [{ issuer: ISS, subject: 'sub-123' }],
        }),
        { rootDir: corruptRoot }
      );
      const corruptPath = memberProfilePath('aaa-first', { rootDir: corruptRoot });
      safeWriteFile(corruptPath, '{not json', { encoding: 'utf8' });
      expect(
        findMemberByExternalIdentity(ISS, 'sub-123', { rootDir: corruptRoot })?.member_id
      ).toBe('carol');
    });
  });

  describe('external identity uniqueness', () => {
    const ISS = 'https://accounts.google.com';

    it('rejects a second member binding the same issuer + subject', () => {
      writeMemberProfile(
        makeMember({
          member_id: 'carol',
          external_identities: [{ issuer: ISS, subject: 'sub-123' }],
        }),
        { rootDir: fixtureRoot }
      );
      expect(() =>
        writeMemberProfile(
          makeMember({
            member_id: 'mallory',
            external_identities: [{ issuer: ISS, subject: 'sub-123' }],
          }),
          { rootDir: fixtureRoot }
        )
      ).toThrow(/already bound/);
    });

    it('allows the same member to update its own identity list', () => {
      writeMemberProfile(
        makeMember({
          member_id: 'carol',
          external_identities: [{ issuer: ISS, subject: 'sub-123' }],
        }),
        { rootDir: fixtureRoot }
      );
      const updated = writeMemberProfile(
        makeMember({
          member_id: 'carol',
          external_identities: [{ issuer: ISS, subject: 'sub-123' }],
          display_name: 'Carol C.',
        }),
        { rootDir: fixtureRoot }
      );
      expect(updated.display_name).toBe('Carol C.');
    });
  });

  describe('ext- member id reservation', () => {
    it('rejects member ids in the reserved ext- namespace at write time', () => {
      expect(() =>
        writeMemberProfile(makeMember({ member_id: 'ext-deadbeef' }), { rootDir: fixtureRoot })
      ).toThrow(/invalid member id/);
    });

    it('an ext- actor id never resolves to a member', () => {
      expect(resolveAccountableHuman('user:ext-deadbeef', { rootDir: fixtureRoot })).toBeNull();
    });
  });

  describe('resolveAccountableHuman', () => {
    it('resolves a user:<member_id> actor id to the member', () => {
      const resolved = resolveAccountableHuman('user:alice', { rootDir: fixtureRoot });
      expect(resolved?.member_id).toBe('alice');
    });

    it('resolves a bare member id to the member', () => {
      const resolved = resolveAccountableHuman('alice', { rootDir: fixtureRoot });
      expect(resolved?.member_id).toBe('alice');
    });

    it('returns null for a member that does not exist', () => {
      expect(resolveAccountableHuman('user:ghost', { rootDir: fixtureRoot })).toBeNull();
    });

    it('returns null for a legacy synthetic label (never throws)', () => {
      expect(resolveAccountableHuman('human:operator', { rootDir: fixtureRoot })).toBeNull();
    });

    it('returns null for an empty id', () => {
      expect(resolveAccountableHuman('', { rootDir: fixtureRoot })).toBeNull();
    });
  });
});
