import { beforeEach, describe, expect, it, vi } from 'vitest';

const members = vi.hoisted(() => ({
  byMember: {} as Record<string, { id: string; display_name: string; role?: string }>,
}));
vi.mock('./front-desk-member', () => ({
  resolveConciergeDecidedBy: vi.fn((viewer: { memberId?: string }) =>
    viewer.memberId ? (members.byMember[viewer.memberId] ?? null) : null
  ),
}));
vi.mock('@agent/core/organization/tenant-registry', () => ({
  listTenantProfileSlugs: vi.fn(() => ['acme', 'other-co']),
}));
vi.mock('@agent/core/integrations/email-bridge', () => ({
  emailBackendRegistry: { resolve: vi.fn() },
}));

import { createInviteEmailDraft } from './invite-email';

const viewer = (memberId: string, tenants: string[] = ['acme']) =>
  ({ tenantSlugs: tenants, source: 'token', memberId, role: 'localadmin' }) as never;
const CODE = 'acme~inv-abcd1234~s3cr3t_Value-9';

describe('invite email draft', () => {
  const createDraft = vi.fn();
  beforeEach(() => {
    createDraft.mockReset().mockResolvedValue(true);
    members.byMember = {
      owner: { id: 'user:owner', display_name: 'Owner', role: 'owner' },
      viewer: { id: 'user:viewer', display_name: 'Vee', role: 'viewer' },
    };
  });
  const make = (v: unknown, body: Record<string, unknown>) =>
    createInviteEmailDraft(v as never, body, 'https://concierge.example', 'en', { createDraft });

  it('creates a draft (never a send) with the join link', async () => {
    const result = await make(viewer('owner'), {
      tenant_slug: 'acme',
      code: CODE,
      email: 'new@example.com',
    });
    expect(result).toEqual({ ok: true, draft: 'created' });
    const params = createDraft.mock.calls[0][0];
    expect(params.to).toBe('new@example.com');
    expect(params.body).toContain(
      `https://concierge.example/join?code=${encodeURIComponent(CODE)}`
    );
    expect(params.subject).toContain('acme');
  });

  it('reports an unavailable backend instead of failing', async () => {
    createDraft.mockResolvedValue(false);
    expect(
      await make(viewer('owner'), { tenant_slug: 'acme', code: CODE, email: 'a@b.co' })
    ).toEqual({ ok: true, draft: 'unavailable' });
  });

  it('refuses bad addresses (including recipient lists), foreign codes and non-inviters', async () => {
    const base = { tenant_slug: 'acme', code: CODE };
    for (const email of ['x', 'a@b', 'a@b.co, c@d.co', 'a@b.co;c@d.co', '<a@b.co>', '']) {
      expect(await make(viewer('owner'), { ...base, email })).toMatchObject({
        ok: false,
        error: 'invalid_email',
      });
    }
    expect(
      await make(viewer('owner'), { tenant_slug: 'acme', code: 'other~i~s', email: 'a@b.co' })
    ).toMatchObject({ ok: false, error: 'invalid_code' });
    expect(await make(viewer('viewer'), { ...base, email: 'a@b.co' })).toMatchObject({
      ok: false,
      status: 403,
      error: 'member_required',
    });
    expect(await make(viewer('owner', ['other-co']), { ...base, email: 'a@b.co' })).toMatchObject({
      ok: false,
      error: 'tenant_out_of_scope',
    });
    expect(createDraft).not.toHaveBeenCalled();
  });
});
