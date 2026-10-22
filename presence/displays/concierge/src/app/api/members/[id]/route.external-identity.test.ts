import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { SurfaceManagementError } from '@agent/core/surface/surface-management-mutations';
const s = vi.hoisted(() => ({ update: vi.fn(), context: 'a'.repeat(64) }));
vi.mock('../../../../lib/api-guard', () => ({ requireConciergeMutationAccess: () => null }));
vi.mock('../../../../lib/viewer-context', () => ({
  resolveConciergeViewer: () => ({
    context: { role: 'localadmin', source: 'loopback', tenantSlugs: ['acme'] },
  }),
  conciergeErrorResponse: (error: unknown, status: number) =>
    new Response(JSON.stringify({ ok: false, error: String(error) }), { status }),
}));
vi.mock('../../../../lib/member-management-server', async () => {
  const { SurfaceManagementError } =
    await import('@agent/core/surface/surface-management-mutations');
  return {
    memberManagementPrincipal: () => ({ memberId: 'owner', allowedTenantSlugs: ['acme'] }),
    assertMemberManagementContext: (_viewer: unknown, expected: unknown) => {
      if (expected !== undefined && expected !== s.context)
        throw new SurfaceManagementError('context_changed', 403, 'Refresh identity');
    },
  };
});
vi.mock('@agent/core/organization/member-management', () => ({
  updateManagedMember: s.update,
  managedMemberVersion: () => 'v'.repeat(64),
}));
import { PATCH } from './route.js';
function request(body: unknown): NextRequest {
  return {
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  } as unknown as NextRequest;
}
const params = { params: Promise.resolve({ id: 'carol' }) };
describe('member PATCH shared-service transport', () => {
  beforeEach(() => {
    s.update.mockReset();
    s.update.mockResolvedValue({
      member_id: 'carol',
      display_name: 'Carol',
      status: 'active',
      memberships: [
        { tenant_slug: 'acme', role: 'viewer' },
        { tenant_slug: 'private', role: 'owner' },
      ],
      external_identities: [{ issuer: 'private', subject: 'secret', email: 'private@example.com' }],
    });
  });
  it('passes the authenticated principal and identity edit to the shared service', async () => {
    const identity = { issuer: 'https://accounts.google.com/', subject: '1122334455' };
    const response = await PATCH(request({ external_identity: identity }), params);
    expect(response.status).toBe(200);
    expect(s.update).toHaveBeenCalledWith(
      { memberId: 'owner', allowedTenantSlugs: ['acme'] },
      { memberId: 'carol', externalIdentity: identity }
    );
    // A tenant-only write never returns another tenant's membership or SSO metadata.
    expect(await response.json()).toEqual({ ok: true, version: 'v'.repeat(64) });
  });
  it('passes removal, rename, membership revoke and version fields without inventing actor scope', async () => {
    await PATCH(
      request({ external_identity_remove: { issuer: 'https://id.example', subject: 'carol' } }),
      params
    );
    expect(s.update).toHaveBeenLastCalledWith(expect.anything(), {
      memberId: 'carol',
      removeExternalIdentity: { issuer: 'https://id.example', subject: 'carol' },
    });
    await PATCH(request({ display_name: 'Carol human', expected_version: 'reviewed' }), params);
    expect(s.update).toHaveBeenLastCalledWith(expect.anything(), {
      memberId: 'carol',
      displayName: 'Carol human',
      expectedVersion: 'reviewed',
    });
    await PATCH(request({ membership_remove: 'acme' }), params);
    expect(s.update).toHaveBeenLastCalledWith(expect.anything(), {
      memberId: 'carol',
      removeTenantSlug: 'acme',
    });
  });
  it('rejects changed identity context before any core effect', async () => {
    const response = await PATCH(
      request({ display_name: 'Carol', expected_context_id: 'b'.repeat(64) }),
      params
    );
    expect(response.status).toBe(403);
    expect(s.update).not.toHaveBeenCalled();
  });
  it.each([
    { external_identity: 'nope' },
    { external_identity: { issuer: 'https://id', subject: 42 } },
    { external_identity: { issuer: 'https://id', subject: 's', extra: 1 } },
    { display_name: 4 },
    { tenant_slug: [] },
    { actor_id: 'user:other' },
  ])('rejects malformed transport fields %#', async (body) => {
    expect((await PATCH(request(body), params)).status).toBe(400);
    expect(s.update).not.toHaveBeenCalled();
  });
  it('preserves domain owner/conflict/input status codes', async () => {
    for (const status of [400, 403, 404, 409]) {
      s.update.mockRejectedValueOnce(
        new SurfaceManagementError('domain', status, 'Domain refused')
      );
      expect((await PATCH(request({ display_name: 'Carol' }), params)).status).toBe(status);
    }
  });
  it('maps canonical external identity uniqueness failures to 409', async () => {
    s.update.mockRejectedValueOnce(
      new Error("external identity 'x#y' is already bound to member 'dave'")
    );
    expect(
      (await PATCH(request({ external_identity: { issuer: 'https://id', subject: 's' } }), params))
        .status
    ).toBe(409);
  });
});
