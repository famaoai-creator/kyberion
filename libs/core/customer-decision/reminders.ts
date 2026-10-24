/**
 * CD-11 reminders and operator hand-offs (plan
 * docs/developer/improvement-plans-2026-10/CUSTOMER_DECISION_HEARING_PLAN_2026-10-24.ja.md
 * "CD-11 の実装設計"). Pure: no I/O, no clock — callers pass `now`.
 *
 * Reminders (all to the customer, all dates are UTC calendar dates):
 *   - `before_due` on the day before the agenda's `respond_by`, `due` on the
 *     day itself — to each decider with a valid invite (not revoked, not
 *     expired) who has not answered the current approved revision;
 *   - `override_closing` from two days before a date `override_until`
 *     deadline until the window closes — to each decider with a valid invite,
 *     while an entry with that deadline still follows our side (layer `ours`
 *     or `org_default`). Starting two days early lets a missed daily run
 *     catch up; the record key keeps it to one notice per deadline.
 * Only a `sent` agenda whose approval matches its content gets reminders
 * (closed, withdrawn and edited-but-not-re-approved agendas get none).
 *
 * One record per agenda × actor × kind × target date (`reminder_id`), kept
 * on the agenda outside the content hash (`agenda.reminders`). A record in
 * `approval_pending` is planned again (the sweep re-asks the gate with the
 * same correlation id); every other status is final.
 *
 * Hand-offs: after a response, the answers the operator must read — free
 * text outside a hearing entry (an answer outside the offered options),
 * answers with a comment, and a general question — go to the operator as
 * one inbox entry per receipt, ids and counts only.
 */
import { createHash } from 'node:crypto';
import { agendaContentHash } from './hash.js';
import { agendaAnswerState } from './respond.js';
import type { CustomerDecisionInvite } from './invite.js';
import type {
  AgendaHandoffRecord,
  AgendaReminderKind,
  AgendaReminderRecord,
  DecisionAgenda,
  DecisionReceipt,
  EffectiveDecision,
} from './model.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC calendar date (`YYYY-MM-DD`) of an ISO timestamp, or null. */
export function utcDate(iso: string): string | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
}

/** `date` (YYYY-MM-DD) plus `days` (may be negative), as YYYY-MM-DD. */
export function addUtcDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Is `value` a real calendar date written `YYYY-MM-DD`? */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);
}

/** `rmd-<hex16>` over agenda × actor × kind × target date. */
export function reminderId(
  agendaId: string,
  actorId: string,
  kind: AgendaReminderKind,
  targetDate: string
): string {
  return `rmd-${digest([agendaId, actorId, kind, targetDate])}`;
}

/** The registered routine template of a reminder kind (`customer-outbound-templates.ts`). */
export const REMINDER_TEMPLATE_IDS: Readonly<Record<AgendaReminderKind, string>> = {
  before_due: 'customer_decision.reminder.before_due',
  due: 'customer_decision.reminder.due',
  override_closing: 'customer_decision.reminder.override_closing',
};

export interface PlannedReminder {
  reminder_id: string;
  kind: AgendaReminderKind;
  actor_id: string;
  target_date: string;
  /** The day this reminder is (or was) due to go out. */
  send_on: string;
  /** The decider's valid invites (ids only). */
  invite_ids: string[];
  /** The fixed template and its parameters: the agenda title and the target date. */
  template: { id: string; params: { title: string; date: string }; locale: 'ja' | 'en' };
}

export interface ReminderPlanInput {
  agenda: DecisionAgenda;
  /** Invites of this agenda (others are ignored). */
  invites: readonly CustomerDecisionInvite[];
  /** Receipts of this agenda (others are ignored). */
  receipts: readonly DecisionReceipt[];
  /** The agenda's effective decisions at `now`. */
  effective: readonly EffectiveDecision[];
  now: string;
}

