/**
 * Separation-of-duties checks for consumers that hold a *link* to an approval
 * (storage channel + request id) or want a refusal reason instead of an
 * exception. Thin wrappers over `assertApprovalUsable`; kept in a leaf module
 * so large consumers stay within the file-size ratchet.
 */
import {
  assertApprovalUsable,
  isSeparationOfDutiesEnabled,
} from './approval-separation-of-duties.js';
import { loadApprovalRequest, type ApprovalRequestRecord } from './approval-store.js';

/**
 * Held actions: the linked shared-store decision must still be usable (e.g.
 * not a self-approval recorded while the setting was off). With the setting
 * on, a missing linked record fails closed.
 */
export function assertLinkedApprovalUsable(
  link: { storageChannel: string; requestId: string },
  heldId: string
): void {
  if (!isSeparationOfDutiesEnabled()) return;
  const linked = loadApprovalRequest(link.storageChannel, link.requestId);
  if (!linked) {
    throw new Error(
      `[POLICY_VIOLATION] Held action ${heldId} has no linked approval record to verify separation of duties`
    );
  }
  assertApprovalUsable(linked, { consumer: 'held_action_apply' });
}

/** The refusal message when an approved record is not usable (audited), else undefined. */
export function approvalUsabilityRefusal(
  record: ApprovalRequestRecord | null | undefined,
  consumer: string
): string | undefined {
  if (!record) return undefined;
  try {
    assertApprovalUsable(record, { consumer });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
