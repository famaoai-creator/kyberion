import { randomUUID } from 'node:crypto';
import { resolveIdentityContext, withExecutionContext } from '../authority.js';
import { withLockSync } from '../lock-utils.js';
import { isApprovalRequestExpired } from './approval-store-reader.js';
import { normalizeApprovalChannel, normalizeApprovalRequestId } from './approval-store-paths.js';
import {
  appendLocatedApprovalEvent,
  locateApprovalRequest,
  writeLocatedApprovalRequest,
} from './approval-store-location.js';
import { computeApprovalPayloadHash } from './approval-presentation.js';
import { assertApprovalUsable } from './approval-separation-of-duties.js';
import type { ApprovalStoreRole } from './approval-store-role.js';
import { nowIso } from '../foundation/time.js';
import type { ApprovalRequestRecord, ApprovalApplyClaim } from './approval-store.js';
export function withApprovalRecordLock<T>(
  role: ApprovalStoreRole,
  params: { channel: string; storageChannel?: string; requestId: string },
  fn: () => T
): T {
  const channel = normalizeApprovalChannel(params.storageChannel || params.channel);
  const id = normalizeApprovalRequestId(params.requestId);
  // Keep the caller's tenant binding inside the assumed role, so a caller bound
  // to one tenant still cannot find (or decide) another tenant's partitioned
  // record (approval-store-location.ts).
  const callerTenant = resolveIdentityContext().tenantSlug || undefined;
  return withExecutionContext(
    role,
    () => withLockSync('approval-record-' + channel + '-' + id, fn),
    undefined,
    callerTenant
  );
}
export function claimApprovalApply(
  role: ApprovalStoreRole,
  params: {
    channel: string;
    storageChannel?: string;
    requestId: string;
    appliedBy: string;
    expectedRecordHash: string;
    /** Exact command that opens a fresh request, quoted in a refusal. */
    rerequestCommand?: string;
  }
): ApprovalRequestRecord & { applyClaim: ApprovalApplyClaim } {
  return withApprovalRecordLock(role, params, () => {
    const storageChannel = normalizeApprovalChannel(params.storageChannel || params.channel);
    const located = locateApprovalRequest(storageChannel, params.requestId);
    const record = located?.record;
    if (!located || !record) throw new Error('[POLICY_VIOLATION] Approval request not found');
    if (params.expectedRecordHash !== computeApprovalPayloadHash({ record })) {
      throw new Error('[POLICY_VIOLATION] Approval request changed before apply');
    }
    if (record.status !== 'approved' || isApprovalRequestExpired(record)) {
      throw new Error('[POLICY_VIOLATION] A current approved request is required before apply');
    }
    if (record.applyClaim || record.applyResult) {
      throw new Error('[POLICY_VIOLATION] Approval apply already started; recovery required');
    }
    if (!params.appliedBy.trim()) {
      throw new Error('[POLICY_VIOLATION] Approval apply requires an actor');
    }
    // A decision recorded before separation of duties was switched on must
    // not slip through at apply time.
    assertApprovalUsable(record, {
      consumer: 'apply_claim',
      rerequestCommand: params.rerequestCommand,
    });
    const updated = {
      ...record,
      applyClaim: { claimId: randomUUID(), startedAt: nowIso(), startedBy: params.appliedBy },
    };
    // The side effect must not start until the claim is flushed successfully.
    writeLocatedApprovalRequest(role, located, updated, { fsync: true });
    appendLocatedApprovalEvent(role, located, {
      ts: nowIso(),
      event: 'apply_started',
      request_id: record.id,
      correlation_id: record.correlationId,
      channel: record.channel,
      thread_ts: record.threadTs,
      apply_claim: updated.applyClaim,
    });
    return updated;
  });
}
