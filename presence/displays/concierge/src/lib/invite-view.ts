/**
 * Pure helpers behind the invite pane and the /join page. No I/O and no `t()`.
 * The server is the only authority; this shapes the link and maps error codes.
 */

export type InviteRole = 'approver' | 'operator' | 'viewer';
export type InviteErrorKind =
  | 'not_found'
  | 'expired'
  | 'used'
  | 'revoked'
  | 'already_member'
  | 'forbidden'
  | 'sign_in'
  | 'generic';

/** The link to hand over. The code is the whole secret: keep it out of logs and referrers. */
export function inviteJoinPath(code: string): string {
  return `/join?code=${encodeURIComponent(code)}`;
}

/** The code in a /join URL's query string (a pasted full URL or the bare code both work). */
export function codeFromSearch(search: string): string {
  const raw = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get('code');
  return (raw ?? '').trim();
}

export function inviteErrorKind(code: string, status?: number): InviteErrorKind {
  if (code === 'identity_required' || status === 401) return 'sign_in';
  if (code === 'not_found') return 'not_found';
  if (code === 'expired') return 'expired';
  if (code === 'used') return 'used';
  if (code === 'revoked') return 'revoked';
  if (code === 'already_member') return 'already_member';
  if (code === 'forbidden' || code === 'member_unavailable') return 'forbidden';
  return 'generic';
}

export type InviteDisplayStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

/** An invite past its expiry reads as expired even while its stored status is still pending. */
export function inviteDisplayStatus(invite: {
  status: 'pending' | 'accepted' | 'revoked';
  expired: boolean;
}): InviteDisplayStatus {
  return invite.status === 'pending' && invite.expired ? 'expired' : invite.status;
}

export interface InviteOverviewTenant {
  tenant_slug: string;
  can_invite_roles: InviteRole[];
  invites: Array<{
    invite_id: string;
    role: InviteRole;
    status: 'pending' | 'accepted' | 'revoked';
    expired: boolean;
    expires_at: string;
  }>;
}

export function parseInviteOverview(value: unknown): InviteOverviewTenant[] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (v.ok !== true || !Array.isArray(v.tenants)) return undefined;
  for (const t of v.tenants) {
    const e = t as Record<string, unknown> | null;
    if (
      !e ||
      typeof e.tenant_slug !== 'string' ||
      !Array.isArray(e.can_invite_roles) ||
      !Array.isArray(e.invites)
    ) {
      return undefined;
    }
  }
  return v.tenants as InviteOverviewTenant[];
}
