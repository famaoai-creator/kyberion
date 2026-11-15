/** Shared proof check for issuance and exact runtime reads. No approval discovery or mutation. */
import type { ApprovalRequestRecord } from './approval-store.js';
import { computeApprovalPayloadHash } from './approval-presentation.js';
import { serviceAllocationApprovedByOwner } from './service-credential-grant-scope.js';
import { GRANT_APPROVAL_CONSUMER, validatePersonalCredentialGrantRecord } from './grant-store.js';
import {
  personalCredentialGrantEffect,
  personalCredentialGrantPayload,
  type PersonalCredentialGrantDraft,
  type PersonalCredentialGrantRecord,
} from './personal-credential-grant-scope.js';

export function personalCredentialApprovalMatches(
  approval: ApprovalRequestRecord,
  draft: PersonalCredentialGrantDraft
): boolean {
  const ownerDecision = approval.workflow?.approvals.find(
    (entry) =>
      entry.status === 'approved' &&
      entry.decidedByType === 'human' &&
      entry.authenticated === true &&
      entry.approvedBy === draft.scope.owner_ref
  );
  return (
    approval.status === 'approved' &&
    !approval.revocation &&
    approval.scope?.tier === 'personal' &&
    approval.scope.tenant_slug === undefined &&
    approval.scope.nhi_id === draft.scope.nhi_id &&
    approval.requestedByContext?.actorId === draft.scope.nhi_id &&
    approval.accountability?.effectBinding === personalCredentialGrantEffect(draft) &&
    approval.accountability?.payloadHash ===
      computeApprovalPayloadHash(personalCredentialGrantPayload(draft)) &&
    !!ownerDecision &&
    serviceAllocationApprovedByOwner(
      { ...approval, workflow: { ...approval.workflow!, approvals: [ownerDecision] } },
      draft.scope.owner_ref
    )
  );
}

export function verifyPersonalCredentialGrantApprovalBasis(
  record: PersonalCredentialGrantRecord,
  approval: ApprovalRequestRecord | null
): boolean {
  try {
    if (
      !validatePersonalCredentialGrantRecord(record).valid ||
      record.revoked ||
      !(Date.parse(record.granted_at) <= Date.now() && Date.parse(record.expires_at) > Date.now())
    )
      return false;
    const draft = {
      scope: record.scope,
      purpose: record.purpose,
      ttl_days: (Date.parse(record.expires_at) - Date.parse(record.granted_at)) / 86400_000,
    };
    return (
      !!approval &&
      personalCredentialApprovalMatches(approval, draft) &&
      approval.consumption?.consumer === GRANT_APPROVAL_CONSUMER &&
      approval.consumption.effectRef === record.grant_id &&
      approval.consumption.consumedAt === record.granted_at
    );
  } catch {
    return false;
  }
}
