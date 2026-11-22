/** Authenticated owner adapter, shared by setup and its exact approval cards. */
import { withExecutionContext } from '@agent/core/authority';
import { withSensitivePathMediation } from '@agent/core/secure-io';
import {
  ensureOwnerMember,
  ownerAccountableHumanId,
  resolveMemberByPrincipal,
} from '@agent/core/organization/member-registry';
import {
  ONBOARDING_AUTHORITY_CHANNEL,
  onboardingAuthorityRequestStatus,
  type OnboardingAuthorityPrincipal,
} from '@agent/core/organization/onboarding-authority';
import {
  isPersonalCharterScope,
  type CharterScope,
} from '@agent/core/governance/accountability-charter';
import type { ApprovalRequestRecord } from '@agent/core/governance/approval-store';
import type { ConciergeViewerContext } from './viewer-context';
import { resolveConciergeInstallationAccess } from './installation-access';

export function asOnboardingOwner<T>(body: () => T): T {
  return withExecutionContext('sovereign_concierge', () => withSensitivePathMediation(body));
}
/**
 * The onboarding-authority principal for the viewer. The personal scope is
 * installation scope: it is the installation owner's (installation-access.ts,
 * identity on any transport); a write additionally passes the route's
 * installation write gate. The organization scope stays tenant-owner bound.
 */
export function onboardingAuthorityPrincipal(
  viewer: ConciergeViewerContext,
  scope: CharterScope,
  opts?: { admitRemoteTenantOwner?: boolean }
): OnboardingAuthorityPrincipal {
  const installation = resolveConciergeInstallationAccess(viewer, 'read');
  return asOnboardingOwner(() => {
    if (!viewer.principalId) throw new Error('owner_required');
    if (isPersonalCharterScope(scope) && !installation.allowed) {
      throw new Error(installation.code);
    }
    if (
      !isPersonalCharterScope(scope) &&
      viewer.role !== 'localadmin' &&
      !opts?.admitRemoteTenantOwner
    ) {
      throw new Error('owner_required');
    }
    if (viewer.source === 'loopback') ensureOwnerMember();
    const member = resolveMemberByPrincipal({
      source: viewer.source,
      principalId: viewer.principalId,
      memberId: viewer.memberId,
      registrationLabel: viewer.registrationLabel,
    });
    if (!member || member.status !== 'active') throw new Error('active_owner_member_required');
    const personalOwner = installation.allowed && member.member_id === 'owner';
    if (isPersonalCharterScope(scope) && !personalOwner)
      throw new Error('installation_owner_required');
    if (
      !isPersonalCharterScope(scope) &&
      ((viewer.tenantSlugs !== 'all' && !viewer.tenantSlugs.includes(scope.tenant_slug)) ||
        !member.memberships.some((m) => m.tenant_slug === scope.tenant_slug && m.role === 'owner'))
    )
      throw new Error('tenant_owner_required');
    return {
      requesterId: viewer.principal?.actor.id ?? `user:${member.member_id}`,
      // Material lands in the installation's secret store, so the installation
      // owner member stays accountable even when a tenant owner initiated —
      // whose identity is kept in requesterId. This also keeps the approval
      // bound to the accountable human (decidedBy === accountable_id), so a
      // tenant owner can propose and apply but never self-approve.
      accountableId: !isPersonalCharterScope(scope)
        ? ownerAccountableHumanId()
        : `user:${member.member_id}`,
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
    // A decision is recorded as decidedBy = principal.accountableId, so only a
    // caller whose requester IS the accountable human may decide — otherwise a
    // remote member-bound credential would falsify the audit trail by deciding
    // as the installation owner. Mirrors the account-introduction review gate.
    if (principal.requesterId !== principal.accountableId) return null;
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
