import { withExecutionContext } from '@agent/core/authority';
import { resolveMemberByPrincipal, type MemberProfile } from '@agent/core/member-registry';
import type { ConciergeViewerContext } from './viewer-context';

export type ConciergeDecidedByRole = 'owner' | 'approver' | 'viewer';

export interface ConciergeDecidedBy {
  /** `user:<member_id>` (plan §2.5 principle 1) — never a bare id. */
  id: string;
  display_name: string;
  role?: ConciergeDecidedByRole;
}

/**
 * FD-07 (plan §2.3 "誰が決めたか" / §2.5 principle 4 "判断は actor.kind = human
 * のみ"): resolve the human member behind a Concierge viewer for the
 * `decided_by` seams on approval / deliverable-verdict routes.
 *
 * Returns null for an unregistered principal (no member record yet) — every
 * call site must keep its pre-FD-07 fallback behavior in that case, exactly
 * like `readFrontDeskMe` does for `/api/me`.
 */
export function resolveConciergeDecidedBy(
  viewer: Pick<
    ConciergeViewerContext,
    'principalId' | 'source' | 'registrationLabel' | 'tenantSlugs'
  >
): ConciergeDecidedBy | null {
  let profile: MemberProfile | null = null;
  try {
    profile = withExecutionContext('sovereign_concierge', () =>
      resolveMemberByPrincipal({
        principalId: viewer.principalId,
        source: viewer.source,
        registrationLabel: viewer.registrationLabel,
      })
    );
  } catch {
    // A corrupt/unreadable member profile must never block a human decision
    // — the caller falls back to its pre-FD-07 decidedBy value.
    profile = null;
  }
  if (!profile) return null;

  const tenant = viewer.tenantSlugs !== 'all' ? viewer.tenantSlugs[0] : undefined;
  const membership =
    (tenant && profile.memberships.find((entry) => entry.tenant_slug === tenant)) ||
    profile.memberships[0];

  return {
    id: `user:${profile.member_id}`,
    display_name: profile.display_name,
    role: membership?.role,
  };
}

/**
 * The front-desk human role gating write access to member-management routes
 * (`/api/members`): a resolved member's own membership role wins; an
 * unregistered principal falls back to the pre-FD-07 localadmin -> owner /
 * readonly -> viewer mapping (same as `frontDeskRoleFromViewer`).
 */
export function resolveConciergeFrontDeskRole(
  viewer: Pick<
    ConciergeViewerContext,
    'principalId' | 'source' | 'registrationLabel' | 'tenantSlugs' | 'role'
  >
): ConciergeDecidedByRole {
  const decidedBy = resolveConciergeDecidedBy(viewer);
  if (decidedBy?.role) return decidedBy.role;
  return viewer.role === 'localadmin' ? 'owner' : 'viewer';
}