/** Decider actors with at least one valid invite to the agenda: actor id → invite ids. */
function validDeciders(
  agenda: DecisionAgenda,
  invites: readonly CustomerDecisionInvite[],
  nowMs: number
): Map<string, string[]> {
  const byActor = new Map<string, string[]>();
  for (const invite of invites) {
    if (invite.agenda_id !== agenda.agenda_id || invite.case_id !== agenda.case_id) continue;
    if (invite.participant.role !== 'decider' || invite.revoked_at) continue;
    const expires = Date.parse(invite.expires_at);
    if (!Number.isFinite(expires) || nowMs >= expires) continue;
    const ids = byActor.get(invite.participant.actor_id) ?? [];
    ids.push(invite.invite_id);
    byActor.set(invite.participant.actor_id, ids);
  }
  return byActor;
}

function plan(
  agenda: DecisionAgenda,
  kind: AgendaReminderKind,
  actorId: string,
  targetDate: string,
  sendOn: string,
  inviteIds: string[]
): PlannedReminder {
  return {
    reminder_id: reminderId(agenda.agenda_id, actorId, kind, targetDate),
    kind,
    actor_id: actorId,
    target_date: targetDate,
    send_on: sendOn,
    invite_ids: [...inviteIds].sort(),
    template: {
      id: REMINDER_TEMPLATE_IDS[kind],
      params: { title: agenda.title, date: targetDate },
      locale: agenda.locale,
    },
  };
}

/**
 * Every reminder the agenda would send, whatever the day: the respond-by
 * pair for deciders who have not answered, the override notices for each
 * date deadline still open with our side in force. `send_on` says when.
 */
export function scheduleAgendaReminders(input: ReminderPlanInput): PlannedReminder[] {
  const { agenda, now } = input;
  const nowMs = Date.parse(now);
  const today = utcDate(now);
  if (!today || agenda.status !== 'sent' || agendaAnswerState(agenda).ok === false) return [];
  const deciders = validDeciders(agenda, input.invites, nowMs);
  if (deciders.size === 0) return [];
  const hash = agendaContentHash(agenda);
  const reminders: PlannedReminder[] = [];

  if (agenda.respond_by && isCalendarDate(agenda.respond_by)) {
    const answered = new Set(
      input.receipts
        .filter(
          (receipt) =>
            receipt.agenda_id === agenda.agenda_id &&
            receipt.content_hash === hash &&
            receipt.participant.role === 'decider'
        )
        .map((receipt) => receipt.participant.actor_id)
    );
    for (const [actorId, inviteIds] of deciders) {
      if (answered.has(actorId)) continue;
      reminders.push(
        plan(
          agenda,
          'before_due',
          actorId,
          agenda.respond_by,
          addUtcDays(agenda.respond_by, -1),
          inviteIds
        )
      );
      reminders.push(plan(agenda, 'due', actorId, agenda.respond_by, agenda.respond_by, inviteIds));
    }
  }

  const effective = new Map(input.effective.map((decision) => [decision.entry_id, decision]));
  const deadlines = new Set<string>();
  for (const entry of agenda.entries) {
    const until = entry.override_until;
    if (!until || until.kind !== 'date') continue;
    const deadlineMs = Date.parse(until.at);
    // Closed already: nothing left to change.
    if (!Number.isFinite(deadlineMs) || nowMs >= deadlineMs) continue;
    const layer = effective.get(entry.entry_id)?.layer;
    if (layer !== 'ours' && layer !== 'org_default') continue;
    const date = utcDate(until.at);
    if (date) deadlines.add(date);
  }
  for (const date of [...deadlines].sort()) {
    for (const [actorId, inviteIds] of deciders) {
      reminders.push(
        plan(agenda, 'override_closing', actorId, date, addUtcDays(date, -2), inviteIds)
      );
    }
  }
  return reminders;
}

