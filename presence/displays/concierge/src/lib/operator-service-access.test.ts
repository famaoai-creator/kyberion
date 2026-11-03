import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { humanActor } from '@agent/core/actor';
import type { ResolvedPrincipal } from '@agent/core/authn-principal-resolver';

const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  peer: vi.fn(),
  viewer: vi.fn(),
  bootstrapOpen: false,
  members: {} as Record<string, { member_id: string; status: string }>,
  auditOk: true,
}));
vi.mock('./api-guard', () => ({ requireConciergeMutationAccess: mocks.guard }));
vi.mock('./loopback-peer', () => ({ isLoopbackPeer: mocks.peer }));
vi.mock('./viewer-context', () => ({
  resolveConciergeViewer: mocks.viewer,
  conciergeCredential: () => ({ token: 'session-token', source: 'session-cookie' }),
}));
vi.mock('@agent/core/surface/first-run-setup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/surface/first-run-setup')>()),
  readFirstRunStatus: () => ({
    state: mocks.bootstrapOpen ? 'unclaimed' : 'claimed',
    code_active: false,
  }),
}));
vi.mock('@agent/core/surface/installation-owner-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/surface/installation-owner-access')>()),
  recordInstallationAccessAudit: () => mocks.auditOk,
}));
vi.mock('@agent/core/organization/member-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/organization/member-registry')>()),
  readMemberProfile: (id: string) => mocks.members[id] ?? null,
}));

import {
  isIssuedInstallationOwnerGrant,
  resetInstallationBootstrapCache,
} from '@agent/core/surface/installation-owner-access';
import { resolveOperatorServiceAccess } from './operator-service-access';

function principal(memberId: string): ResolvedPrincipal {
  return {
    actor: humanActor(memberId),
    principalId: 'dev-user',
    role: 'localadmin',
    tenantSlugs: ['default'],
    organizationIds: 'all',
    projectIds: 'all',
    tierAccess: ['public', 'confidential'],
    source: 'oidc',
    provider: 'browser-session',
    assurance: 'high',
    memberId,
  };
}
const owner = {
  role: 'localadmin',
  source: 'token',
  principalId: 'dev-user',
  memberId: 'owner',
  principal: principal('owner'),
};
const approver = {
  role: 'localadmin',
  source: 'token',
  principalId: 'alice-sub',
  memberId: 'alice',
  principal: principal('alice'),
};
const anonymous = { role: 'localadmin', source: 'loopback', principalId: 'human:operator' };
const url = 'http://127.0.0.1:3050/api/services/operator';

beforeEach(() => {
  vi.resetAllMocks();
  resetInstallationBootstrapCache();
  mocks.bootstrapOpen = false;
  mocks.auditOk = true;
  mocks.members = {
    owner: { member_id: 'owner', status: 'active' },
    alice: { member_id: 'alice', status: 'active' },
  };
  mocks.peer.mockReturnValue(false);
  mocks.viewer.mockReturnValue({ context: owner });
});

