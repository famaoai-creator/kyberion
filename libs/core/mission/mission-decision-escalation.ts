/**
 * CD-09 follow-up: escalate a customer decision pin that never succeeds.
 *
 * A task whose pin fails (the decision case could not be found or read) and
 * that is not known to carry customer-decision proposals or holds stays
 * planned and is retried on the next dispatch round — it is never run on a
 * guess. Without a bound, such a task retries silently forever. The worker
 * therefore counts consecutive failed rounds on the task's WorkItem
 * (`metadata.customer_decision_pin_failures`; WorkItem metadata is replaced
 * wholesale per dispatch, so the record is carried forward explicitly) and,
 * at {@link CUSTOMER_DECISION_PIN_ESCALATION_THRESHOLD} rounds, blocks the task
 * (`customer_decision_check_failed`, hold reason `pin_failed_repeatedly`) and
 * notifies the mission owner once: an orchestration observation and an
 * operator inbox entry with a deterministic id. Ids and counts only.
 */
import { createHash } from 'node:crypto';
import { withExecutionContext } from '../authority.js';
import { logger } from '../core.js';
import { addInboxEntry } from '../deliverable-inbox.js';
import { DELIVERABLE_INBOX_WRITER_ROLE } from '../foundation/deliverable-inbox-writer-capability.js';
import { t } from '../t.js';
import { emitMissionOrchestrationObservation } from './mission-orchestration-events.js';

/** Consecutive failed dispatch rounds after which a pin failure blocks the task (human decision: 3). */
export const CUSTOMER_DECISION_PIN_ESCALATION_THRESHOLD = 3;

/** The hold reason of a task blocked because its pin failed repeatedly. */
export const PIN_FAILED_REPEATEDLY = 'pin_failed_repeatedly';

/** Carried on the task's WorkItem metadata while the pin keeps failing (ids only). */
export interface CustomerDecisionPinFailures {
  count: number;
  first_failed_at: string;
  last_failed_at: string;
  case_found: boolean;
  case_id?: string;
}

/** The failure record on a WorkItem's metadata, if well-formed. */
export function readCustomerDecisionPinFailures(
  metadata: Record<string, unknown> | undefined
): CustomerDecisionPinFailures | undefined {
  const raw = metadata?.customer_decision_pin_failures;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const count = record.count;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) return undefined;
  if (typeof record.first_failed_at !== 'string' || typeof record.last_failed_at !== 'string') {
    return undefined;
  }
  return {
    count,
    first_failed_at: record.first_failed_at,
    last_failed_at: record.last_failed_at,
    case_found: record.case_found === true,
    ...(typeof record.case_id === 'string' && record.case_id ? { case_id: record.case_id } : {}),
  };
}

/**
 * The record after this round: one more failed round, or none (the pin
 * succeeded, or the mission has no decision case: the counter resets).
 */
export function nextCustomerDecisionPinFailures(
  previous: CustomerDecisionPinFailures | undefined,
  failed: { case_found: boolean; case_id?: string } | undefined,
  now: string
): CustomerDecisionPinFailures | undefined {
  if (!failed) return undefined;
  return {
    count: (previous?.count ?? 0) + 1,
    first_failed_at: previous?.first_failed_at ?? now,
    last_failed_at: now,
    case_found: failed.case_found,
    ...(failed.case_id ? { case_id: failed.case_id } : {}),
  };
}

/** Has the record reached the escalation threshold? */
export function isCustomerDecisionPinEscalated(
  failures: CustomerDecisionPinFailures | undefined
): boolean {
  return (failures?.count ?? 0) >= CUSTOMER_DECISION_PIN_ESCALATION_THRESHOLD;
}

/** The inbox entry (and notification identity) of one escalation: one per task × failure streak. */
export function customerDecisionPinEscalationInboxEntryId(
  missionId: string,
  taskId: string,
  firstFailedAt: string
): string {
  const digest = createHash('sha256')
    .update([missionId.toUpperCase(), taskId, firstFailedAt].join('\u0000'))
    .digest('hex')
    .slice(0, 16)
    .toUpperCase();
  return `INBOX-CDP-${digest}`;
}

export interface CustomerDecisionPinEscalation {
  inbox_entry_id: string;
  /** false when the inbox entry could not be added (logged); the observation is still emitted. */
  inbox_recorded: boolean;
}

/**
 * Notify the mission owner that a task's pin failed repeatedly: an
 * orchestration observation (`mission_owner_notified`) and an operator inbox
 * entry with a deterministic id (a re-run adds nothing). Call once, when the
 * record first reaches the threshold. Never throws.
 */
export function notifyCustomerDecisionPinFailedRepeatedly(input: {
  missionId: string;
  taskId: string;
  teamRole?: string;
  consumer: string;
  failures: CustomerDecisionPinFailures;
}): CustomerDecisionPinEscalation {
  const entryId = customerDecisionPinEscalationInboxEntryId(
    input.missionId,
    input.taskId,
    input.failures.first_failed_at
  );
  emitMissionOrchestrationObservation({
    event_type: 'mission_owner_notified',
    decision: 'mission_owner_notified',
    mission_id: input.missionId,
    task_id: input.taskId,
    ...(input.teamRole ? { team_role: input.teamRole } : {}),
    reason: 'customer_decision_pin_failed_repeatedly',
    consumer: input.consumer,
    pin_failure_count: input.failures.count,
    first_failed_at: input.failures.first_failed_at,
    case_found: input.failures.case_found,
    ...(input.failures.case_id ? { case_id: input.failures.case_id } : {}),
    inbox_entry_id: entryId,
  });
  const params = {
    missionId: input.missionId,
    taskId: input.taskId,
    count: input.failures.count,
    firstFailedAt: input.failures.first_failed_at,
    caseId: input.failures.case_id ?? '-',
  };
  try {
    // The inbox's own narrow writer: it can write nothing else.
    withExecutionContext(DELIVERABLE_INBOX_WRITER_ROLE, () =>
      addInboxEntry({
        entryId,
        ifAbsent: true,
        missionId: input.missionId,
        title: t('mission_ops:customer_decision_pin_failed_title', params),
        summary: t('mission_ops:customer_decision_pin_failed_body', params),
        kind: 'customer_decision_pin_failed',
      })
    );
    return { inbox_entry_id: entryId, inbox_recorded: true };
  } catch (error) {
    logger.warn(
      `customer decision pin escalation not added to the inbox — ${error instanceof Error ? error.message : String(error)} | the task is blocked and the observation was emitted; check the deliverable inbox store | mission=${input.missionId} task=${input.taskId} entry=${entryId}`
    );
    return { inbox_entry_id: entryId, inbox_recorded: false };
  }
}
