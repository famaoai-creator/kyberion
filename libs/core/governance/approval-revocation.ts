/**
 * Revocation of approved-but-unused approval records
 * (`pnpm kyberion approvals --revoke`). The record keeps its decision and gains
 * a `revocation`; `evaluateApprovalUsability` refuses it for every consumer.
 */
import { nowIso } from '../foundation/time.js';
import {
  appendGovernedArtifactJsonl,
  writeGovernedArtifactJson,
  type GovernedArtifactRole,
} from '../workforce/artifact-store.js';
import { auditChain } from './audit-chain.js';
import {
  APPROVAL_PLACEHOLDER_DECIDERS,
  approvalRequesterIdentities,
  normalizeApprovalPrincipalId,
} from './approval-separation-of-duties.js';
import {
  approvalEventLogicalPath,
  approvalRequestLogicalPath,
  approvalWorkerEventSource,
  forgetSessionApprovalCacheFor,
  loadApprovalRequest,
  projectApprovalWorkerEvent,
  withApprovalRecordLock,
  type ApprovalRequestRecord,
} from './approval-store.js';

export interface ApprovalRevocation {
  revokedBy: string;
  revokedByDisplayName?: string;
  revokedAt: string;
  reason?: string;
}

/**
 * Withdraw an approval that was granted but not yet used: the record keeps
 * `status: approved` (the decision happened and stays evidence) and gains a
 * `revocation`, which every consumer's `evaluateApprovalUsability` check
 * refuses. Only before any effect: a claimed or applied record, or a steering
 * request whose effect starts at decision time, cannot be revoked.
 *
 * Who may revoke follows the approval accountability model — revoking only
 * removes authority, so anyone accountable for the record may do it: its
 * requester (withdrawing their own ask, as with cancel), any principal that
 * approved it (withdrawing their own decision), or the local owner member
 * (`revokerAuthority: 'owner'`, asserted only by a surface that resolved the
 * owner server-side). Surface placeholders never prove identity. Audited to
 * the audit chain and the channel's event log.
 */
export function revokeApprovalRequest(
  role: GovernedArtifactRole,
  params: {
    channel: string;
    storageChannel?: string;
    requestId: string;
    revokedBy: string;
    revokedByDisplayName?: string;
    revokerAuthority?: 'owner';
    reason?: string;
  }
): ApprovalRequestRecord {
  return withApprovalRecordLock(role, params, () => {
    const storageChannel = params.storageChannel || params.channel;
    const record = loadApprovalRequest(storageChannel, params.requestId);
    if (!record)
      throw new Error(`Approval request not found: ${params.channel}/${params.requestId}`);
    const refuse = (why: string): never => {
      throw new Error(`[POLICY_VIOLATION] Approval ${record.id} cannot be revoked: ${why}`);
    };
    if (record.revocation) refuse(`it was already revoked by ${record.revocation.revokedBy}`);
    if (record.status === 'pending') refuse('it is still pending — cancel it instead');
    if (record.status !== 'approved') refuse(`it is ${record.status}, not approved`);
    if (record.applyClaim || record.applyResult) {
      refuse('it was already claimed or applied, so its effect has started');
    }
    if (record.steering) refuse('its effect starts when it is approved (steering request)');
    const revoker = normalizeApprovalPrincipalId(params.revokedBy);
    if (!revoker || APPROVAL_PLACEHOLDER_DECIDERS.has(revoker)) {
      refuse('the revoking identity is empty or a surface placeholder');
    }
    const accountable = new Set([
      ...approvalRequesterIdentities(record),
      ...[record.decidedBy, ...(record.workflow?.approvals ?? []).map((a) => a.approvedBy)]
        .map(normalizeApprovalPrincipalId)
        .filter(Boolean),
    ]);
    if (params.revokerAuthority !== 'owner' && !accountable.has(revoker)) {
      refuse(
        `${params.revokedBy} is neither its requester, one of its approvers, nor the local owner`
      );
    }
    const revocation: ApprovalRevocation = {
      revokedBy: params.revokedBy,
      ...(params.revokedByDisplayName ? { revokedByDisplayName: params.revokedByDisplayName } : {}),
      revokedAt: nowIso(),
      ...(params.reason?.trim() ? { reason: params.reason.trim() } : {}),
    };
    const updated: ApprovalRequestRecord = { ...record, revocation };
    writeGovernedArtifactJson(role, approvalRequestLogicalPath(storageChannel, record.id), updated);
    appendGovernedArtifactJsonl(role, approvalEventLogicalPath(storageChannel), {
      ts: revocation.revokedAt,
      event: 'revoked',
      request_id: record.id,
      correlation_id: record.correlationId,
      revoked_by: revocation.revokedBy,
      revoker_authority: params.revokerAuthority ?? 'accountable_principal',
      reason: revocation.reason,
      channel: record.channel,
      thread_ts: record.threadTs,
    });
    auditChain.record({
      agentId: params.revokedBy,
      action: 'approval_decision',
      operation: 'revoke',
      result: 'completed',
      reason: revocation.reason ?? 'approval revoked before use',
      correlationId: record.correlationId,
      metadata: {
        requestId: record.id,
        channel: record.channel,
        decidedBy: record.decidedBy,
        requestedBy: record.requestedBy,
        revokerAuthority: params.revokerAuthority ?? 'accountable_principal',
      },
    });
    forgetSessionApprovalCacheFor(record.id);
    projectApprovalWorkerEvent(
      'approval_response',
      {
        request_id: record.id,
        correlation_id: record.correlationId,
        status: 'cancelled',
        decided_by: revocation.revokedBy,
        channel: record.channel,
      },
      approvalWorkerEventSource(updated)
    );
    return updated;
  });
}
