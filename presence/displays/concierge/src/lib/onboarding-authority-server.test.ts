import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConciergeViewerContext } from './viewer-context';

const mocks = vi.hoisted(() => ({
  ensureOwnerMember: vi.fn(),
  resolveMemberByPrincipal: vi.fn(),
  installation: vi.fn(),
  requestStatus: vi.fn(),
}));
vi.mock('@agent/core/authority', () => ({
  withExecutionContext: (_role: string, fn: () => unknown) => fn(),
}));
vi.mock('@agent/core/secure-io', () => ({
  withSensitivePathMediation: (fn: () => unknown) => fn(),
}));
vi.mock('@agent/core/organization/member-registry', () => ({
  ensureOwnerMember: mocks.ensureOwnerMember,
  ownerAccountableHumanId: () => 'user:owner',
  resolveMemberByPrincipal: mocks.resolveMemberByPrincipal,
}));
vi.mock('@agent/core/organization/onboarding-authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/organization/onboarding-authority')>()),
  onboardingAuthorityRequestStatus: mocks.requestStatus,
}));
vi.mock('./installation-access', () => ({
  resolveConciergeInstallationAccess: mocks.installation,
}));

import {
  onboardingAuthorityPrincipal,
  onboardingApprovalMember,
} from './onboarding-authority-server';
import type { ApprovalRequestRecord } from '@agent/core/governance/approval-store';
import { ONBOARDING_AUTHORITY_CHANNEL } from '@agent/core/organization/onboarding-authority';

const ORG_SCOPE = { kind: 'organization' as const, tenant_slug: 'acme' };

const remoteViewer = (over: Partial<ConciergeViewerContext> = {}) =>
  ({
    role: 'readonly',
    source: 'token',
    principalId: 'human:concierge-token',
    memberId: 'tanaka',
    tenantSlugs: ['acme'],
    ...over,
  }) as ConciergeViewerContext;

const ownerMember = (over: Record<string, unknown> = {}) => ({
  member_id: 'tanaka',
  status: 'active',
  memberships: [{ tenant_slug: 'acme', role: 'owner' }],
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.installation.mockReturnValue({ allowed: false, code: 'installation_required' });
  mocks.resolveMemberByPrincipal.mockReturnValue(ownerMember());
});

describe('onboardingAuthorityPrincipal — organization scope remote admission', () => {
  it('admits a remote readonly viewer who is an owner member of the tenant', () => {
    const principal = onboardingAuthorityPrincipal(remoteViewer(), ORG_SCOPE, {
      admitRemoteTenantOwner: true,
    });
    // The installation owner stays accountable for material in the
    // installation store; the tenant owner is recorded as the requester, so
    // they can propose and apply but can never self-approve.
    expect(principal.accountableId).toBe('user:owner');
    expect(principal.requesterId).toBe('user:tanaka');
    expect(principal.requesterId).not.toBe(principal.accountableId);
    expect(principal.personalOwner).toBe(false);
    expect(principal.tenantSlugs).toEqual(['acme']);
  });

  it('keeps the operator principal self-accountable for the same scope', () => {
    const operator = {
      role: 'localadmin',
      source: 'loopback',
      principalId: 'human:concierge-localadmin',
      tenantSlugs: 'all',
    } as ConciergeViewerContext;
    mocks.resolveMemberByPrincipal.mockReturnValue(ownerMember({ member_id: 'owner' }));
    const principal = onboardingAuthorityPrincipal(operator, ORG_SCOPE);
    expect(principal.accountableId).toBe('user:owner');
    expect(principal.requesterId).toBe('user:owner');
  });

  it('still refuses the same remote viewer without the opt-in', () => {
    expect(() => onboardingAuthorityPrincipal(remoteViewer(), ORG_SCOPE)).toThrow('owner_required');
  });

  it('refuses a remote viewer whose membership is not owner in that tenant', () => {
    mocks.resolveMemberByPrincipal.mockReturnValue(
      ownerMember({ memberships: [{ tenant_slug: 'acme', role: 'member' }] })
    );
    expect(() =>
      onboardingAuthorityPrincipal(remoteViewer(), ORG_SCOPE, { admitRemoteTenantOwner: true })
    ).toThrow('tenant_owner_required');
  });

  it('refuses a remote viewer whose tenant scope does not cover the binding tenant', () => {
    expect(() =>
      onboardingAuthorityPrincipal(remoteViewer({ tenantSlugs: ['other'] }), ORG_SCOPE, {
        admitRemoteTenantOwner: true,
      })
    ).toThrow('tenant_owner_required');
  });

  it('refuses a remote viewer with no active member', () => {
    mocks.resolveMemberByPrincipal.mockReturnValue(ownerMember({ status: 'suspended' }));
    expect(() =>
      onboardingAuthorityPrincipal(remoteViewer(), ORG_SCOPE, { admitRemoteTenantOwner: true })
    ).toThrow('active_owner_member_required');
  });

  it('never admits a remote viewer to the person scope', () => {
    expect(() =>
      onboardingAuthorityPrincipal(
        remoteViewer(),
        { kind: 'person' },
        {
          admitRemoteTenantOwner: true,
        }
      )
    ).toThrow('installation_required');
  });
});

describe('onboardingApprovalMember — accountable-human decision binding', () => {
  const record = {
    channel: ONBOARDING_AUTHORITY_CHANNEL,
    scope: { tenant_slug: 'acme' },
    id: 'req-1',
  } as ApprovalRequestRecord;

  it('refuses to record a decision for a principal whose requester is not the accountable human', () => {
    // A remote localadmin-bound tenant owner resolves requesterId=user:tanaka
    // with accountableId=user:owner — letting them decide would falsify
    // decidedBy in the audit trail.
    mocks.requestStatus.mockReturnValue({ ok: true });
    const viewer = remoteViewer({ role: 'localadmin' });
    expect(onboardingApprovalMember(viewer, record)).toBeNull();
    expect(mocks.requestStatus).not.toHaveBeenCalled();
  });

  it('admits the accountable human deciding their own org-scope record', () => {
    mocks.requestStatus.mockReturnValue({ ok: true });
    mocks.resolveMemberByPrincipal.mockReturnValue(ownerMember({ member_id: 'owner' }));
    const operator = {
      role: 'localadmin',
      source: 'loopback',
      principalId: 'human:concierge-localadmin',
      principal: { actor: { id: 'user:owner' } },
      tenantSlugs: 'all',
    } as ConciergeViewerContext;
    const member = onboardingApprovalMember(operator, record);
    expect(member).toMatchObject({ memberId: 'owner', decidedBy: 'user:owner' });
  });
});
