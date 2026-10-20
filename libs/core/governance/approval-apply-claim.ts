import { randomUUID } from 'node:crypto';
import { withExecutionContext } from '../authority.js';
import { withLockSync } from '../lock-utils.js';
import {
  normalizeApprovalChannel,
  normalizeApprovalRequestId,
  loadApprovalRequest,
  isApprovalRequestExpired,
  approvalRequestLogicalPath,
} from './approval-store-reader.js';
import { approvalStoreRoots } from './approval-store-paths.js';
import { computeApprovalPayloadHash } from './approval-presentation.js';
import { assertApprovalUsable } from './approval-separation-of-duties.js';
import {
  appendGovernedArtifactJsonl,
  writeGovernedArtifactJson,
  type GovernedArtifactRole,
} from '../workforce/artifact-store.js';
import { nowIso } from '../foundation/time.js';
import { safeFsyncFile } from '../secure-io.js';
import type { ApprovalRequestRecord, ApprovalApplyClaim } from './approval-store.js';
function approvalEventLogicalPath(channel: string): string {
  return `${approvalStoreRoots().observability}/${normalizeApprovalChannel(channel)}/approvals.jsonl`;
}
export function withApprovalRecordLock<T>(
  role: GovernedArtifactRole,
  params: { channel: string; storageChannel?: string; requestId: string },
  fn: () => T
): T {
  const channel = normalizeApprovalChannel(params.storageChannel || params.channel);
  const id = normalizeApprovalRequestId(params.requestId);
  return withExecutionContext(role, () =>
    withLockSync('approval-record-' + channel + '-' + id, fn)
  );
}
export function claimApprovalApply(
  role: GovernedArtifactRole,
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
    const record = loadApprovalRequest(storageChannel, params.requestId);
    if (!record) throw new Error('[POLICY_VIOLATION] Approval request not found');
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
    const claimPath = writeGovernedArtifactJson(
      role,
      approvalRequestLogicalPath(storageChannel, record.id),
      updated
    );
    // The side effect must not start until the claim is flushed successfully.
    safeFsyncFile(claimPath);
    appendGovernedArtifactJsonl(role, approvalEventLogicalPath(storageChannel), {
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
