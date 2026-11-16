/**
 * Registry-backed eligibility lookups (review B1, re-review 1): bootstrapped ownership and a
 * hand-edited personal_owner never count; only a basis verified against the approval store does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ approval: undefined as Record<string, unknown> | undefined }));
vi.mock('../authority.js', () => ({
  withStoreGrant: (_role: string, run: () => unknown) => run(),
}));
vi.mock('../organization/member-registry.js', () => ({
  ownerAccountableHumanId: () => 'user:owner',
  // ensureOwnerMember gives the owner an `owner` membership on every tenant.
  readMemberProfile: () => ({
    member_id: 'owner',
    status: 'active',
    memberships: [
      { tenant_slug: 'parent', role: 'owner' },
      { tenant_slug: 'home', role: 'owner' },
      { tenant_slug: 'forged', role: 'owner' },
    ],
  }),
}));
const BASIS = {
  approval_request_id: 'APR-1',
  decided_at: '2026-11-16T01:00:00.000Z',
  audit_id: 'A',
};
vi.mock('../organization/tenant-registry.js', () => ({
  readTenantProfile: (slug: string) =>
    ({
      parent: { tenant_slug: 'parent', status: 'active', assigned_role: 'owner' },
      home: {
        tenant_slug: 'home',
        status: 'active',
        assigned_role: 'owner',
        personal_owner: 'user:owner',
        personal_owner_basis: BASIS,
      },
      // Hand-edited: the field without any approval basis.
      forged: {
        tenant_slug: 'forged',
        status: 'active',
        assigned_role: 'owner',
        personal_owner: 'user:owner',
      },
    })[slug] ?? null,
}));
vi.mock('../governance/approval-store-reader.js', () => ({
  loadApprovalRequest: (_channel: string, id: string) =>
    id === 'APR-1' ? state.approval : undefined,
  listApprovalRequests: () => [],
  isApprovalRequestExpired: () => false,
}));
vi.mock('../governance/service-credential-grant-scope.js', () => ({
  serviceAllocationApprovedByOwner: (
    approval: { workflow: { approvals: { approvedBy: string }[] } },
    owner: string
  ) => approval.workflow.approvals[0]!.approvedBy === owner,
}));
import { computeApprovalPayloadHash } from '../governance/approval-presentation.js';
import {
  defaultCredentialEligibilityDeps,
  isTenantOwnerMember,
} from './credential-eligibility-deps.js';
import {
  assessCredentialEligibility,
  buildCredentialRecord,
  lendingFromRecord,
} from './credential-custody.js';
import { credentialCustodyEffectBinding } from './credential-custody-approval.js';

const effect = {
  action: 'tenant_personal_owner' as const,
  tenant_slug: 'home',
  personal_owner: 'user:owner',
};
const approval = (overrides: Record<string, unknown> = {}) => ({
  id: 'APR-1',
  status: 'approved',
  consumption: {
    consumer: 'credential_custody',
    effectRef: 'tenant:home:personal_owner',
    consumedAt: BASIS.decided_at,
  },
  accountability: {
    effectBinding: credentialCustodyEffectBinding(effect),
    payloadHash: computeApprovalPayloadHash({
      ...effect,
      effect: credentialCustodyEffectBinding(effect),
    }),
  },
  workflow: { approvals: [{ approvedBy: 'user:owner' }] },
  ...overrides,
});
beforeEach(() => {
  state.approval = approval();
});

describe('default eligibility lookups', () => {
  const pro = lendingFromRecord(
    buildCredentialRecord({
      credentialRef: 'person:owner:claude-subscription',
      plan: 'pro',
      value: 'sk-ant-oat-test-0001',
      registeredBy: 'user:owner',
    })
  );
  const deps = { ...defaultCredentialEligibilityDeps, borrowerAttested: () => true };
  const code = (tenant: string) => {
    const result = assessCredentialEligibility(pro, tenant, new Date(), deps);
    return 'code' in result ? result.code : 'ok';
  };

  it('counts only a verified personal_owner, not owner memberships, assigned_role or a hand edit', () => {
    expect(isTenantOwnerMember('owner', 'parent')).toBe(true);
    expect(defaultCredentialEligibilityDeps.installationPerson()).toBe('owner');
    expect(code('parent')).toBe('CREDENTIAL_KIND_NOT_ELIGIBLE');
    expect(code('forged')).toBe('CREDENTIAL_KIND_NOT_ELIGIBLE');
    expect(code('home')).toBe('ok');
  });

  it.each([
    ['revoked', { revocation: { at: 'x' } }],
    [
      'consumed for another tenant',
      {
        consumption: {
          consumer: 'credential_custody',
          effectRef: 'tenant:parent:personal_owner',
          consumedAt: BASIS.decided_at,
        },
      },
    ],
    [
      'bound to another person',
      {
        accountability: {
          effectBinding: 'credential-custody:personal-owner:home',
          payloadHash: 'other',
        },
      },
    ],
    ['decided by someone else', { workflow: { approvals: [{ approvedBy: 'user:cfo' }] } }],
    [
      'not the approval that wrote the field',
      {
        consumption: {
          consumer: 'credential_custody',
          effectRef: 'tenant:home:personal_owner',
          consumedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    ],
  ])('refuses a basis whose approval is %s', (_name, overrides) => {
    state.approval = approval(overrides);
    expect(code('home')).toBe('CREDENTIAL_KIND_NOT_ELIGIBLE');
  });
});