/** Recorded with a final status (anything but `approval_pending`). */
function isSettled(reminder: PlannedReminder, records: readonly AgendaReminderRecord[]): boolean {
  return records.some(
    (record) => record.reminder_id === reminder.reminder_id && record.status !== 'approval_pending'
  );
}

/**
 * The reminders due at `now` that are not settled yet: `before_due` and
 * `due` on their exact day, `override_closing` from two days before the
 * deadline while the window is open. Sorted for a stable sweep.
 */
export function dueAgendaReminders(input: ReminderPlanInput): PlannedReminder[] {
  const today = utcDate(input.now);
  if (!today) return [];
  const records = input.agenda.reminders ?? [];
  return scheduleAgendaReminders(input)
    .filter((reminder) =>
      reminder.kind === 'override_closing' ? reminder.send_on <= today : reminder.send_on === today
    )
    .filter((reminder) => !isSettled(reminder, records))
    .sort((a, b) => a.reminder_id.localeCompare(b.reminder_id));
}

/** Reminders still to come (send day after `now`), for `status`. */
export function upcomingAgendaReminders(input: ReminderPlanInput): PlannedReminder[] {
  const today = utcDate(input.now);
  if (!today) return [];
  const records = input.agenda.reminders ?? [];
  return scheduleAgendaReminders(input)
    .filter((reminder) => reminder.send_on > today && !isSettled(reminder, records))
    .sort(
      (a, b) => a.send_on.localeCompare(b.send_on) || a.reminder_id.localeCompare(b.reminder_id)
    );
}

// ---------------------------------------------------------------------------
// Hand-offs
// ---------------------------------------------------------------------------

export interface HandoffTarget {
  receipt_id: string;
  off_option: number;
  comments: number;
  general_question: number;
}

/**
 * Receipts with something the operator must read. Bolt-review
 * `request_changes` / `reject` answers are routed by CD-10 (`bolt_routing`)
 * and not counted again here.
 */
export function handoffTargets(
  agenda: Pick<DecisionAgenda, 'agenda_id' | 'entries' | 'bolt_mission_id'>,
  receipts: readonly DecisionReceipt[]
): HandoffTarget[] {
  const kinds = new Map(agenda.entries.map((entry) => [entry.entry_id, entry.kind]));
  const targets: HandoffTarget[] = [];
  for (const receipt of receipts) {
    if (receipt.agenda_id !== agenda.agenda_id) continue;
    let offOption = 0;
    let comments = 0;
    for (const answer of receipt.answers) {
      if (answer.choice === 'free_text' && kinds.get(answer.entry_id) !== 'hearing') offOption += 1;
      else if (answer.comment) {
        const boltRouted =
          Boolean(agenda.bolt_mission_id) &&
          (answer.choice === 'request_changes' || answer.choice === 'reject');
        if (!boltRouted) comments += 1;
      }
    }
    const question = receipt.general_question ? 1 : 0;
    if (offOption + comments + question === 0) continue;
    targets.push({
      receipt_id: receipt.receipt_id,
      off_option: offOption,
      comments,
      general_question: question,
    });
  }
  return targets;
}

/** Notified already (an inbox entry exists and the push was not left retryable). */
export function isHandoffDone(
  target: Pick<HandoffTarget, 'receipt_id'>,
  records: readonly AgendaHandoffRecord[] = []
): boolean {
  return records.some((record) => record.receipt_id === target.receipt_id && record.notified_at);
}

/** The inbox entry (and notification identity) of a receipt's hand-off. */
export function handoffInboxEntryId(agendaId: string, receiptId: string): string {
  return `INBOX-CDH-${digest([agendaId, receiptId]).toUpperCase()}`;
}

/** The inbox entry of a reminder the operator must send by hand. */
export function manualReminderInboxEntryId(reminder: Pick<PlannedReminder, 'reminder_id'>): string {
  return `INBOX-CDR-${reminder.reminder_id.slice('rmd-'.length).toUpperCase()}`;
}
