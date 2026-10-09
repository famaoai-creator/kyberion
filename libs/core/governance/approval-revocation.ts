/**
 * Revocation and one-shot consumption of approved records.
 *
 * `pnpm kyberion approvals --revoke` marks an approved record revoked: the
 * record keeps its decision and gains a `revocation`, and every further use is
 * refused (`evaluateApprovalUsability`). Revoking does not undo an effect that
 * already happened; it only stops later uses. Consumers whose effect is
 * one-shot record it — through the apply claim (`claimApprovalApply`) or
 * {@link markApprovalConsumed} — so a revoke after that reports the approval
 * as already consumed instead of pretending to withdraw it.
 */
import { nowIso } from '../foundation/time.js';
import { resolveMemberByPrincipal } from '../organization/member-registry.js';
import {
  appendGovernedArtifactJsonl,
  writeGovernedArtifactJson,
  type GovernedArtifactRole,
} from '../workforce/artifact-store.js';
import { auditChain } from './audit-chain.js';
import {
  APPROVAL_PLACEHOLDER_DECIDERS,
  approvalRequesterIdentities,
  assertApprovalUsable,
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

export interface ApprovalConsumption {
  /** Consumer id (see approval-sod-consumers.contract.test.ts). */
  consumer: string;
  consumedBy: string;
  consumedAt: string;
}

/**
 * Revoke an approved record — further uses are refused: the record keeps
 * `status: approved` (the decision happened and stays evidence) and gains a
 * `revocation`, which every consumer's `evaluateApprovalUsability` check
 * refuses. A record a one-shot effect already used (claimed, applied or
 * consumed), or a steering request whose effect starts at decision time, is
 * refused: there is no further use left to stop.
 *
 * Who may revoke follows the approval accountability model — revoking only
 * removes authority, so anyone accountable for the record may do it: its
 * requester (withdrawing their own ask, as with cancel), any principal that
 * approved it (withdrawing their own decision), or the local owner member —
 * only through {@link revokeApprovalAsLocalOwner}, which resolves the owner
 * itself. Surface placeholders never prove identity. Audited to the audit
 * chain and the channel's event log.
 */
export function revokeApprovalRequest(
  role: GovernedArtifactRole,
  params: RevokeParams & { revokedBy: string; revokedByDisplayName?: string }
): ApprovalRequestRecord {
  return revoke(role, params, 'accountable_principal');
}

interface RevokeParams {
  channel: string;
  storageChannel?: string;
  requestId: string;
  reason?: string;
}

/**
 * Revoke as the local owner member, resolved here from the member registry
 * (the loopback owner), never asserted by the caller. Fails when this machine
 * has no active owner member.
 */
export function revokeApprovalAsLocalOwner(
  role: GovernedArtifactRole,
  params: RevokeParams & { rootDir?: string }
): ApprovalRequestRecord {
  const owner = resolveMemberByPrincipal(
    { source: 'loopback' },
    params.rootDir ? { rootDir: params.rootDir } : {}
  );
  if (!owner) {
    throw new Error(
      '[POLICY_VIOLATION] approval revoke blocked — this machine has no active owner member ' +
        '| next: run `pnpm organization member ensure-owner`, or revoke as the requester or an approver ' +
        '| evidence: no loopback owner member'
    );
  }
  return revoke(
    role,
    { ...params, revokedBy: `user:${owner.member_id}`, revokedByDisplayName: owner.display_name },
    'owner'
  );
}

function revoke(
  role: GovernedArtifactRole,
  params: RevokeParams & { revokedBy: string; revokedByDisplayName?: string },
  authority: 'owner' | 'accountable_principal'
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
      refuse('it was already claimed or applied — its one-shot effect has happened');
    }
    if (record.consumption) {
      refuse(
        `it was already consumed by ${record.consumption.consumer} at ${record.consumption.consumedAt} — its one-shot effect has happened`
      );
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
    if (authority !== 'owner' && !accountable.has(revoker)) {
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
      revoker_authority: authority,
      reason: revocation.reason,
      channel: record.channel,
      thread_ts: record.threadTs,
    });
    auditChain.record({
      agentId: params.revokedBy,
      action: 'approval_decision',
      operation: 'revoke',
      result: 'completed',
      reason: revocation.reason ?? 'approval revoked; further uses refused',
      correlationId: record.correlationId,
      metadata: {
        requestId: record.id,
        channel: record.channel,
        decidedBy: record.decidedBy,
        requestedBy: record.requestedBy,
        revokerAuthority: authority,
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

/**
 * Record that a one-shot effect used an approved record (consumers that do not
 * take an apply claim: organization decisions, service recording promotion).
 * Refuses a record that is unusable (revoked, or failing separation of
 * duties) or already consumed, so the approval is used at most once and a
 * later revoke reports it as consumed.
 */
export function markApprovalConsumed(
  role: GovernedArtifactRole,
  params: {
    channel: string;
    storageChannel?: string;
    requestId: string;
    consumer: string;
    consumedBy: string;
  }
): ApprovalRequestRecord {
  return withApprovalRecordLock(role, params, () => {
    const storageChannel = params.storageChannel || params.channel;
    const record = loadApprovalRequest(storageChannel, params.requestId);
    if (!record || record.status !== 'approved') {
      throw new Error(
        `[POLICY_VIOLATION] Approval ${params.requestId} is ${record?.status ?? 'missing'}, not approved`
      );
    }
    if (record.consumption || record.applyClaim || record.applyResult) {
      throw new Error(
        `[POLICY_VIOLATION] Approval ${record.id} was already used${record.consumption ? ` by ${record.consumption.consumer} at ${record.consumption.consumedAt}` : ''}; approvals are used once`
      );
    }
    assertApprovalUsable(record, { consumer: params.consumer });
    const consumption: ApprovalConsumption = {
      consumer: params.consumer,
      consumedBy: params.consumedBy,
      consumedAt: nowIso(),
    };
    const updated: ApprovalRequestRecord = { ...record, consumption };
    writeGovernedArtifactJson(role, approvalRequestLogicalPath(storageChannel, record.id), updated);
    appendGovernedArtifactJsonl(role, approvalEventLogicalPath(storageChannel), {
      ts: consumption.consumedAt,
      event: 'consumed',
      request_id: record.id,
      correlation_id: record.correlationId,
      consumer: consumption.consumer,
      consumed_by: consumption.consumedBy,
      channel: record.channel,
      thread_ts: record.threadTs,
    });
    return updated;
  });
}
