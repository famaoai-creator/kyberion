/** Server-resolved member identity; request fields never supply the acting member. */
import { withExecutionContext } from '@agent/core/authority';
import { resolveMemberByPrincipal } from '@agent/core/organization/member-registry';
import type { MemberManagementPrincipal } from '@agent/core/organization/member-management';
import { SurfaceManagementError } from '@agent/core/surface/surface-management-mutations';
import type { ConciergeViewerContext } from './viewer-context';
import { createHash } from 'node:crypto';

export function memberManagementPrincipal(
  viewer: ConciergeViewerContext
): MemberManagementPrincipal {
  if (viewer.source === 'anonymous')
    throw new SurfaceManagementError('forbidden', 403, 'Sign in as a registered owner.');
  const member = withExecutionContext('sovereign_concierge', () =>
    resolveMemberByPrincipal({
      principalId: viewer.principalId,
      source: viewer.source,
      registrationLabel: viewer.registrationLabel,
      memberId: viewer.memberId,
    })
  );
  if (!member || member.status !== 'active')
    throw new SurfaceManagementError('forbidden', 403, 'An active registered member is required.');
  const principal = viewer.principal;
  if (
    principal &&
    (principal.actor.kind !== 'human' ||
      principal.actor.id !== 'user:' + member.member_id ||
      (principal.memberId && principal.memberId !== member.member_id))
  )
    throw new SurfaceManagementError(
      'forbidden',
      403,
      'The authenticated member binding changed. Sign in again.'
    );
  const left = viewer.tenantSlugs;
  const right = principal?.tenantSlugs ?? left;
  const allowedTenantSlugs =
    left === 'all'
      ? right
      : right === 'all'
        ? left
        : left.filter((tenant) => right.includes(tenant));
  return {
    memberId: member.member_id,
    allowedTenantSlugs,
    ...(principal?.expiresAt ? { expiresAt: principal.expiresAt } : {}),
  };
}

/** Stable identity/grant fence; excludes credentials and the selected tenant narrowing. */
export function memberManagementContextId(
  viewer: ConciergeViewerContext,
  principal = memberManagementPrincipal(viewer)
): string {
  const grants = (value: readonly string[] | 'all') =>
    value === 'all' ? value : [...value].sort();
  return createHash('sha256')
    .update(
      JSON.stringify({
        memberId: principal.memberId,
        allowedTenantSlugs: grants(principal.allowedTenantSlugs),
        source: viewer.source,
        viewer: {
          principalId: viewer.principalId ?? null,
          role: viewer.role,
          tenantSlugs: grants(viewer.tenantSlugs),
          organizationIds: grants(viewer.organizationIds),
          projectIds: grants(viewer.projectIds),
          tierAccess: [...viewer.tierAccess].sort(),
        },
        principal: viewer.principal
          ? {
              actor: viewer.principal.actor.id,
              source: viewer.principal.source,
              role: viewer.principal.role,
              tenantSlugs: grants(viewer.principal.tenantSlugs),
              organizationIds: grants(viewer.principal.organizationIds),
              projectIds: grants(viewer.principal.projectIds),
              tierAccess: [...viewer.principal.tierAccess].sort(),
            }
          : null,
      })
    )
    .digest('hex');
}

export function assertMemberManagementContext(
  viewer: ConciergeViewerContext,
  expected: unknown,
  principal = memberManagementPrincipal(viewer)
): void {
  if (expected === undefined) return;
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected))
    throw new SurfaceManagementError(
      'invalid_context',
      400,
      'Refresh the member list before saving.'
    );
  if (expected !== memberManagementContextId(viewer, principal))
    throw new SurfaceManagementError(
      'context_changed',
      403,
      'Your identity or access changed. Refresh and review the change again.'
    );
}
