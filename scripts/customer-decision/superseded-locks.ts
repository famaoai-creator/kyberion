/**
 * CD-09 review B1: when the operator facade honours a consumer lock's
 * `superseded` mark. Part of scripts/customer_decision.ts (the entry point).
 *
 * The consumer store guard only checks the mark's shape (set once, alone, same
 * mission, an `approval_request_id`); a worker holding its own lock capability
 * can still write one. So every facade reader — `status` (taskProposalStatus),
 * `overview`, `task-decisions`, the `--reask` candidate check, the pending
 * collection — treats a lock as superseded ONLY through
 * {@link isApprovedSupersededConsumerLock}, which defers to the mission-side
 * proof (`isDecisionLockVerifiablySuperseded`: an approved, authenticated
 * human mission_gate supersede of that task). A mark that does not verify is
 * ignored: the lock is read as a live task (its hold and questions stay
 * visible), and the mission side logs it once.
 */
import type { ConsumedDecisionLockRecord } from '@agent/core/customer-decision';
import { isDecisionLockVerifiablySuperseded } from '@agent/core/mission/mission-decision-lock';
import {
  missionTaskSupersedeProof,
  type MissionTaskSupersedeProof,
} from '@agent/core/mission/mission-task-supersede-proof';

/** Is this lock superseded by an approval the mission side verified? */
export function isApprovedSupersededConsumerLock(
  tenant: string,
  lock: ConsumedDecisionLockRecord
): boolean {
  // The lock's own mission names the supersede to verify; the tenant is the
  // facade's (already bound-checked) and the case belongs to it.
  void tenant;
  return lock.superseded !== undefined && isDecisionLockVerifiablySuperseded(lock);
}

/**
 * The mission-side proof of a marked lock, with why it failed (`status`
 * names it for a frozen lock): the same check as
 * {@link isApprovedSupersededConsumerLock}, without its once-per-mission log.
 */
export function consumerLockSupersedeProof(
  lock: ConsumedDecisionLockRecord & {
    superseded: NonNullable<ConsumedDecisionLockRecord['superseded']>;
  }
): MissionTaskSupersedeProof {
  return missionTaskSupersedeProof(lock.mission_id, lock.task_id, {
    byTaskId: lock.superseded.by_task_id,
    approvalRequestId: lock.superseded.approval_request_id,
  });
}
