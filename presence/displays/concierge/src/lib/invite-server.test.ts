import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const members = vi.hoisted(() => ({
  byMember: {} as Record<string, { id: string; display_name: string; role?: 'owner' | 'approver' }>,
}));

vi.mock('./front-desk-member', () => ({
  resolveConciergeDecidedBy: vi.fn((viewer: { memberId?: string }, tenant?: string) => {
    const who = viewer.memberId ? members.byMember[viewer.memberId] : undefined;
    return who && tenant === 'acme' ? who : who ? { ...who, role: undefined } : null;
  }),
}));
vi.mock('@agent/core/organization/tenant-registry', () => ({
  listTenantProfileSlugs: vi.fn(() => ['acme', 'other-co']),
}));
const resolveMember = vi.hoisted(() => vi.fn());
vi.mock('@agent/core/organization/member-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/organization/member-registry')>()),
  resolveMemberByPrincipal: resolveMember,
}));
vi.mock('@agent/core/authority', () => ({
  withExecutionContext: (_role: string, fn: () => unknown) => fn(),
}));

import * as pathResolver from '@agent/core/path-resolver';
import { safeRmSync } from '@agent/core/secure-io';
import { createInvite } from '@agent/core/organization/member-invite';
import {
  acceptInviteForViewer,
  createInviteForViewer,
  previewInviteForViewer,
  readInviteOverview,
  revokeInviteForViewer,
  verifiedInviteIdentity,
} from './invite-server';

const NOW = new Date('2026-10-01T09:00:00.000Z');
const viewer = (over: Record<string, unknown> = {}) =>
  ({ tenantSlugs: ['acme'], source: 'token', role: 'localadmin', ...over }) as never;
const oidcViewer = (claims: Record<string, unknown>) =>
  viewer({ role: 'readonly', source: 'token', principal: { source: 'oidc', claims } });

