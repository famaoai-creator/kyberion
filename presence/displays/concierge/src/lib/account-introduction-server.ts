/** Account ownership comes from the stored connection and authenticated viewer. */
import { loadServiceBindingRecord } from '@agent/core/service/service-binding-registry';
import {
  ACCOUNT_INTRODUCTION_CHANNEL,
  accountIntroductionApprovalBindingId,
  reviewAccountIntroductionApproval,
} from '@agent/core/secret/account-introduction';
import type { ApprovalRequestRecord } from '@agent/core/governance/approval-store';
import { asOnboardingOwner, onboardingAuthorityPrincipal } from './onboarding-authority-server';
import type { ConciergeViewerContext } from './viewer-context';

export function accountIntroductionAccess(
  viewer: ConciergeViewerContext,
  bindingId: string,
  opts?: { admitRemoteTenantOwner?: boolean }
) {
  return asOnboardingOwner(() => {
    const binding = loadServiceBindingRecord(bindingId);
    if (!binding) throw new Error('account_registration_denied');
    const scope =
      binding.owner_kind === 'organization' && binding.tenant_slug
        ? { kind: 'organization' as const, tenant_slug: binding.tenant_slug }
        : { kind: 'person' as const };
    // Tenant-originated introduction: an organization binding is tenant-owner
    // bound, so a member with role=owner in that tenant may act from a remote
    // session too — the membership check below stays the authorization, the
    // surface role is not what decides here. The opt-in is only given on the
    // request/apply path; the approval-decision path keeps the surface role.
    const principal = onboardingAuthorityPrincipal(viewer, scope, opts);
    if (binding.owner_kind === 'person' && binding.owner_ref !== principal.accountableId)
      throw new Error('account_registration_denied');
    if (!['person', 'organization'].includes(binding.owner_kind ?? ''))
      throw new Error('account_registration_denied');
    return { principal, scope };
  });
}

/** Undefined is another family; null is a hard refusal for this family. */
export function accountIntroductionApprovalMember(
  viewer: ConciergeViewerContext,
  record: ApprovalRequestRecord
) {
  if (record.channel !== ACCOUNT_INTRODUCTION_CHANNEL) return undefined;
  try {
    const bindingId = accountIntroductionApprovalBindingId(record);
    if (!bindingId) return null;
    const { principal } = accountIntroductionAccess(viewer, bindingId);
    const status = asOnboardingOwner(() =>
      reviewAccountIntroductionApproval(principal, bindingId, record.id)
    );
    if (!status.ok) return null;
    return {
      memberId: principal.accountableId.slice(5),
      decidedBy: principal.accountableId,
      id: principal.accountableId,
      displayName: principal.accountableId,
      role: 'owner' as const,
    };
  } catch {
    return null;
  }
}
