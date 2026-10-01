import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as pathResolver from '../path-resolver.js';
import { safeRmSync } from '../secure-io.js';

vi.mock('../surface/operator-identity.js', () => ({
  resolveOperatorDisplayName: vi.fn((fallback?: string) => `op(${fallback ?? ''})`),
}));

import {
  acceptInvite,
  createInvite,
  InviteError,
  invitableRolesFor,
  listInvites,
  previewInvite,
  readInviteLedger,
  revokeInvite,
} from './member-invite.js';
import { readMemberProfile, writeMemberProfile, type MemberProfile } from './member-registry.js';

const NOW = new Date('2026-10-01T09:00:00.000Z');
const member = (over: Partial<MemberProfile> = {}): MemberProfile => ({
  member_id: 'alice',
  display_name: 'Alice',
  status: 'active',
  memberships: [{ tenant_slug: 'beta', role: 'viewer' }],
  access_registrations: [],
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
  ...over,
});

describe('member invites', () => {
  let root = '';
  let savedPersona: string | undefined;
  let savedRole: string | undefined;
  const opts = () => ({ rootDir: root });
  const owner = { tenantSlug: 'acme', inviterMemberId: 'owner', inviterRole: 'owner' as const };
  const fail = (fn: () => unknown, code: string) => {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(InviteError);
      expect((e as InviteError).code).toBe(code);
      return;
    }
    throw new Error(`expected InviteError(${code})`);
  };

  beforeAll(() => {
    root = path.join(pathResolver.rootDir(), 'active', 'shared', 'tmp', `invite-${randomUUID()}`);
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

  it('who may invite whom: ownership is never delegated by link', () => {
    expect(invitableRolesFor('owner')).toEqual(['approver', 'operator', 'viewer']);
    expect(invitableRolesFor('approver')).toEqual(['operator', 'viewer']);
    expect(invitableRolesFor('operator')).toEqual([]);
    expect(invitableRolesFor(null)).toEqual([]);
    fail(() => createInvite({ ...owner, role: 'owner' }, opts()), 'forbidden');
    fail(
      () => createInvite({ ...owner, inviterRole: 'approver', role: 'approver' }, opts()),
      'forbidden'
    );
    fail(
      () => createInvite({ ...owner, inviterRole: 'viewer', role: 'viewer' }, opts()),
      'forbidden'
    );
    fail(() => createInvite({ ...owner, role: 'viewer', ttlHours: 24 * 31 }, opts()), 'invalid');
  });

  it('stores only a hash of the secret and never shows it in listings', () => {
    const { invite, code } = createInvite({ ...owner, role: 'operator', now: NOW }, opts());
    expect(code.startsWith(`acme~${invite.invite_id}~`)).toBe(true);
    const listed = listInvites('acme', opts(), NOW);
    expect(JSON.stringify(listed)).not.toContain(code.split('~')[2]);
    expect(listed.some((i) => i.invite_id === invite.invite_id && i.status === 'pending')).toBe(
      true
    );
    expect(previewInvite(code, opts(), NOW)).toMatchObject({
      tenant_slug: 'acme',
      role: 'operator',
    });
  });

  it('a wrong secret and an unknown invite look identical (a guess learns nothing)', () => {
    const { code } = createInvite({ ...owner, role: 'viewer', now: NOW }, opts());
    const [tenant, id] = code.split('~');
    fail(() => previewInvite(`${tenant}~${id}~${'x'.repeat(43)}`, opts(), NOW), 'not_found');
    fail(
      () => previewInvite(`${tenant}~inv-0000000000000000~${'x'.repeat(43)}`, opts(), NOW),
      'not_found'
    );
    fail(() => previewInvite('garbage', opts(), NOW), 'not_found');
    fail(() => previewInvite(undefined, opts(), NOW), 'not_found');
  });

  it('expires', () => {
    const { code } = createInvite({ ...owner, role: 'viewer', ttlHours: 1, now: NOW }, opts());
    fail(() => previewInvite(code, opts(), new Date(NOW.getTime() + 2 * 3_600_000)), 'expired');
  });

  it('an existing member joins: gets exactly the invited role, once', () => {
    writeMemberProfile(member(), opts());
    const { code } = createInvite({ ...owner, role: 'approver', now: NOW }, opts());
    const joined = acceptInvite(
      { code, identity: { kind: 'member', memberId: 'alice' }, now: NOW },
      opts()
    );
    expect(joined).toMatchObject({
      member_id: 'alice',
      tenant_slug: 'acme',
      role: 'approver',
      created_member: false,
    });
    expect(readMemberProfile('alice', opts())?.memberships).toEqual([
      { tenant_slug: 'beta', role: 'viewer' },
      { tenant_slug: 'acme', role: 'approver' },
    ]);
    fail(
      () =>
        acceptInvite({ code, identity: { kind: 'member', memberId: 'alice' }, now: NOW }, opts()),
      'used'
    );
  });

  it('refuses a suspended or unknown member, and a member already in the organization', () => {
    writeMemberProfile(member({ member_id: 'sam', status: 'suspended', memberships: [] }), opts());
    const { code } = createInvite({ ...owner, role: 'viewer', now: NOW }, opts());
    fail(
      () => acceptInvite({ code, identity: { kind: 'member', memberId: 'sam' }, now: NOW }, opts()),
      'member_unavailable'
    );
    fail(
      () =>
        acceptInvite({ code, identity: { kind: 'member', memberId: 'nobody' }, now: NOW }, opts()),
      'member_unavailable'
    );
    // Alice is already in acme (previous test).
    fail(
      () =>
        acceptInvite({ code, identity: { kind: 'member', memberId: 'alice' }, now: NOW }, opts()),
      'already_member'
    );
    // The failed attempts did not burn the invite.
    expect(previewInvite(code, opts(), NOW).status).toBe('pending');
  });

  it('a verified external identity becomes a new member bound to that identity', () => {
    const { code } = createInvite({ ...owner, role: 'viewer', now: NOW }, opts());
    const joined = acceptInvite(
      {
        code,
        identity: {
          kind: 'external',
          issuer: 'https://idp.example',
          subject: 'sub-9',
          displayName: ' Bo ',
          email: 'bo@example.com',
        },
        now: NOW,
      },
      opts()
    );
    expect(joined.created_member).toBe(true);
    expect(joined.member_id).toMatch(/^u-[a-f0-9]{10}$/);
    expect(readMemberProfile(joined.member_id, opts())).toMatchObject({
      display_name: 'Bo',
      memberships: [{ tenant_slug: 'acme', role: 'viewer' }],
      external_identities: [{ issuer: 'https://idp.example', subject: 'sub-9' }],
    });
    // The same identity cannot be turned into a second member.
    const again = createInvite({ ...owner, role: 'viewer', now: NOW }, opts());
    fail(
      () =>
        acceptInvite(
          {
            code: again.code,
            identity: {
              kind: 'external',
              issuer: 'https://idp.example',
              subject: 'sub-9',
              displayName: 'Bo',
            },
            now: NOW,
          },
          opts()
        ),
      'already_member'
    );
    expect(previewInvite(again.code, opts(), NOW).status).toBe('pending');
  });

  it('revoke: owner, or the inviter; a revoked invite cannot be used', () => {
    const { invite, code } = createInvite({ ...owner, role: 'viewer', now: NOW }, opts());
    fail(
      () =>
        revokeInvite(
          {
            tenantSlug: 'acme',
            inviteId: invite.invite_id,
            byMemberId: 'stranger',
            byRole: 'viewer',
          },
          opts()
        ),
      'forbidden'
    );
    expect(
      revokeInvite(
        { tenantSlug: 'acme', inviteId: invite.invite_id, byMemberId: 'owner', byRole: 'owner' },
        opts()
      )
    ).toMatchObject({ status: 'revoked' });
    fail(() => previewInvite(code, opts(), NOW), 'revoked');
  });

  it('every state change is in the tenant ledger', () => {
    const events = readInviteLedger('acme', opts()).map((e) => e.event);
    expect(events).toEqual(expect.arrayContaining(['created', 'accepted', 'revoked']));
  });
});