describe('invite-server', () => {
  let root = '';
  let savedPersona: string | undefined;
  let savedRole: string | undefined;
  const opts = () => ({ rootDir: root });

  beforeAll(() => {
    root = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `invite-srv-${randomUUID()}`
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
    if (root) safeRmSync(root, { recursive: true, force: true });
  });
  beforeEach(() => {
    members.byMember = {
      owner: { id: 'user:owner', display_name: 'Owner', role: 'owner' },
      approver: { id: 'user:approver', display_name: 'Appr', role: 'approver' },
      viewer: { id: 'user:viewer', display_name: 'View' },
    };
    resolveMember.mockReset();
    resolveMember.mockReturnValue(null);
  });

  it('only owners and approvers on the tenant see the invite overview, with the roles they may grant', () => {
    expect(readInviteOverview(viewer({ memberId: 'owner' }), opts(), NOW).tenants).toEqual([
      { tenant_slug: 'acme', can_invite_roles: ['approver', 'operator', 'viewer'], invites: [] },
    ]);
    expect(
      readInviteOverview(viewer({ memberId: 'approver' }), opts(), NOW).tenants[0]
    ).toMatchObject({
      can_invite_roles: ['operator', 'viewer'],
    });
    expect(readInviteOverview(viewer({ memberId: 'viewer' }), opts(), NOW).tenants).toEqual([]);
    expect(readInviteOverview(viewer({}), opts(), NOW).tenants).toEqual([]);
  });

  it('create: scope, membership and role limits are enforced server-side', () => {
    const create = (v: unknown, body: Record<string, unknown>) =>
      createInviteForViewer(v as never, body, opts(), NOW);
    expect(
      create(viewer({ memberId: 'owner' }), { tenant_slug: 'other-co', role: 'viewer' })
    ).toMatchObject({ ok: false, status: 403, error: 'tenant_out_of_scope' });
    expect(create(viewer({ memberId: 'owner' }), { role: 'viewer' })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(create(viewer({}), { tenant_slug: 'acme', role: 'viewer' })).toMatchObject({
      ok: false,
      status: 403,
      error: 'member_required',
    });
    expect(
      create(viewer({ memberId: 'owner' }), { tenant_slug: 'acme', role: 'owner' })
    ).toMatchObject({ ok: false, status: 403, error: 'forbidden' });
    expect(
      create(viewer({ memberId: 'approver' }), { tenant_slug: 'acme', role: 'approver' })
    ).toMatchObject({ ok: false, status: 403, error: 'forbidden' });
    const ok = create(viewer({ memberId: 'owner' }), {
      tenant_slug: 'acme',
      role: 'operator',
      ttl_hours: 24,
    });
    expect(ok).toMatchObject({ ok: true, invite: { role: 'operator', status: 'pending' } });
    expect(ok.ok && ok.code.startsWith('acme~inv-')).toBe(true);
  });

  it('an anonymous caller (no verified identity) learns nothing, not even the role', () => {
    const { code } = createInvite(
      {
        tenantSlug: 'acme',
        role: 'viewer',
        inviterMemberId: 'owner',
        inviterRole: 'owner',
        now: NOW,
      },
      opts()
    );
    expect(previewInviteForViewer(viewer({}), code, opts(), NOW)).toMatchObject({
      ok: false,
      status: 401,
      error: 'identity_required',
    });
    expect(acceptInviteForViewer(viewer({}), { code }, opts(), NOW)).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it('the joining identity comes from the verified principal, never from the body', () => {
    expect(verifiedInviteIdentity(viewer({}))).toBeNull();
    resolveMember.mockReturnValueOnce({ member_id: 'alice' });
    expect(verifiedInviteIdentity(viewer({}))).toEqual({ kind: 'member', memberId: 'alice' });
    expect(
      verifiedInviteIdentity(oidcViewer({ iss: 'https://idp', sub: 's1', email: 'a@b.c' }))
    ).toEqual({
      kind: 'external',
      issuer: 'https://idp',
      subject: 's1',
      email: 'a@b.c',
    });
    // An OIDC claim that is not verified-oidc, or lacks iss/sub, is nothing.
    expect(
      verifiedInviteIdentity(
        viewer({ principal: { source: 'token', claims: { iss: 'x', sub: 'y' } } })
      )
    ).toBeNull();
    expect(verifiedInviteIdentity(oidcViewer({ iss: 'https://idp' }))).toBeNull();
  });

  it('a verified external subject joins as a new member and must give a display name', () => {
    const { code } = createInvite(
      {
        tenantSlug: 'acme',
        role: 'viewer',
        inviterMemberId: 'owner',
        inviterRole: 'owner',
        now: NOW,
      },
      opts()
    );
    const v = oidcViewer({ iss: 'https://idp', sub: 'new-1' });
    expect(previewInviteForViewer(v, code, opts(), NOW)).toMatchObject({
      ok: true,
      tenant_slug: 'acme',
      role: 'viewer',
      joining_as: 'new_member',
    });
    expect(acceptInviteForViewer(v, { code }, opts(), NOW)).toMatchObject({
      ok: false,
      status: 400,
      error: 'display_name_required',
    });
    expect(acceptInviteForViewer(v, { code, display_name: 'Newbie' }, opts(), NOW)).toEqual({
      ok: true,
      tenant_slug: 'acme',
      role: 'viewer',
      created_member: true,
    });
    expect(acceptInviteForViewer(v, { code, display_name: 'Newbie' }, opts(), NOW)).toMatchObject({
      ok: false,
      status: 409,
      error: 'used',
    });
  });

  it('maps invite errors to HTTP statuses', () => {
    resolveMember.mockReturnValue({ member_id: 'alice' });
    const a = acceptInviteForViewer(viewer({}), { code: 'garbage' }, opts(), NOW);
    expect(a).toMatchObject({ ok: false, status: 404, error: 'not_found' });
    const { code } = createInvite(
      {
        tenantSlug: 'acme',
        role: 'viewer',
        inviterMemberId: 'owner',
        inviterRole: 'owner',
        ttlHours: 1,
        now: NOW,
      },
      opts()
    );
    const later = new Date(NOW.getTime() + 2 * 3_600_000);
    expect(acceptInviteForViewer(viewer({}), { code }, opts(), later)).toMatchObject({
      ok: false,
      status: 410,
      error: 'expired',
    });
  });

  it('revoke needs membership; the owner can revoke any invite', () => {
    const { invite } = createInvite(
      {
        tenantSlug: 'acme',
        role: 'viewer',
        inviterMemberId: 'approver',
        inviterRole: 'approver',
        now: NOW,
      },
      opts()
    );
    const body = { tenant_slug: 'acme', invite_id: invite.invite_id };
    expect(revokeInviteForViewer(viewer({}), body, opts(), NOW)).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(revokeInviteForViewer(viewer({ memberId: 'viewer' }), body, opts(), NOW)).toMatchObject({
      ok: false,
      status: 403,
      error: 'forbidden',
    });
    expect(revokeInviteForViewer(viewer({ memberId: 'owner' }), body, opts(), NOW)).toMatchObject({
      ok: true,
      invite: { status: 'revoked' },
    });
  });
});
