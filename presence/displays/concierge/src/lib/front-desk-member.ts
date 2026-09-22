import { NextResponse } from 'next/server';
import { withExecutionContext } from '@agent/core/authority';
import type { FrontDeskRole } from '@agent/core/front-desk-identity';
import {
  memberBindingDenied,
  resolveMemberByPrincipal,
  type MemberMembership,
  type MemberProfile,
} from '@agent/core/member-registry';
import type { ConciergeViewerContext } from './viewer-context';

export type ConciergeDecidedByRole = 'owner' | 'approver' | 'viewer';

export interface ConciergeDecidedBy {
  /** `user:<member_id>` (plan §2.5 principle 1) — never a bare id. */
  id: string;
  display_name: string;
  role?: ConciergeDecidedByRole;
}

type ConciergeViewerSlice = Pick<
  ConciergeViewerContext,
  'principalId' | 'source' | 'registrationLabel' | 'tenantSlugs' | 'memberId' | 'role'
>;

/**
 * `'member_denied'`: the viewer carries an authn-verified member binding
 * (`viewer.memberId` from a verified JWT claim or token registration) that
 * failed to resolve — the member is suspended, removed, or the profile is
 * unreadable. A bound member must never degrade into the "unregistered"
 * fallback: that path grants the credential's flat role, which for a
 * suspended localadmin-class member would be an *upgrade* to owner.
 * `null` means genuinely unregistered (no member binding was asserted) —
 * callers keep their pre-FD-07 fallback behavior.
 */
type ConciergeMembershipResolution =
  { profile: MemberProfile; membership?: MemberMembership } | 'member_denied' | null;

/**
 * FD-07 (plan §2.3 "誰が決めたか" / §2.5 principle 4 "判断は actor.kind = human
 * のみ"): resolve the human member behind a Concierge viewer for the
 * `decided_by` seams on approval / deliverable-verdict routes.
 */
function resolveConciergeMembership(viewer: ConciergeViewerSlice): ConciergeMembershipResolution {
  const input = {
    principalId: viewer.principalId,
    source: viewer.source,
    registrationLabel: viewer.registrationLabel,
    memberId: viewer.memberId,
  };
  let profile: MemberProfile | null = null;
  let bindingDenied = false;
  try {
    profile = withExecutionContext('sovereign_concierge', () => resolveMemberByPrincipal(input));
    // A bound member that did not resolve — suspended/missing memberId, or
    // a registration label matching a suspended member's
    // access_registrations — is a hard deny, never the unregistered
    // fallback (that path would *upgrade* a suspended localadmin-class
    // credential to owner).
    bindingDenied =
      !profile && withExecutionContext('sovereign_concierge', () => memberBindingDenied(input));
  } catch {
    // A corrupt/unreadable member registry must never block a decision for
    // an unregistered principal — but an asserted member binding (memberId
    // OR a registration label that could be bound to a member's
    // access_registrations) still fails closed: the binding cannot be
    // disproven while the registry is unreadable.
    profile = null;
    bindingDenied = Boolean(viewer.memberId || viewer.registrationLabel);
  }
  if (!profile) return bindingDenied ? 'member_denied' : null;

  // Only the viewing tenant's own membership decides the role — an
  // 'all'-scope viewer has no single viewed tenant, so no membership is
  // selected (an arbitrary first entry would attribute the wrong
  // authority).
  const tenant = viewer.tenantSlugs !== 'all' ? viewer.tenantSlugs[0] : undefined;
  const membership = tenant
    ? profile.memberships.find((entry) => entry.tenant_slug === tenant)
    : undefined;
  return { profile, membership };
}

export function resolveConciergeDecidedBy(
  viewer: ConciergeViewerSlice,
  resourceTenant?: string
): ConciergeDecidedBy | null {
  const resolved = resolveConciergeMembership(viewer);
  if (resolved === 'member_denied' || !resolved) return null;
  const { profile } = resolved;
  // The recorded role is the membership on the tenant the decision lands
  // on — a role held elsewhere is never attributed to this decision.
  const membership = resourceTenant
    ? profile.memberships.find((entry) => entry.tenant_slug === resourceTenant)
    : resolved.membership;
  // Only decision-capable membership roles are written into a decided_by
  // record (`surface.decision.write` belongs to owner and approver —
  // front-desk-roles.ts). Operator and viewer memberships never become a
  // recorded decision role.
  const role =
    membership?.role === 'owner' || membership?.role === 'approver' ? membership.role : undefined;
  return {
    id: `user:${profile.member_id}`,
    display_name: profile.display_name,
    role,
  };
}

