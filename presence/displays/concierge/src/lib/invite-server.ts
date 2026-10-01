/**
 * Server-side logic behind invitations (settings › members, and /join).
 *
 *  - Creating / listing / revoking needs an OWNER or APPROVER membership on the
 *    tenant; the roles a member may invite are fixed by `invitableRolesFor`
 *    (nobody invites an owner). The inviter is the authn-resolved member.
 *  - Joining never trusts the request: the identity that joins is the one the
 *    server verified (a bound member, a token-registered member, or a verified
 *    OIDC subject). A client can supply only the code and a display name.
 *  - One answer for "no such invite" and "wrong secret" (see member-invite.ts).
 */

import { withExecutionContext } from '@agent/core/authority';
import {
  InviteError,
  acceptInvite,
  createInvite,
  invitableRolesFor,
  listInvites,
  previewInvite,
  revokeInvite,
  type InviteIdentity,
  type InvitePathOptions,
  type InvitableRole,
  type PublicInvite,
} from '@agent/core/organization/member-invite';
import { resolveMemberByPrincipal } from '@agent/core/organization/member-registry';
import { resolveConciergeDecidedBy } from './front-desk-member';
import { charterTenants } from './charter-server';
import type { ConciergeViewerContext } from './viewer-context';

type Viewer = Pick<
  ConciergeViewerContext,
  'principalId' | 'source' | 'registrationLabel' | 'tenantSlugs' | 'memberId' | 'role' | 'principal'
>;

export type InviteFailure = {
  ok: false;
  status: 400 | 401 | 403 | 404 | 409 | 410;
  error: string;
};
export type InviteResult<T> = ({ ok: true } & T) | InviteFailure;

const STATUS: Record<InviteError['code'], InviteFailure['status']> = {
  forbidden: 403,
  invalid: 400,
  not_found: 404,
  expired: 410,
  used: 409,
  revoked: 410,
  already_member: 409,
  member_unavailable: 403,
};

function failure(status: InviteFailure['status'], error: string): InviteFailure {
  return { ok: false, status, error };
}

function fromError(error: unknown): InviteFailure {
  if (error instanceof InviteError) return failure(STATUS[error.code], error.code);
  const message = error instanceof Error ? error.message : String(error);
  return failure(400, `rejected: ${message.slice(0, 200)}`);
}

/** The viewer as an inviter on one tenant: their member id and role there. */
function inviterOn(viewer: Viewer, tenant: string) {
  const who = resolveConciergeDecidedBy(viewer, tenant);
  if (!who) return null;
  return { memberId: who.id.replace(/^user:/, ''), role: who.role ?? null };
}

export interface InviteTenantEntry {
  tenant_slug: string;
  can_invite_roles: InvitableRole[];
  invites: PublicInvite[];
}

/** Tenants the viewer may invite into (owner / approver), with their invites. */
export function readInviteOverview(
  viewer: Viewer,
  options: InvitePathOptions = {},
  now: Date = new Date()
): { tenants: InviteTenantEntry[] } {
  const tenants: InviteTenantEntry[] = [];
  for (const tenant of charterTenants(viewer)) {
    const inviter = inviterOn(viewer, tenant);
    const roles = invitableRolesFor(inviter?.role);
    if (roles.length === 0) continue;
    tenants.push({
      tenant_slug: tenant,
      can_invite_roles: roles,
      invites: listInvites(tenant, options, now),
    });
  }
  return { tenants };
}

export function createInviteForViewer(
  viewer: Viewer,
  body: { tenant_slug?: unknown; role?: unknown; ttl_hours?: unknown },
  options: InvitePathOptions = {},
  now: Date = new Date()
): InviteResult<{ invite: PublicInvite; code: string }> {
  const tenant = typeof body.tenant_slug === 'string' ? body.tenant_slug : '';
  if (!tenant) return failure(400, 'tenant_required');
  if (!charterTenants(viewer).includes(tenant)) return failure(403, 'tenant_out_of_scope');
  const inviter = inviterOn(viewer, tenant);
  if (!inviter) return failure(403, 'member_required');
  const ttl = body.ttl_hours === undefined ? undefined : Number(body.ttl_hours);
  try {
    const created = createInvite(
      {
        tenantSlug: tenant,
        role: String(body.role ?? ''),
        inviterMemberId: inviter.memberId,
        inviterRole: inviter.role,
        ...(ttl !== undefined ? { ttlHours: ttl } : {}),
        now,
      },
      options
    );
    return { ok: true, ...created };
  } catch (error) {
    return fromError(error);
  }
}

