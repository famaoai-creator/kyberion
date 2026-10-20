/** Authenticated owner adapter, shared by setup and its exact approval cards. */
import { withExecutionContext } from '@agent/core/authority';
import { withSensitivePathMediation } from '@agent/core/secure-io';
import {
  ensureOwnerMember,
  resolveMemberByPrincipal,
} from '@agent/core/organization/member-registry';
import {
  ONBOARDING_AUTHORITY_CHANNEL,
  onboardingAuthorityRequestStatus,
  type OnboardingAuthorityPrincipal,
} from '@agent/core/organization/onboarding-authority';
import type { CharterScope } from '@agent/core/governance/accountability-charter';
import type { ApprovalRequestRecord } from '@agent/core/governance/approval-store';
import type { ConciergeViewerContext } from './viewer-context';

export function asOnboardingOwner<T>(body: () => T): T {
  return withExecutionContext('sovereign_concierge', () => withSensitivePathMediation(body));
}
export function onboardingAuthorityPrincipal(
  viewer: ConciergeViewerContext,
  scope: CharterScope
): OnboardingAuthorityPrincipal {
  return asOnboardingOwner(() => {
    if (!viewer.principalId || viewer.role !== 'localadmin') throw new Error('owner_required');
    if (viewer.source === 'loopback') ensureOwnerMember();
    const member = resolveMemberByPrincipal({
      source: viewer.source,
      principalId: viewer.principalId,
      memberId: viewer.memberId,
      registrationLabel: viewer.registrationLabel,
    });
    if (!member || member.status !== 'active') throw new Error('active_owner_member_required');
    const personalOwner =
      member.member_id === 'owner' &&
      (viewer.source === 'loopback' ||
        (viewer.principal?.actor.kind === 'human' &&
          ['browser-session', 'oidc-jwt', 'registry-token'].includes(viewer.principal.provider)));
    if (scope.kind === 'person' && !personalOwner) throw new Error('personal_owner_required');
    if (
      scope.kind === 'organization' &&
      ((viewer.tenantSlugs !== 'all' && !viewer.tenantSlugs.includes(scope.tenant_slug)) ||
        !member.memberships.some((m) => m.tenant_slug === scope.tenant_slug && m.role === 'owner'))
    )
      throw new Error('tenant_owner_required');
    return {
      requesterId: viewer.principal?.actor.id ?? `user:${member.member_id}`,
      accountableId: `user:${member.member_id}`,
      personalOwner,
      tenantSlugs: viewer.tenantSlugs,
    };
  });
}
/** Undefined means another approval family; null is a hard deny for this family. */
export function onboardingApprovalMember(
  viewer: ConciergeViewerContext,
  record: ApprovalRequestRecord
) {
  if (record.channel !== ONBOARDING_AUTHORITY_CHANNEL) return undefined;
  try {
    const scope: CharterScope = record.scope?.tenant_slug
      ? { kind: 'organization', tenant_slug: record.scope.tenant_slug }
      : { kind: 'person' };
    const principal = onboardingAuthorityPrincipal(viewer, scope);
    const status = asOnboardingOwner(() =>
      onboardingAuthorityRequestStatus(principal, scope, record.id)
    );
    if (!status.ok) return null;
    const memberId = principal.accountableId.slice(5);
    return {
      memberId,
      decidedBy: principal.accountableId,
      id: principal.accountableId,
      displayName: principal.accountableId,
      role: 'owner' as const,
    };
  } catch {
    return null;
  }
}
