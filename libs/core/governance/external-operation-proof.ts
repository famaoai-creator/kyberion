/** Read-only commit-time revalidation. Admission never creates a standing grant. */
import {
  loadApprovalRequest,
  evaluateApprovalUsability,
  isApprovalRequestExpired,
  computeApprovalPayloadHash,
} from './approval-store.js';
import { findActiveCharter, loadCharterUsage } from './accountability-charter-registry.js';
import type { ApprovalGateCharterInput } from './approval-gate-charter.js';
import type { Charter } from './accountability-charter.js';

export type ExternalOperationCommitProof =
  | {
      kind: 'approval';
      requestId: string;
      operationId: string;
      payloadHash: string;
      recordHash: string;
    }
  | { kind: 'charter'; charter: Charter; input: ApprovalGateCharterInput };

function currentApproval(requestId: string, operationId: string, payloadHash: string) {
  const record = loadApprovalRequest('external-operation', requestId);
  if (
    !record ||
    record.status !== 'approved' ||
    isApprovalRequestExpired(record) ||
    evaluateApprovalUsability(record) ||
    record.accountability?.finalDecision !== 'human_only' ||
    record.accountability.payloadHash !== payloadHash ||
    record.accountability.effectBinding !== operationId
  )
    throw new Error(
      '[EXTERNAL_APPROVAL_CHANGED] Exact approval is absent, expired, revoked or changed'
    );
  return record;
}

export function captureExternalApprovalProof(
  requestId: string,
  operationId: string,
  payloadHash: string
): ExternalOperationCommitProof {
  const record = currentApproval(requestId, operationId, payloadHash);
  return {
    kind: 'approval',
    requestId,
    operationId,
    payloadHash,
    recordHash: computeApprovalPayloadHash({ record }),
  };
}

/** Never re-run the mutating gate or charge a budget twice. Its last slot may
 * already have been consumed by this exact admission. */
export function verifyExternalOperationCommitProof(proof: ExternalOperationCommitProof): void {
  if (proof.kind === 'approval') {
    const record = currentApproval(proof.requestId, proof.operationId, proof.payloadHash);
    if (computeApprovalPayloadHash({ record }) !== proof.recordHash)
      throw new Error('[EXTERNAL_APPROVAL_CHANGED] Approval security record changed before commit');
    return;
  }
  const now = new Date();
  const current = findActiveCharter(proof.input.scope, now, proof.input.pathOptions);
  if (
    !current ||
    computeApprovalPayloadHash({ charter: current }) !==
      computeApprovalPayloadHash({ charter: proof.charter })
  )
    throw new Error(
      '[EXTERNAL_CHARTER_CHANGED] Accepted charter was retired, expired, revoked or amended'
    );
  const usage = loadCharterUsage(current, now, proof.input.pathOptions);
  if (current.appetite.tripwires.some((tripwire) => usage.tripwires_hit.includes(tripwire)))
    throw new Error('[EXTERNAL_CHARTER_CHANGED] A standing stop now prohibits this effect');
}
