import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  isInstanceOwner: vi.fn(),
  resolveMember: vi.fn(),
  startLink: vi.fn(),
}));

vi.mock('@agent/core/authority', () => ({
  withExecutionContext: (_role: string, fn: () => unknown) => fn(),
  withExecutionContextAsync: async (_role: string, fn: () => unknown) => fn(),
}));
vi.mock('@agent/core/surface/surface-auth-routes', () => ({
  startSurfaceIdentityLink: mocks.startLink,
}));
vi.mock('@agent/core/surface/first-run-setup', async () => {
  class FirstRunError extends Error {
    constructor(
      public readonly code: string,
      public readonly field?: string
    ) {
      super(code);
    }
  }
  return {
    FirstRunError,
    claimFirstRun: mocks.claim,
    isInstanceOwner: mocks.isInstanceOwner,
    readFirstRunStatus: vi.fn(() => ({ state: 'unclaimed', code_active: true })),
  };
});
vi.mock('@agent/core/surface/oidc-login-settings', () => ({
  OidcSettingsInputError: class extends Error {},
  saveOidcLoginSettings: vi.fn(),
  summarizeOidcLoginSettings: vi.fn(),
}));
vi.mock('@agent/core/surface/oidc-browser-login', () => ({
  resolveOidcLoginConfig: vi.fn(() => ({ config: null })),
  resolveOidcRedirectOrigin: vi.fn(),
}));
vi.mock('@agent/core/organization/member-registry', () => ({
  resolveMemberByPrincipal: mocks.resolveMember,
}));
vi.mock('@agent/core/governance/audit-chain', () => ({ auditChain: { record: vi.fn() } }));

import { FirstRunError } from '@agent/core/surface/first-run-setup';
import {
  claimFirstRunForRequest,
  startIdentityLinkForViewer,
  viewerIsInstanceOwner,
} from './first-run-server';

const viewer = {
  principalId: 'token:owner-first-run',
  source: 'token' as const,
  registrationLabel: 'owner-first-run-20261009000000',
  memberId: 'owner',
  role: 'localadmin' as const,
};

describe('first-run-server', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
  });

  it('forwards only the allowed claim fields (never member_id)', () => {
    mocks.claim.mockReturnValue({
      token: 't',
      member_id: 'owner',
      tenant_slug: 'acme',
      tenant_slugs: ['acme'],
      registration_label: 'l',
    });
    const result = claimFirstRunForRequest({
      code: 'C',
      tenant_slug: 'acme',
      display_name: 'Hana',
      member_id: 'mallory',
    });
    expect(result).toMatchObject({ ok: true, token: 't', member_id: 'owner' });
    expect(result).not.toHaveProperty('registration_label');
    expect(mocks.claim.mock.calls[0][0]).not.toHaveProperty('member_id');
  });

  it.each([
    ['claimed', 409],
    ['invalid_input', 400],
    ['tenant_unavailable', 409],
    ['code_invalid', 403],
    ['code_locked', 403],
  ])('maps %s to HTTP %i', (code, status) => {
    mocks.claim.mockImplementation(() => {
      throw new (FirstRunError as unknown as new (code: string) => Error)(code);
    });
    expect(claimFirstRunForRequest({})).toMatchObject({ ok: false, status, error: code });
  });

  it('hides unexpected claim errors behind a generic 500', () => {
    mocks.claim.mockImplementation(() => {
      throw new Error('disk full at /secret/path');
    });
    expect(claimFirstRunForRequest({})).toEqual({
      ok: false,
      status: 500,
      error: 'first_run_failed',
    });
  });

  describe('startIdentityLinkForViewer', () => {
    const request = { requestOrigin: 'http://localhost:3050', loopback: false, next: '/x' };

    it('seals the member resolved from the viewer, never anything else', async () => {
      mocks.resolveMember.mockReturnValue({ member_id: 'owner', status: 'active' });
      mocks.startLink.mockResolvedValue({ ok: true, location: 'https://idp/a', setCookies: ['c'] });
      const result = await startIdentityLinkForViewer(viewer, request);
      expect(result).toEqual({ ok: true, location: 'https://idp/a', setCookies: ['c'] });
      expect(mocks.startLink).toHaveBeenCalledWith({
        surfaceId: 'concierge',
        requestOrigin: request.requestOrigin,
        loopback: false,
        linkMemberId: 'owner',
        next: '/x',
      });
    });

    it('refuses a viewer without an active member', async () => {
      mocks.resolveMember.mockReturnValue({ member_id: 'owner', status: 'suspended' });
      expect(await startIdentityLinkForViewer(viewer, request)).toMatchObject({
        ok: false,
        status: 403,
        error: 'member_required',
      });
      mocks.resolveMember.mockReturnValue(null);
      expect(await startIdentityLinkForViewer(viewer, request)).toMatchObject({ status: 403 });
      expect(mocks.startLink).not.toHaveBeenCalled();
    });

    it('reports missing SSO settings distinctly', async () => {
      mocks.resolveMember.mockReturnValue({ member_id: 'owner', status: 'active' });
      mocks.startLink.mockResolvedValue({ ok: false, view: { kind: 'unconfigured', missing: [] } });
      expect(await startIdentityLinkForViewer(viewer, request)).toMatchObject({
        status: 409,
        error: 'sso_not_configured',
      });
    });
  });

  it('requires a localadmin viewer resolved to an instance owner', () => {
    const member = { member_id: 'owner' };
    mocks.resolveMember.mockReturnValue(member);
    mocks.isInstanceOwner.mockReturnValue(true);
    expect(viewerIsInstanceOwner(viewer)).toBe(true);
    expect(mocks.resolveMember).toHaveBeenCalledWith({
      principalId: viewer.principalId,
      source: viewer.source,
      registrationLabel: viewer.registrationLabel,
      memberId: viewer.memberId,
    });
    expect(mocks.isInstanceOwner).toHaveBeenCalledWith(member);

    mocks.isInstanceOwner.mockReturnValue(false);
    expect(viewerIsInstanceOwner(viewer)).toBe(false);

    mocks.isInstanceOwner.mockReturnValue(true);
    expect(viewerIsInstanceOwner({ ...viewer, role: 'readonly' as never })).toBe(false);

    mocks.resolveMember.mockImplementation(() => {
      throw new Error('registry unreadable');
    });
    expect(viewerIsInstanceOwner(viewer)).toBe(false);
  });
});