describe('installation-owner operator service access', () => {
  it('lets the signed-in installation owner read from a remote origin', () => {
    const access = resolveOperatorServiceAccess(new NextRequest(url));
    expect(access.response).toBeUndefined();
    expect(access.principal).toMatchObject({ principalId: 'user:owner', loopback: false });
    expect(isIssuedInstallationOwnerGrant(access.principal!.installationGrant, 'read')).toBe(true);
    expect(mocks.guard).not.toHaveBeenCalled();
  });

  it('requires a passkey step-up for a remote owner write', async () => {
    const access = resolveOperatorServiceAccess(new NextRequest(url, { method: 'POST' }));
    expect(access.response?.status).toBe(403);
    expect(await access.response!.json()).toEqual({
      ok: false,
      error: 'installation_step_up_required',
    });
  });

  it('lets the owner write from a trusted loopback peer without a step-up', () => {
    mocks.peer.mockReturnValue(true);
    const access = resolveOperatorServiceAccess(new NextRequest(url, { method: 'POST' }));
    expect(access.principal).toMatchObject({ principalId: 'user:owner', loopback: true });
    expect(isIssuedInstallationOwnerGrant(access.principal!.installationGrant, 'write')).toBe(true);
  });

  it('refuses an admitted write when its audit record cannot be written (503)', async () => {
    mocks.peer.mockReturnValue(true);
    mocks.auditOk = false;
    const access = resolveOperatorServiceAccess(new NextRequest(url, { method: 'POST' }));
    expect(access.response?.status).toBe(503);
    expect(await access.response!.json()).toEqual({
      ok: false,
      error: 'installation_audit_unavailable',
    });
    // Reads are not audited and keep working.
    expect(resolveOperatorServiceAccess(new NextRequest(url)).principal).toBeDefined();
  });

  it('denies another member with a stable code, never 500', async () => {
    mocks.peer.mockReturnValue(true);
    mocks.viewer.mockReturnValue({ context: approver });
    const access = resolveOperatorServiceAccess(new NextRequest(url));
    expect(access.response?.status).toBe(403);
    expect(await access.response!.json()).toEqual({
      ok: false,
      error: 'installation_owner_required',
    });
  });

  it('denies a suspended owner', () => {
    mocks.peer.mockReturnValue(true);
    mocks.members.owner = { member_id: 'owner', status: 'suspended' };
    expect(resolveOperatorServiceAccess(new NextRequest(url)).response?.status).toBe(403);
  });

  it('admits anonymous loopback only while bootstrap is open', async () => {
    mocks.peer.mockReturnValue(true);
    mocks.viewer.mockReturnValue({ context: anonymous });
    const closed = resolveOperatorServiceAccess(new NextRequest(url));
    expect(closed.response?.status).toBe(401);
    expect(await closed.response!.json()).toEqual({ ok: false, error: 'authentication_required' });

    mocks.bootstrapOpen = true;
    resetInstallationBootstrapCache();
    expect(resolveOperatorServiceAccess(new NextRequest(url)).principal).toMatchObject({
      principalId: 'human:concierge-localadmin',
      source: 'loopback',
      loopback: true,
    });
  });

  it('treats spoofed loopback headers as a remote request', async () => {
    const req = new NextRequest(url, {
      method: 'POST',
      headers: { 'x-real-ip': '127.0.0.1', 'x-forwarded-for': '127.0.0.1' },
    });
    const access = resolveOperatorServiceAccess(req);
    expect(await access.response!.json()).toEqual({
      ok: false,
      error: 'installation_step_up_required',
    });
  });

  it('preserves the existing unsafe-method CSRF gate before resolving authority', () => {
    mocks.guard.mockReturnValue(NextResponse.json({ ok: false }, { status: 403 }));
    expect(
      resolveOperatorServiceAccess(new NextRequest(url, { method: 'POST' })).response?.status
    ).toBe(403);
    expect(mocks.viewer).not.toHaveBeenCalled();
  });

  it('denies cross-site metadata requests', () => {
    expect(
      resolveOperatorServiceAccess(
        new NextRequest(url, { headers: { 'sec-fetch-site': 'cross-site' } })
      ).response?.status
    ).toBe(403);
  });

  it.each([
    [429, 429, undefined],
    [403, 403, 'installation_owner_required'],
  ])('keeps a %s viewer refusal as %s with a fixed body', async (status, expected, code) => {
    mocks.viewer.mockReturnValue({
      response: NextResponse.json({ error: 'opaque-internal-detail' }, { status }),
    });
    const response = resolveOperatorServiceAccess(new NextRequest(url)).response!;
    expect(response.status).toBe(expected);
    if (code) expect(await response.json()).toEqual({ ok: false, error: code });
  });

  it('maps unresolved viewers to a fixed safe 401', async () => {
    mocks.viewer.mockReturnValue({
      response: NextResponse.json({ error: 'opaque-internal-detail' }, { status: 401 }),
    });
    const response = resolveOperatorServiceAccess(new NextRequest(url)).response!;
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: 'authentication_required' });
  });
});