export function revokeInviteForViewer(
  viewer: Viewer,
  body: { tenant_slug?: unknown; invite_id?: unknown },
  options: InvitePathOptions = {},
  now: Date = new Date()
): InviteResult<{ invite: PublicInvite }> {
  const tenant = typeof body.tenant_slug === 'string' ? body.tenant_slug : '';
  if (!tenant || typeof body.invite_id !== 'string') return failure(400, 'invalid_request');
  if (!charterTenants(viewer).includes(tenant)) return failure(403, 'tenant_out_of_scope');
  const inviter = inviterOn(viewer, tenant);
  if (!inviter) return failure(403, 'member_required');
  try {
    const invite = revokeInvite(
      {
        tenantSlug: tenant,
        inviteId: body.invite_id,
        byMemberId: inviter.memberId,
        byRole: inviter.role,
        now,
      },
      options
    );
    return { ok: true, invite };
  } catch (error) {
    return fromError(error);
  }
}

/**
 * The identity this request proves, or null. Never read from the body.
 *  1. an authn-verified member binding (`viewer.memberId`), or a token/registration that
 *     resolves to a member;
 *  2. a verified OIDC subject (`iss` + `sub` from the verified token) that is not a member yet.
 */
export function verifiedInviteIdentity(
  viewer: Viewer
):
  | { kind: 'member'; memberId: string }
  | { kind: 'external'; issuer: string; subject: string; email?: string }
  | null {
  const member = withExecutionContext('sovereign_concierge', () => {
    try {
      return resolveMemberByPrincipal({
        principalId: viewer.principalId,
        source: viewer.source,
        registrationLabel: viewer.registrationLabel,
        memberId: viewer.memberId,
      });
    } catch {
      return null;
    }
  });
  if (member) return { kind: 'member', memberId: member.member_id };
  const principal = viewer.principal;
  const claims = principal?.claims;
  if (principal?.source === 'oidc' && claims) {
    const issuer = typeof claims.iss === 'string' ? claims.iss.trim() : '';
    const subject = typeof claims.sub === 'string' ? claims.sub.trim() : '';
    const email = typeof claims.email === 'string' ? claims.email.trim() : '';
    if (issuer && subject) {
      return { kind: 'external', issuer, subject, ...(email ? { email } : {}) };
    }
  }
  return null;
}

export function previewInviteForViewer(
  viewer: Viewer,
  code: unknown,
  options: InvitePathOptions = {},
  now: Date = new Date()
): InviteResult<{
  tenant_slug: string;
  role: InvitableRole;
  expires_at: string;
  joining_as: 'member' | 'new_member' | null;
}> {
  const identity = verifiedInviteIdentity(viewer);
  // Even a preview needs a verified identity: a leaked code reveals nothing to an anonymous caller.
  if (!identity) return failure(401, 'identity_required');
  try {
    const invite = previewInvite(code, options, now);
    return {
      ok: true,
      tenant_slug: invite.tenant_slug,
      role: invite.role,
      expires_at: invite.expires_at,
      joining_as: identity.kind === 'member' ? 'member' : 'new_member',
    };
  } catch (error) {
    return fromError(error);
  }
}

export function acceptInviteForViewer(
  viewer: Viewer,
  body: { code?: unknown; display_name?: unknown },
  options: InvitePathOptions = {},
  now: Date = new Date()
): InviteResult<{ tenant_slug: string; role: InvitableRole; created_member: boolean }> {
  const verified = verifiedInviteIdentity(viewer);
  if (!verified) return failure(401, 'identity_required');
  let identity: InviteIdentity;
  if (verified.kind === 'member') {
    identity = verified;
  } else {
    const displayName = typeof body.display_name === 'string' ? body.display_name.trim() : '';
    if (!displayName) return failure(400, 'display_name_required');
    identity = { ...verified, displayName };
  }
  try {
    const joined = withExecutionContext('sovereign_concierge', () =>
      acceptInvite({ code: body.code, identity, now }, options)
    );
    return {
      ok: true,
      tenant_slug: joined.tenant_slug,
      role: joined.role,
      created_member: joined.created_member,
    };
  } catch (error) {
    return fromError(error);
  }
}