function isDecisionCapableRole(role: FrontDeskRole | undefined): boolean {
  return role === 'owner' || role === 'approver';
}

const DECISION_DENIED_ERROR = 'member role does not grant decision authority';

/**
 * Positive decision gate for concierge decide-effect routes (approvals,
 * outcomes, memory-queue, hygiene, secrets, plugins): once a member is
 * resolved, decision authority is positively allowed only through owner or
 * approver membership roles.
 *
 * `resourceTenant` binds the check to the tenant the decision actually
 * lands on (approval's tenant, queue candidate's scope, mission tenant…).
 * When it is absent — or the decision is not tenant-bound (secrets,
 * plugins) — every tenant in the viewer's scope must carry a
 * decision-capable membership, so a viewer/operator membership anywhere in
 * scope cannot be laundered through a multi-tenant token.
 *
 * `member_denied` (asserted member binding that failed to resolve) and an
 * operator/viewer/missing membership on the checked tenants deny; only an
 * unregistered principal keeps the pre-FD-07 fallback path.
 */
export function conciergeDecisionDenied(
  viewer: ConciergeViewerSlice,
  resourceTenant?: string
): NextResponse | null {
  const resolved = resolveConciergeMembership(viewer);
  if (resolved === 'member_denied') {
    return NextResponse.json(
      { ok: false, error: 'member binding could not be verified' },
      { status: 403 }
    );
  }
  if (!resolved) return null;
  const { profile } = resolved;
  // The resource tenant must lie inside the viewer's authorized scope — a
  // membership on an out-of-scope tenant never grants the decision.
  if (
    resourceTenant &&
    viewer.tenantSlugs !== 'all' &&
    !viewer.tenantSlugs.includes(resourceTenant)
  ) {
    return NextResponse.json({ ok: false, error: DECISION_DENIED_ERROR }, { status: 403 });
  }
  const scopeTenants =
    viewer.tenantSlugs === 'all'
      ? profile.memberships.map((membership) => membership.tenant_slug)
      : viewer.tenantSlugs;
  const tenantsToCheck = resourceTenant ? [resourceTenant] : scopeTenants;
  // An empty check set (a member with no in-scope tenants deciding a
  // non-tenant-bound effect) is denied, same as the chronos /
  // presence-studio implementations.
  const denied =
    tenantsToCheck.length === 0 ||
    tenantsToCheck.some((tenant) => {
      const membership = profile.memberships.find((entry) => entry.tenant_slug === tenant);
      return !isDecisionCapableRole(membership?.role);
    });
  if (!denied) return null;
  return NextResponse.json({ ok: false, error: DECISION_DENIED_ERROR }, { status: 403 });
}

/**
 * The member's role for one specific tenant — the authority check for
 * tenant-bound operations (member management writes, training assignment).
 * A resolved member without a membership on that tenant is a `viewer`; a
 * member binding that failed to resolve is `viewer` too — never the
 * localadmin -> owner fallback, which only applies to an unregistered
 * principal (same as `frontDeskRoleFromViewer`).
 */
export function conciergeFrontDeskRoleForTenant(
  viewer: ConciergeViewerSlice,
  tenantSlug: string
): FrontDeskRole {
  // A tenant outside the viewer's authorized scope grants no role at all —
  // the client tenant parameter may narrow, never widen.
  if (viewer.tenantSlugs !== 'all' && !viewer.tenantSlugs.includes(tenantSlug)) {
    return 'viewer';
  }
  const resolved = resolveConciergeMembership(viewer);
  if (resolved === 'member_denied') return 'viewer';
  if (resolved) {
    return (
      resolved.profile.memberships.find((entry) => entry.tenant_slug === tenantSlug)?.role ??
      'viewer'
    );
  }
  // Unregistered principal (no member binding asserted): legacy fallback.
  return viewer.role === 'localadmin' ? 'owner' : 'viewer';
}

/**
 * The front-desk human role for the *viewed* tenant (nav / owner-only read
 * gates on single-tenant scopes): a resolved member's own membership role
 * for that tenant wins; a member holding no membership there is a `viewer`.
 * Only an unregistered principal falls back to the pre-FD-07
 * localadmin -> owner / readonly -> viewer mapping (same as
 * `frontDeskRoleFromViewer`).
 */
export function resolveConciergeFrontDeskRole(viewer: ConciergeViewerSlice): FrontDeskRole {
  const resolved = resolveConciergeMembership(viewer);
  if (resolved === 'member_denied') return 'viewer';
  if (resolved) return resolved.membership?.role ?? 'viewer';
  return viewer.role === 'localadmin' ? 'owner' : 'viewer';
}
