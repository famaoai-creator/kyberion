import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  readMemberProfile: vi.fn(),
  writeMemberProfile: vi.fn(),
  roleForTenant: vi.fn(),
  resolveRole: vi.fn(),
}));

vi.mock('../../../../lib/api-guard', () => ({
  requireConciergeMutationAccess: vi.fn(() => null),
}));
vi.mock('../../../../lib/viewer-context', () => ({
  resolveConciergeViewer: vi.fn(() => ({
    context: { role: 'localadmin', tenantSlugs: 'all', source: 'loopback' },
  })),
  conciergeErrorResponse: vi.fn(
    (error: unknown, status: number) =>
      new Response(JSON.stringify({ ok: false, error: String(error) }), { status })
  ),
}));
vi.mock('../../../../lib/front-desk-member', () => ({
  conciergeFrontDeskRoleForTenant: mocks.roleForTenant,
  resolveConciergeFrontDeskRole: mocks.resolveRole,
}));
vi.mock('@agent/core/authority', () => ({
  withExecutionContext: vi.fn((_role: string, fn: () => unknown) => fn()),
}));
vi.mock('@agent/core/organization/member-registry', () => ({
  isValidMemberId: (id: string) => /^[a-z][a-z0-9-]{1,30}$/.test(id),
  readMemberProfile: mocks.readMemberProfile,
  writeMemberProfile: mocks.writeMemberProfile,
}));

import { PATCH } from './route.js';

function request(body: unknown): NextRequest {
  return {
    headers: new Headers({ 'content-type': 'application/json', 'accept-language': 'en' }),
    json: async () => body,
  } as unknown as NextRequest;
}
const params = { params: Promise.resolve({ id: 'carol' }) };
const member = (over: Record<string, unknown> = {}) => ({
  member_id: 'carol',
  display_name: 'Carol',
  status: 'active',
  memberships: [{ tenant_slug: 'acme-corp', role: 'viewer' }],
  access_registrations: [],
  ...over,
});
const identity = { issuer: 'https://accounts.google.com/', subject: '1122334455' };

describe('concierge member PATCH — SSO identity binding', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.readMemberProfile.mockReturnValue(member());
    mocks.writeMemberProfile.mockImplementation((profile: unknown) => profile);
    mocks.roleForTenant.mockReturnValue('owner');
    mocks.resolveRole.mockReturnValue('owner');
  });

  it('binds an OIDC iss+sub (trailing slash trimmed) for an owner', async () => {
    const response = await PATCH(request({ external_identity: identity }), params);
    expect(response.status).toBe(200);
    const written = mocks.writeMemberProfile.mock.calls[0]![0] as {
      external_identities: unknown[];
    };
    expect(written.external_identities).toEqual([
      { issuer: 'https://accounts.google.com', subject: '1122334455' },
    ]);
  });

  it('is idempotent for an identity that is already bound', async () => {
    mocks.readMemberProfile.mockReturnValue(
      member({
        external_identities: [{ issuer: 'https://accounts.google.com', subject: '1122334455' }],
      })
    );
    await PATCH(request({ external_identity: identity }), params);
    const written = mocks.writeMemberProfile.mock.calls[0]![0] as {
      external_identities: unknown[];
    };
    expect(written.external_identities).toHaveLength(1);
  });

  it('takes over a SCIM-made binding the owner re-asserts (SCIM can no longer move it)', async () => {
    mocks.readMemberProfile.mockReturnValue(
      member({
        external_identities: [
          {
            issuer: 'https://accounts.google.com/',
            subject: '1122334455',
            provisioned_by: 'scim:scim-0123456789abcdef',
          },
          {
            issuer: 'https://slack.com',
            subject: 'U1',
            provisioned_by: 'scim:scim-0123456789abcdef',
          },
        ],
      })
    );
    const response = await PATCH(request({ external_identity: identity }), params);
    expect(response.status).toBe(200);
    const written = mocks.writeMemberProfile.mock.calls[0]![0] as {
      external_identities: unknown[];
    };
    expect(written.external_identities).toEqual([
      { issuer: 'https://accounts.google.com/', subject: '1122334455' },
      { issuer: 'https://slack.com', subject: 'U1', provisioned_by: 'scim:scim-0123456789abcdef' },
    ]);
  });

  it('removes a bound identity', async () => {
    mocks.readMemberProfile.mockReturnValue(
      member({
        external_identities: [{ issuer: 'https://accounts.google.com', subject: '1122334455' }],
      })
    );
    const response = await PATCH(request({ external_identity_remove: identity }), params);
    expect(response.status).toBe(200);
    const written = mocks.writeMemberProfile.mock.calls[0]![0] as {
      external_identities: unknown[];
    };
    expect(written.external_identities).toEqual([]);
  });

  it('requires owner on EVERY tenant the member belongs to (binding grants the whole scope)', async () => {
    mocks.readMemberProfile.mockReturnValue(
      member({
        memberships: [
          { tenant_slug: 'acme-corp', role: 'viewer' },
          { tenant_slug: 'other', role: 'viewer' },
        ],
      })
    );
    mocks.roleForTenant.mockImplementation((_ctx: unknown, tenant: string) =>
      tenant === 'acme-corp' ? 'owner' : 'viewer'
    );
    const response = await PATCH(request({ external_identity: identity }), params);
    expect(response.status).toBe(403);
    expect(mocks.writeMemberProfile).not.toHaveBeenCalled();
  });

  it.each([
    [{ external_identity: { issuer: 'https://idp', subject: '' } }],
    [{ external_identity: { issuer: 'has space', subject: 's' } }],
    [{ external_identity: { issuer: 'https://idp', subject: 's', extra: 1 } }],
    [{ external_identity: 'nope' }],
    [{ external_identity: identity, external_identity_remove: identity }],
    [{ external_identity: identity, status: 'suspended' }],
    [{ external_identity: identity, tenant_slug: 'acme-corp', role: 'owner' }],
  ])('rejects a malformed or combined request %#', async (body) => {
    const response = await PATCH(request(body), params);
    expect(response.status).toBe(400);
    expect(mocks.writeMemberProfile).not.toHaveBeenCalled();
  });

  it('maps "already bound to another member" to 409', async () => {
    mocks.writeMemberProfile.mockImplementation(() => {
      throw new Error("external identity 'x#y' is already bound to member 'dave'");
    });
    const response = await PATCH(request({ external_identity: identity }), params);
    expect(response.status).toBe(409);
  });
});
