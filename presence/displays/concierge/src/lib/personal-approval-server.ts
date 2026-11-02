/** Personal approvals are exposed only to the signed-in installed human owner. */
import {
  listApprovalRequests,
  loadApprovalRequest,
  type ApprovalRequestRecord,
} from '@agent/core/governance/approval-store';
import { withAuthenticatedPersonalApprovals } from '@agent/core/governance/authenticated-personal-approvals';
import { asOnboardingOwner, onboardingAuthorityPrincipal } from './onboarding-authority-server';
import type { ConciergeViewerContext } from './viewer-context';

export function withConciergePersonalApprovals<T>(
  viewer: ConciergeViewerContext,
  run: () => T
): T | null {
  if (!viewer.tierAccess?.includes('personal')) return null;
  let principal: ReturnType<typeof onboardingAuthorityPrincipal>;
  try {
    principal = onboardingAuthorityPrincipal(viewer, { kind: 'person' });
  } catch {
    return null;
  }
  return asOnboardingOwner(() => withAuthenticatedPersonalApprovals(principal, run));
}

export function loadConciergeApproval(viewer: ConciergeViewerContext, channel: string, id: string) {
  const ordinary = loadApprovalRequest(channel, id);
  if (ordinary && !(ordinary.scope?.tier === 'personal' && !ordinary.scope.tenant_slug))
    return ordinary;
  return withConciergePersonalApprovals(viewer, () => loadApprovalRequest(channel, id));
}

export function withConciergeApproval<T>(
  viewer: ConciergeViewerContext,
  record: ApprovalRequestRecord,
  run: () => T
): T | null {
  return record.scope?.tier === 'personal' && !record.scope.tenant_slug
    ? withConciergePersonalApprovals(viewer, run)
    : run();
}

export function conciergeApprovalSnapshot(viewer: ConciergeViewerContext): ApprovalRequestRecord[] {
  const ordinary = listApprovalRequests({ status: 'pending' }).filter(
    (record) => !(record.scope?.tier === 'personal' && !record.scope.tenant_slug)
  );
  const personal =
    withConciergePersonalApprovals(viewer, () => listApprovalRequests({ status: 'pending' })) ?? [];
  const unique = new Map<string, ApprovalRequestRecord>();
  for (const record of [...ordinary, ...personal])
    unique.set(`${record.storageChannel ?? record.channel}/${record.id}`, record);
  return [...unique.values()];
}
