/**
 * Mission-side proof that a task was superseded by `mission_controller
 * supersede-task` (review B1, CD-09 follow-up).
 *
 * A consumer lock's `superseded` mark is written by the lock's owner under the
 * narrow consumer store role; the guard checks its shape but cannot tie it to
 * the human approval on the mission side. A worker could therefore mark its
 * own held lock superseded. Every boundary that changes behaviour for a
 * superseded lock (no hold, no release, no rework) honours the mark ONLY when
 * this proof holds:
 *   - the task's NEXT_TASKS entry is `status: superseded` with a
 *     `superseded.approval_request_id`;
 *   - that request on the `mission-task-supersede` channel is an approved
 *     `mission_gate` with an authenticated human decision, bound to the
 *     effect `mission-task-supersede:<MISSION>:<task>` and to the payload hash
 *     of {mission, task, by, reason_sha256} the entry records.
 * Anything else fails closed (not superseded). Ids only; never throws.
 */
import * as nodePath from 'node:path';
// The read-only approval reader (not the store): the proof is read at every
// customer-decision boundary, which must not join the approval store's cycle.
import { computeApprovalPayloadHash } from '../governance/approval-presentation.js';
import { loadApprovalRequest } from '../governance/approval-store-reader.js';
import { logger } from '../core.js';
import { findMissionPath } from '../path-resolver.js';
import { safeExistsSync } from '../secure-io.js';
import { loadMissionNextTaskObjectsAtPath } from './mission-next-task-reader.js';

export const MISSION_TASK_SUPERSEDE_APPROVAL_CHANNEL = 'mission-task-supersede';

export function missionTaskSupersedeEffectBinding(missionId: string, taskId: string): string {
  return `mission-task-supersede:${missionId.toUpperCase()}:${taskId}`;
}

/** The approval payload of a supersede, from the reason's SHA-256 (what the human approved). */
export function missionTaskSupersedePayloadFromHash(input: {
  missionId: string;
  taskId: string;
  byTaskId: string;
  reasonSha256: string;
}): Record<string, string> {
  return {
    mission_id: input.missionId.toUpperCase(),
    task_id: input.taskId,
    by_task_id: input.byTaskId,
    reason_sha256: input.reasonSha256,
    effect: missionTaskSupersedeEffectBinding(input.missionId, input.taskId),
  };
}

export type MissionTaskSupersedeProof =
  | { verified: true; by_task_id: string; approval_request_id: string }
  | { verified: false; reason: string };

/**
 * Is the task superseded on the mission side, with the human approval that
 * authorized it? `byTaskId` / `approvalRequestId`, when given (e.g. from a
 * lock's mark), must match what the mission recorded.
 */
export function missionTaskSupersedeProof(
  missionId: string,
  taskId: string,
  options: { byTaskId?: string; approvalRequestId?: string } = {}
): MissionTaskSupersedeProof {
  try {
    const upper = missionId.trim().toUpperCase();
    const missionPath = findMissionPath(upper);
    if (!missionPath) return { verified: false, reason: 'mission_not_found' };
    const nextTasksPath = nodePath.join(missionPath, 'NEXT_TASKS.json');
    if (!safeExistsSync(nextTasksPath)) return { verified: false, reason: 'no_task_board' };
    const entry = (loadMissionNextTaskObjectsAtPath(nextTasksPath, upper) || []).find(
      (task) => String(task.task_id || '') === taskId
    );
    if (!entry) return { verified: false, reason: 'task_not_found' };
    if (String(entry.status || '').toLowerCase() !== 'superseded') {
      return { verified: false, reason: 'task_not_superseded' };
    }
    const record =
      entry.superseded && typeof entry.superseded === 'object'
        ? (entry.superseded as Record<string, unknown>)
        : undefined;
    const approvalId =
      typeof record?.approval_request_id === 'string' ? record.approval_request_id : '';
    const byTaskId = typeof record?.by_task_id === 'string' ? record.by_task_id : '';
    const reasonSha256 = typeof record?.reason_sha256 === 'string' ? record.reason_sha256 : '';
    if (!approvalId || !byTaskId || !reasonSha256) {
      return { verified: false, reason: 'supersede_record_incomplete' };
    }
    if (options.byTaskId !== undefined && options.byTaskId !== byTaskId) {
      return { verified: false, reason: 'replacement_mismatch' };
    }
    if (options.approvalRequestId !== undefined && options.approvalRequestId !== approvalId) {
      return { verified: false, reason: 'approval_mismatch' };
    }
    const approval = loadApprovalRequest(MISSION_TASK_SUPERSEDE_APPROVAL_CHANNEL, approvalId);
    if (!approval || approval.kind !== 'mission_gate' || approval.status !== 'approved') {
      return { verified: false, reason: 'approval_not_approved' };
    }
    if (approval.source?.missionId?.toUpperCase() !== upper) {
      return { verified: false, reason: 'approval_other_mission' };
    }
    if (
      approval.accountability?.effectBinding !== missionTaskSupersedeEffectBinding(upper, taskId)
    ) {
      return { verified: false, reason: 'approval_other_effect' };
    }
    const payloadHash = computeApprovalPayloadHash(
      missionTaskSupersedePayloadFromHash({ missionId: upper, taskId, byTaskId, reasonSha256 })
    );
    if (approval.accountability?.payloadHash !== payloadHash) {
      return { verified: false, reason: 'approval_other_payload' };
    }
    const human = approval.workflow?.approvals?.some(
      (decision) =>
        decision.status === 'approved' &&
        decision.decidedByType === 'human' &&
        decision.authenticated === true
    );
    if (!human) return { verified: false, reason: 'approval_not_human' };
    return { verified: true, by_task_id: byTaskId, approval_request_id: approvalId };
  } catch (error) {
    const code = /\[([A-Z0-9_]+)\]/u.exec(error instanceof Error ? error.message : String(error));
    return { verified: false, reason: `proof_unreadable:${code?.[1] ?? 'error'}` };
  }
}

/** {@link missionTaskSupersedeProof} as a boolean (fails closed). */
export function isTaskVerifiablySuperseded(
  missionId: string,
  taskId: string,
  options: { byTaskId?: string; approvalRequestId?: string } = {}
): boolean {
  return missionTaskSupersedeProof(missionId, taskId, options).verified;
}

const warnedUnprovenMissions = new Set<string>();

/**
 * For readers that grant authority on a superseded task (the finish gate,
 * record-evidence auto-complete, the continuous owner's "all done"): is this
 * `superseded` status proven? An unproven one counts as pending, with one
 * diagnostic warning per mission and process.
 */
export function isSupersedeProvenForGate(
  missionId: string,
  taskId: string,
  reader: string
): boolean {
  const proof = missionTaskSupersedeProof(missionId, taskId);
  if (proof.verified === true) return true;
  const key = missionId.trim().toUpperCase();
  if (!warnedUnprovenMissions.has(key)) {
    warnedUnprovenMissions.add(key);
    logger.warn(
      `task ${taskId} counted as pending — its superseded status is not proven (${'reason' in proof ? proof.reason : 'unknown'}) | ${reader} trusts only a supersede-task backed by an approved human request: pnpm mission supersede-task ${key} ${taskId} --by <new_task_id> --reason <text> --request-approval, or restore the task's status | mission=${key}`
    );
  }
  return false;
}
