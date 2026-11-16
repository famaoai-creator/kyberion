/** Governed tenant personal_owner (review B1, re-review 1/2/8). Hermetic: registry, approvals, audit mocked. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantProfile } from './tenant-registry.js';

const state = vi.hoisted(() => ({
  profiles: {} as Record<string, TenantProfile>,
  audits: [] as Array<{ action: string; metadata: Record<string, unknown> }>,
  decider: 'user:owner',
  verified: true,
}));
vi.mock('../authority.js', () => ({ withStoreGrant: (_r: string, run: () => unknown) => run() }));
vi.mock('./tenant-registry.js', () => ({
  listTenantProfileSlugs: () => Object.keys(state.profiles),
  readTenantProfile: (slug: string) => state.profiles[slug] ?? null,
  writeTenantProfile: (profile: TenantProfile) => {
    state.profiles[profile.tenant_slug] = profile;
    return profile;
  },
}));
vi.mock('../secret/credential-custody-approval.js', () => ({
  personalOwnerEffectRef: (tenant: string) => `tenant:${tenant}:personal_owner`,
  verifyTenantPersonalOwnerBasis: () => state.verified,
  requestCredentialCustodyApproval: () => ({ id: 'APR-po' }),
  consumeCredentialCustodyApproval: (
    _effect: unknown,
    id: string,
    accept: (d: string) => boolean
  ) => {
    if (id !== 'APR-po' || !accept(state.decider))
      throw new Error(
        '[CREDENTIAL_CUSTODY_APPROVAL_INVALID] approval must be decided by the owner'
      );
    return { humanDecider: state.decider, approvalId: id, consumedAt: '2026-11-16T01:00:00.000Z' };
  },
}));
vi.mock('../governance/audit-chain.js', () => ({
  auditChain: {
    recordDurable: (entry: { action: string; metadata: Record<string, unknown> }) => {
      state.audits.push(entry);
      return { id: 'AUD-1' };
    },
  },
}));
import {
  applyTenantPersonalOwner,
  probeTenantPersonalOwners,
  requestTenantPersonalOwner,
} from './tenant-personal-owner.js';

const tenant = (slug = 'home'): TenantProfile => ({
  tenant_slug: slug,
  display_name: slug,
  status: 'active',
  assigned_role: 'owner',
});
const apply = (personalOwner: string | null) =>
  applyTenantPersonalOwner({
    slug: 'home',
    personalOwner,
    approvalRequestId: 'APR-po',
    actor: 'user:owner',
  });
beforeEach(() => {
  state.profiles = { home: tenant() };
  state.audits = [];
  state.decider = 'user:owner';
  state.verified = true;
});

describe('tenant personal_owner', () => {
  it('is set only through an approval decided by the named person, with basis and durable audit', () => {
    expect(
      requestTenantPersonalOwner({
        slug: 'home',
        personalOwner: 'user:owner',
        requester: { requestedBy: 'user:owner' },
      }).approver
    ).toBe('user:owner');
    state.decider = 'user:cfo';
    expect(() => apply('user:owner')).toThrow(/decided by the owner/);
    state.decider = 'user:owner';
    apply('user:owner');
    expect(state.profiles.home).toMatchObject({
      personal_owner: 'user:owner',
      personal_owner_basis: {
        approval_request_id: 'APR-po',
        decided_at: '2026-11-16T01:00:00.000Z',
        audit_id: 'AUD-1',
      },
    });
    expect(state.audits[0]).toMatchObject({
      action: 'tenant.personal_owner_changed',
      metadata: { previous_personal_owner: null, personal_owner: 'user:owner' },
    });
  });

  it('is cleared (with its basis) by the current personal owner', () => {
    state.profiles.home = {
      ...tenant(),
      personal_owner: 'user:owner',
      personal_owner_basis: { approval_request_id: 'x', decided_at: 'y', audit_id: 'z' },
    };
    apply(null);
    expect(state.profiles.home!.personal_owner).toBeUndefined();
    expect(state.profiles.home!.personal_owner_basis).toBeUndefined();
  });

  it('rejects malformed principals', () => {
    expect(() =>
      requestTenantPersonalOwner({
        slug: 'home',
        personalOwner: 'owner',
        requester: { requestedBy: 'user:owner' },
      })
    ).toThrow(/user:<member>/);
  });

  it('doctor warns with every personal tenant and flags an unverified basis', async () => {
    expect(await probeTenantPersonalOwners()).toEqual({ available: true });
    state.profiles.parent = { ...tenant('parent'), personal_owner: 'user:owner' };
    state.verified = false;
    const result = await probeTenantPersonalOwners();
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/parent → user:owner \(decided unknown, UNVERIFIED basis/);
    expect(result.reason).toMatch(/personal-owner <slug> --clear/);
  });
});
