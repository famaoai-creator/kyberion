/** Personal approvals are exposed only to the signed-in installed human owner. */
import {
  listApprovalRequests,
  loadApprovalRequest,
  type ApprovalRequestRecord,
} from '@agent/core/governance/approval-store';
import { withAuthenticatedPersonalApprovals } from '@agent/core/governance/authenticated-personal-approvals';
import { inspectInstalledOnboardingRuntime } from '@agent/core/organization/onboarding-runtime-identity';
import { viewerPersonIds } from '@agent/core/surface/surface-authorization';
import { asOnboardingOwner, onboardingAuthorityPrincipal } from './onboarding-authority-server';
import type { ConciergeViewerContext } from './viewer-context';

export function withConciergePersonalApprovals<T>(
  viewer: ConciergeViewerContext,
  run: () => T
): T | null {
  // Admission is the signed-in installed owner proof below: viewer tierAccess
  // never lists personal (the mask applies to every concierge role), so gating
  // on it here would dead-lock the member-session approval path the principal
  // contract explicitly supports (browser-session / oidc-jwt / registry-token).
  try {
    const principal = onboardingAuthorityPrincipal(viewer, { kind: 'person' });
    return asOnboardingOwner(() => withAuthenticatedPersonalApprovals(principal, run));
  } catch {
    // No provable installed-owner context → the personal partition stays closed.
    return null;
  }
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

/**
 * The viewer's person ids for row-custody admission. Person-scope records in
 * the personal partition name the installed agent's NHI (`scope.nhi_id`), so
 * the proven installation owner's id set additionally binds that NHI —
 * without it the owner's own personal approvals read as another person's
 * records and every viewer-scoped summary drops them. The NHI is added only
 * when the full owner proof (`withConciergePersonalApprovals`) passes, so a
 * foreign viewer never gains custody of the installation's records.
 */
export function conciergeViewerPersonIds(viewer: ConciergeViewerContext): readonly string[] {
  const ids = new Set(viewerPersonIds(viewer));
  const installed = withConciergePersonalApprovals(viewer, () =>
    inspectInstalledOnboardingRuntime({ kind: 'person' })
  );
  if (installed?.ready && installed.agentId) ids.add(installed.agentId);
  return [...ids];
}
