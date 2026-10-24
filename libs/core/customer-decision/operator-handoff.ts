/**
 * CD-11: what the operator must do by hand after a customer response or a
 * reminder sweep — an inbox entry plus an operator notification (event
 * `question`), both keyed deterministically so a re-run adds nothing:
 *
 *   - a receipt with answers outside the options, comments or a general
 *     question (`INBOX-CDH-…`, one per agenda × receipt);
 *   - a reminder that has no usable bound channel (`INBOX-CDR-…`, one per
 *     reminder id).
 *
 * Tier boundary: the inbox and the notification are not tenant-partitioned,
 * so they carry ids and counts only; the customer's text stays in the
 * confidential case (the receipt). Same identity rule as the CD-10 bolt
 * rejection (`mission/mission-bolt-review.ts`): the inbox is written as the
 * inbox's own narrow writer (`deliverable_inbox_writer`: the inbox and its
 * lock only), because neither the facade nor a tenant pipeline run has an
 * inbox grant.
 *
 * Not exported from the customer-decision barrel: it pulls in the operator
 * notification stack, which the pure modules must not.
 */
import { createHash } from 'node:crypto';
import { withExecutionContext } from '../authority.js';
import { addInboxEntry, listInboxEntries } from '../deliverable-inbox.js';
import { DELIVERABLE_INBOX_WRITER_ROLE } from '../foundation/deliverable-inbox-writer-capability.js';
import { notifyOperatorWithReceiptSync } from '../surface/operator-notifications.js';
import { t } from '../t.js';
import type { AgendaReminderRecord } from './model.js';
import {
  handoffInboxEntryId,
  manualReminderInboxEntryId,
  type HandoffTarget,
  type PlannedReminder,
} from './reminders.js';

/** Writes only the deliverable inbox and its lock (narrow shared core role). */
const INBOX_WRITER_ROLE = DELIVERABLE_INBOX_WRITER_ROLE;

export interface OperatorTaskNotice {
  inbox_entry_id: string;
  /** The push's receipt status (`suppressed` in tests and when muted; `retryable` → retry later). */
  push_status: string;
}

function contentKey(entryId: string, title: string, body: string): string {
  // The notification store refuses one key with a different text, so the key
  // covers the text: a re-render in another locale is a new notification,
  // never an `uncertain` conflict that blocks every retry.
  const digest = createHash('sha256').update(`${title}\u0000${body}`).digest('hex').slice(0, 12);
  return `${entryId}:${digest}`;
}

/**
 * Add the inbox entry (idempotent by id) and notify the operator. An entry
 * already present under the same id counts as added even when its text was
 * rendered in another locale. Throws when the inbox cannot be written (the
 * caller records nothing and retries).
 */
function addOperatorTask(input: {
  entryId: string;
  kind: string;
  tenantSlug: string;
  title: string;
  body: string;
  linkHint: string;
}): OperatorTaskNotice {
  withExecutionContext(INBOX_WRITER_ROLE, () => {
    try {
      addInboxEntry({
        entryId: input.entryId,
        ifAbsent: true,
        title: input.title,
        summary: input.body,
        tenantSlug: input.tenantSlug,
        kind: input.kind,
      });
    } catch (error) {
      const exists = listInboxEntries({ entryId: input.entryId, limit: 1 }).some(
        (entry) => entry.entry_id === input.entryId && entry.kind === input.kind
      );
      if (!exists) throw error;
    }
  });
  const receipt = notifyOperatorWithReceiptSync(
    'question',
    {
      title: input.title,
      body: input.body,
      link_hint: input.linkHint,
      correlation_id: input.entryId,
    },
    { deduplicationKey: contentKey(input.entryId, input.title, input.body) }
  );
  return { inbox_entry_id: input.entryId, push_status: receipt.status };
}

function statusHint(tenantSlug: string, caseId: string, agendaId: string): string {
  return `pnpm kyberion customer-decision status --tenant ${tenantSlug} --case ${caseId} --agenda ${agendaId}`;
}

/** A receipt the operator must read (ids and counts only). */
export function notifyCustomerDecisionHandoff(input: {
  tenantSlug: string;
  caseId: string;
  agendaId: string;
  target: HandoffTarget;
}): OperatorTaskNotice {
  const entryId = handoffInboxEntryId(input.agendaId, input.target.receipt_id);
  return addOperatorTask({
    entryId,
    kind: 'customer_decision_handoff',
    tenantSlug: input.tenantSlug,
    title: t('customer_decision:handoff_title', { agendaId: input.agendaId }),
    body: t('customer_decision:handoff_body', {
      receiptId: input.target.receipt_id,
      caseId: input.caseId,
      offOption: input.target.off_option,
      comments: input.target.comments,
      questions: input.target.general_question,
    }),
    linkHint: statusHint(input.tenantSlug, input.caseId, input.agendaId),
  });
}

/** A reminder the operator must send by hand: no usable bound channel (ids only). */
export function notifyManualReminder(input: {
  tenantSlug: string;
  caseId: string;
  agendaId: string;
  reminder: PlannedReminder;
  reason: NonNullable<AgendaReminderRecord['reason']>;
}): OperatorTaskNotice {
  const entryId = manualReminderInboxEntryId(input.reminder);
  return addOperatorTask({
    entryId,
    kind: 'customer_decision_manual_reminder',
    tenantSlug: input.tenantSlug,
    title: t('customer_decision:reminder_manual_title', { agendaId: input.agendaId }),
    body: t('customer_decision:reminder_manual_body', {
      reminderId: input.reminder.reminder_id,
      kind: input.reminder.kind,
      date: input.reminder.target_date,
      actorId: input.reminder.actor_id,
      caseId: input.caseId,
      reason: input.reason,
    }),
    linkHint: statusHint(input.tenantSlug, input.caseId, input.agendaId),
  });
}
