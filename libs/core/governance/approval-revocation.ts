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
import type { GovernedArtifactRole } from '../workforce/artifact-store.js';
import { auditChain } from './audit-chain.js';
import {
  APPROVAL_PLACEHOLDER_DECIDERS,
  approvalRequesterIdentities,
  assertApprovalUsable,
  normalizeApprovalPrincipalId,
} from './approval-separation-of-duties.js';
import {
  approvalWorkerEventSource,
  forgetSessionApprovalCacheFor,
  projectApprovalWorkerEvent,
  withApprovalRecordLock,
  type ApprovalRequestRecord,
} from './approval-store.js';
import {
  appendLocatedApprovalEvent,
  locateApprovalRequest,
  writeLocatedApprovalRequest,
} from './approval-store-location.js';

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
  /**
   * Identifier of what the one-shot effect created (e.g. a standing grant id),
   * so a consumer can check that a stored effect is the one this approval made.
   */
  effectRef?: string;
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
  params: RevokeParams
): ApprovalRequestRecord {
  // The registry root comes from the path resolver, never from the caller.
  const owner = resolveMemberByPrincipal({ source: 'loopback' });
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
  authority: 'owner' | 'accountable_principal' | 'standing_effect',
  standingEffect?: { consumer: string; effectRef: string }
): ApprovalRequestRecord {
  return withApprovalRecordLock(role, params, () => {
    const storageChannel = params.storageChannel || params.channel;
    const located = locateApprovalRequest(storageChannel, params.requestId);
    const record = located?.record;
    if (!located || !record)
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
    const standingEffectMatch =
      authority === 'standing_effect' &&
      standingEffect !== undefined &&
      record.consumption?.consumer === standingEffect.consumer &&
      record.consumption?.effectRef === standingEffect.effectRef;
    if (authority === 'standing_effect' && !standingEffectMatch) {
      refuse('it was not consumed by the standing effect being withdrawn');
    }
    if (record.consumption && !standingEffectMatch) {
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
    if (authority === 'accountable_principal' && !accountable.has(revoker)) {
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
    writeLocatedApprovalRequest(role, located, updated);
    appendLocatedApprovalEvent(role, located, {
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
 * Withdraw the approval behind a *standing* effect (a standing grant) when
 * that effect is revoked. Unlike a one-shot effect, a standing effect keeps
 * being used after consumption, so revoking its approval stops further uses
 * (`evaluateApprovalUsability` refuses a revoked record) — the record keeps
 * its consumption and gains a revocation. Only the effect the approval made
 * (`consumption.consumer` + `consumption.effectRef`) can be withdrawn this
 * way. Withdrawal only narrows authority, so any identified principal
 * (operator or agent) may do it; the revoker is recorded as given.
 */
export function revokeStandingEffectApproval(
  role: GovernedArtifactRole,
  params: RevokeParams & {
    revokedBy: string;
    revokedByDisplayName?: string;
    consumer: string;
    effectRef: string;
  }
): ApprovalRequestRecord {
  // Never let an empty ref match a one-shot consumption that carries none.
  if (
    typeof params.consumer !== 'string' ||
    !params.consumer.trim() ||
    typeof params.effectRef !== 'string' ||
    !params.effectRef.trim()
  ) {
    throw new Error(
      '[POLICY_VIOLATION] withdrawing a standing-effect approval needs a consumer and an effectRef'
    );
  }
  return revoke(role, params, 'standing_effect', {
    consumer: params.consumer,
    effectRef: params.effectRef,
  });
}

interface ConsumeParams {
  channel: string;
  storageChannel?: string;
  requestId: string;
  consumer: string;
  consumedBy: string;
  /** What the effect created (see {@link ApprovalConsumption.effectRef}). */
  effectRef?: string;
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
  params: ConsumeParams
): ApprovalRequestRecord {
  return consumeApprovalWithin(role, params, (consume) => consume());
}

/**
 * {@link markApprovalConsumed} for an effect that must run under the approval's
 * record lock: the record is checked (refusals are audited before `run`
 * starts), then `run` decides when to `consume` it, at most once. While `run`
 * holds the lock no revoke can land, so an effect that takes another lock
 * (e.g. the audit chain's) inside `run` keeps the record → audit lock order
 * that revoke uses. If `run` throws before calling `consume`, the approval
 * stays unused.
 */
export function consumeApprovalWithin<T>(
  role: GovernedArtifactRole,
  params: ConsumeParams,
  run: (consume: () => ApprovalRequestRecord) => T
): T {
  return withApprovalRecordLock(role, params, () => {
    const storageChannel = params.storageChannel || params.channel;
    const located = locateApprovalRequest(storageChannel, params.requestId);
    const record = located?.record;
    if (!located || !record || record.status !== 'approved') {
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
    // `used` is set before the first write, so a retry after a failed write
    // cannot write twice; `closed` refuses a call kept past the record lock.
    let used = false;
    let closed = false;
    const consume = (): ApprovalRequestRecord => {
      if (used || closed) {
        throw new Error(
          `[POLICY_VIOLATION] Approval ${record.id} is consumed once, inside its record lock`
        );
      }
      used = true;
      const consumption: ApprovalConsumption = {
        consumer: params.consumer,
        consumedBy: params.consumedBy,
        consumedAt: nowIso(),
        ...(params.effectRef ? { effectRef: params.effectRef } : {}),
      };
      const updated: ApprovalRequestRecord = { ...record, consumption };
      writeLocatedApprovalRequest(role, located, updated);
      appendLocatedApprovalEvent(role, located, {
        ts: consumption.consumedAt,
        event: 'consumed',
        request_id: record.id,
        correlation_id: record.correlationId,
        consumer: consumption.consumer,
        consumed_by: consumption.consumedBy,
        ...(consumption.effectRef ? { effect_ref: consumption.effectRef } : {}),
        channel: record.channel,
        thread_ts: record.threadTs,
      });
      return updated;
    };
    try {
      return run(consume);
    } finally {
      closed = true;
    }
  });
}
