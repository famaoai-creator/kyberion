// Runs the real installation-owner model (`resolveConciergeInstallationAccess`
// → `resolveInstallationOwnerAccess`). Only its facts are fixtures: whether the
// peer is attested loopback, the owner member profile and the first-run state.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { ResolvedPrincipal } from '@agent/core/authn-principal-resolver';

const f = vi.hoisted(() => ({
  loopback: true,
  ownerStatus: 'active' as 'active' | 'suspended' | null,
  firstRun: 'claimed' as 'claimed' | 'unclaimed',
}));
vi.mock('../loopback-peer', () => ({ isLoopbackPeer: () => f.loopback }));
vi.mock('@agent/core/organization/member-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/organization/member-registry')>()),
  readMemberProfile: (memberId: string) =>
    memberId === 'owner' && f.ownerStatus ? { member_id: 'owner', status: f.ownerStatus } : null,
}));
vi.mock('@agent/core/surface/first-run-setup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/surface/first-run-setup')>()),
  readFirstRunStatus: () => ({ state: f.firstRun }),
}));

import { resetInstallationBootstrapCache } from '@agent/core/surface/installation-owner-access';
import { opsViewerMayActRepositoryWide } from './repository-wide-access';
import type { ViewerContext } from './ops-viewer';

const req = { headers: { get: (): null => null } } as unknown as NextRequest;
const BOUND = ['alpha-team'];

function principal(overrides: Partial<ResolvedPrincipal>): ResolvedPrincipal {
  return {
    actor: { kind: 'human', id: 'user:owner' },
    principalId: 'user:owner',
    role: 'localadmin',
    tenantSlugs: BOUND,
    organizationIds: 'all',
    projectIds: 'all',
    tierAccess: ['confidential', 'public'],
    source: 'oidc',
    provider: 'browser-session',
    assurance: 'high',
    memberId: 'owner',
    ...overrides,
  } as ResolvedPrincipal;
}

function viewer(
  tenantSlugs: string[] | 'all',
  source: 'loopback' | 'token',
  resolved?: ResolvedPrincipal
): ViewerContext {
  return {
    role: 'localadmin',
    tenantSlugs,
    source,
    ...(resolved ? { principal: resolved } : {}),
  } as ViewerContext;
}

const signedInOwner = () => viewer(BOUND, 'token', principal({}));
const anonymousLoopback = () =>
  viewer(
    BOUND,
    'loopback',
    principal({ source: 'loopback', provider: 'loopback-local', assurance: 'medium' })
  );

beforeEach(() => {
  f.loopback = true;
  f.ownerStatus = 'active';
  f.firstRun = 'claimed';
  resetInstallationBootstrapCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetInstallationBootstrapCache();
});

describe('opsViewerMayActRepositoryWide (real installation-owner model)', () => {
  it('admits an all-tenant viewer whoever it is', () => {
    f.ownerStatus = null;
    expect(opsViewerMayActRepositoryWide(viewer('all', 'loopback'), req)).toBe(true);
    expect(
      opsViewerMayActRepositoryWide(
        viewer('all', 'token', principal({ provider: 'env-token', memberId: undefined })),
        req
      )
    ).toBe(true);
  });

  it('admits the signed-in installation owner on a tenant-bound server', () => {
    expect(opsViewerMayActRepositoryWide(signedInOwner(), req)).toBe(true);
  });

  it('refuses the owner from another device without a step-up, and a suspended owner', () => {
    f.loopback = false;
    expect(opsViewerMayActRepositoryWide(signedInOwner(), req)).toBe(false);
    f.loopback = true;
    f.ownerStatus = 'suspended';
    expect(opsViewerMayActRepositoryWide(signedInOwner(), req)).toBe(false);
  });

  it('refuses a signed-in localadmin member who is not the owner', () => {
    const member = principal({
      actor: { kind: 'human', id: 'user:bob' },
      principalId: 'user:bob',
      memberId: 'bob',
    } as Partial<ResolvedPrincipal>);
    expect(opsViewerMayActRepositoryWide(viewer(BOUND, 'token', member), req)).toBe(false);
  });

  it('refuses the env localadmin token on a tenant-bound server', () => {
    const envToken = principal({
      actor: { kind: 'service', id: 'service:env-localadmin-token' },
      principalId: 'service:env-localadmin-token',
      source: 'token',
      provider: 'env-token',
      assurance: 'low',
      memberId: undefined,
    } as Partial<ResolvedPrincipal>);
    expect(opsViewerMayActRepositoryWide(viewer(BOUND, 'token', envToken), req)).toBe(false);
  });

  it('refuses a registry token scoped to tenants even when it is bound to the owner member', () => {
    // The owner model alone would admit this principal; its tenant list is the
    // registration's own scope, so the override does not apply.
    const ownerRegistration = principal({ source: 'token', provider: 'registry-token' });
    expect(opsViewerMayActRepositoryWide(viewer(BOUND, 'token', ownerRegistration), req)).toBe(
      false
    );
  });

  it('admits credential-less loopback only while bootstrap is open or the escape hatch is on', () => {
    expect(opsViewerMayActRepositoryWide(anonymousLoopback(), req)).toBe(false);

    f.firstRun = 'unclaimed';
    resetInstallationBootstrapCache();
    expect(opsViewerMayActRepositoryWide(anonymousLoopback(), req)).toBe(true);

    f.firstRun = 'claimed';
    resetInstallationBootstrapCache();
    vi.stubEnv('KYBERION_CONCIERGE_ALLOW_ANONYMOUS_LOOPBACK', '1');
    expect(opsViewerMayActRepositoryWide(anonymousLoopback(), req)).toBe(true);
  });
});
