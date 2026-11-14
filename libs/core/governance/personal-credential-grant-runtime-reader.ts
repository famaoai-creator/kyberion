/** Exact addressed read adapter for the claimed personal broker. Never scans partitions. */
import { assertPersonalCredentialUseRead } from '../foundation/personal-credential-use-capability.js';
import { readGovernedArtifactJson } from '../workforce/artifact-store-reader.js';
import { approvalRequestLogicalPathAt } from './approval-store-location.js';
import { personalApprovalOwnerHash } from './personal-approval-runtime.js';
import { normalizeApprovalRequestId } from './approval-store-paths.js';
import { GRANT_APPROVAL_CHANNEL } from './grant-store.js';
import { loadPersonalCredentialGrantRecordForRuntime } from './personal-credential-grant-store.js';
import type { PersonalCredentialGrantRecord } from './personal-credential-grant-scope.js';
import type { ApprovalRequestRecord } from './approval-store.js';

export function personalCredentialApprovalPath(actorId: string, approvalId: string): string {
  if (normalizeApprovalRequestId(approvalId) !== approvalId)
    throw new Error('[PERSONAL_CREDENTIAL_GRANT_DENIED] Exact approval id required');
  return approvalRequestLogicalPathAt(
    { kind: 'personal', tier: 'personal', owner_hash: personalApprovalOwnerHash(actorId) },
    GRANT_APPROVAL_CHANNEL,
    approvalId
  );
}

export function loadPersonalRuntimeCredentialGrant(
  ownerRef: string,
  grantId: string
): PersonalCredentialGrantRecord | null {
  assertPersonalCredentialUseRead('grant', grantId);
  return loadPersonalCredentialGrantRecordForRuntime(ownerRef, grantId);
}

/** Original worker envelope stays unchanged: authority is only the exact live read capability. */
export function loadPersonalRuntimeCredentialApproval(
  actorId: string,
  approvalId: string
): ApprovalRequestRecord | null {
  assertPersonalCredentialUseRead('approval', approvalId);
  const record = readGovernedArtifactJson<ApprovalRequestRecord>(
    personalCredentialApprovalPath(actorId, approvalId)
  );
  return record &&
    record.id === approvalId &&
    record.channel === GRANT_APPROVAL_CHANNEL &&
    record.scope?.tier === 'personal' &&
    record.scope.nhi_id === actorId &&
    record.scope.tenant_slug === undefined &&
    record.scope.organization_id === undefined
    ? record
    : null;
}
