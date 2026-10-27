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
 *     or `org_default`). Starting two days early lets a missed day of sweeps
 *     catch up; the record key keeps it to one notice per deadline.
 * Only an agenda with invites whose approval matches its content gets reminders
 * (closed, withdrawn and edited-but-not-re-approved agendas get none).
 *
 * Sweeps: the tenant pipeline runs hourly from 09:30 to 18:30 Asia/Tokyo
 * (`30 9-18 * * *`, 00:30–09:30 UTC, so every sweep of a day falls on the same
 * UTC date). Running more than once a day changes nothing about what is sent:
 * the records below keep each reminder to one send. It lets a held reminder
 * approved after one sweep go out later the same day — which matters for a
 * `due` reminder, which is never carried over to the next day.
 *
 * One record per agenda × actor × kind × target date (`reminder_id`), kept
 * on the agenda outside the content hash (`agenda.reminders`). A record in
 * `approval_pending` is planned again (the sweep re-asks the gate with the
 * same correlation id): on its send day by every later sweep, and after it
 * (an approval granted after the day's last sweep) for at most
 * `REMINDER_CARRY_OVER_DAYS` and never after the
 * date it is about; a held reminder no longer due is `lapsed` (dropped, its
 * request withdrawn, nothing sent) and planned again only if it becomes due
 * again. Every other status is final. A `due` reminder is not sent on a day a
 * carried-over `before_due` already went out to the same decider.
 *
 * Hand-offs: after a response, the answers the operator must read — free
 * text outside a hearing entry (an answer outside the offered options),
 * answers with a comment, and a general question — go to the operator as
 * one inbox entry per receipt, ids and counts only.
 */
import { createHash } from 'node:crypto';
import { isOverrideWindowOpen } from './effective.js';
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
  /**
   * A held (`approval_pending`) `before_due` / `due` reminder planned after
   * its send day: the approval came after that day's sweep.
   */
  carried_over?: true;
  /** The decider's valid invites (ids only). */
  invite_ids: string[];
  /**
   * The fixed template and its parameters: the agenda title and the date
   * (for `override_closing` the closing moment in the agenda's display zone:
   * `date`, `time`, `zone`).
   */
  template: { id: string; params: Record<string, string>; locale: 'ja' | 'en' };
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

/**
 * The display zone of an agenda's customer-facing times: Japan time for a
 * `ja` agenda, UTC otherwise (the agenda carries no time zone of its own).
 */
const DISPLAY_ZONES: Readonly<Record<'ja' | 'en', { zone: 'JST' | 'UTC'; offsetMs: number }>> = {
  ja: { zone: 'JST', offsetMs: 9 * 60 * 60 * 1000 },
  en: { zone: 'UTC', offsetMs: 0 },
};

export function agendaDisplayZone(locale: 'ja' | 'en'): { zone: 'JST' | 'UTC'; offsetMs: number } {
  return DISPLAY_ZONES[locale] ?? DISPLAY_ZONES.en;
}

/** A closing moment as the customer reads it: local date, `HH:MM` and the zone label. */
export function displayClosingMoment(
  at: string,
  locale: 'ja' | 'en'
): { date: string; time: string; zone: string } | null {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return null;
  const { zone, offsetMs } = agendaDisplayZone(locale);
  const local = new Date(ms + offsetMs).toISOString();
  return { date: local.slice(0, 10), time: local.slice(11, 16), zone };
}

function plan(
  agenda: DecisionAgenda,
  kind: AgendaReminderKind,
  actorId: string,
  targetDate: string,
  sendOn: string,
  inviteIds: string[],
  closingAt?: string
): PlannedReminder {
  const closing = closingAt ? displayClosingMoment(closingAt, agenda.locale) : null;
  return {
    reminder_id: reminderId(agenda.agenda_id, actorId, kind, targetDate),
    kind,
    actor_id: actorId,
    target_date: targetDate,
    send_on: sendOn,
    invite_ids: [...inviteIds].sort(),
    template: {
      id: REMINDER_TEMPLATE_IDS[kind],
      params: closing
        ? { title: agenda.title, date: closing.date, time: closing.time, zone: closing.zone }
        : { title: agenda.title, date: targetDate },
      locale: agenda.locale,
    },
  };
}

/**
 * Has this decider answered every entry still open to an answer (override
 * window open at `now`) in the current approved revision? Receipts of any of
 * the actor's invites count together; an answer counts when it is a decision
 * (`decided` / `unchanged` / `change_request`), not a comment-only opinion
 * and not a general question alone. With nothing open, there is nothing to
 * remind about.
 */
export function hasAnsweredAll(
  agenda: DecisionAgenda,
  receipts: readonly DecisionReceipt[],
  actorId: string,
  contentHash: string,
  now: string
): boolean {
  const open = agenda.entries
    .filter((entry) => isOverrideWindowOpen(entry, now, agenda.milestones_passed ?? []))
    .map((entry) => entry.entry_id);
  const answered = new Set<string>();
  for (const receipt of receipts) {
    if (
      receipt.agenda_id !== agenda.agenda_id ||
      receipt.content_hash !== contentHash ||
      receipt.participant.role !== 'decider' ||
      receipt.participant.actor_id !== actorId
    )
      continue;
    for (const answer of receipt.answers) {
      if (answer.outcome !== undefined && answer.outcome === 'opinion') continue;
      if (answer.outcome === undefined && answer.choice === 'free_text') continue;
      answered.add(answer.entry_id);
    }
  }
  return open.every((entryId) => answered.has(entryId));
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
  // Sent (or re-approved after an edit: status `approved`, invites still
  // out) and answerable in its current revision.
  if (!today || agendaAnswerState(agenda).ok === false) return [];
  const deciders = validDeciders(agenda, input.invites, nowMs);
  if (deciders.size === 0) return [];
  const hash = agendaContentHash(agenda);
  const reminders: PlannedReminder[] = [];

  if (agenda.respond_by && isCalendarDate(agenda.respond_by)) {
    for (const [actorId, inviteIds] of deciders) {
      if (hasAnsweredAll(agenda, input.receipts, actorId, hash, now)) continue;
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
  // UTC deadline date → the earliest closing moment on that date (shown to the customer).
  const deadlines = new Map<string, string>();
  for (const entry of agenda.entries) {
    const until = entry.override_until;
    if (!until || until.kind !== 'date') continue;
    const deadlineMs = Date.parse(until.at);
    // Closed already: nothing left to change.
    if (!Number.isFinite(deadlineMs) || nowMs >= deadlineMs) continue;
    const layer = effective.get(entry.entry_id)?.layer;
    if (layer !== 'ours' && layer !== 'org_default') continue;
    const date = utcDate(until.at);
    if (!date) continue;
    const earlier = deadlines.get(date);
    if (!earlier || Date.parse(until.at) < Date.parse(earlier)) deadlines.set(date, until.at);
  }
  for (const [date, closingAt] of [...deadlines].sort(([a], [b]) => a.localeCompare(b))) {
    for (const [actorId, inviteIds] of deciders) {
      reminders.push(
        plan(agenda, 'override_closing', actorId, date, addUtcDays(date, -2), inviteIds, closingAt)
      );
    }
  }
  return reminders;
}

/**
 * How many days after its send day a held `before_due` / `due` reminder may
 * still go out once approved — and never after the date it is about (so in
 * practice a `before_due` on the due day; a `due` never: its text says
 * "today"). Older ones lapse instead of being sent.
 */
export const REMINDER_CARRY_OVER_DAYS = 1;

/** Recorded with a final status (anything but `approval_pending` or `lapsed`). */
function isSettled(reminder: PlannedReminder, records: readonly AgendaReminderRecord[]): boolean {
  return records.some(
    (record) =>
      record.reminder_id === reminder.reminder_id &&
      record.status !== 'approval_pending' &&
      record.status !== 'lapsed'
  );
}

function isHeld(reminder: PlannedReminder, records: readonly AgendaReminderRecord[]): boolean {
  return records.some(
    (record) => record.reminder_id === reminder.reminder_id && record.status === 'approval_pending'
  );
}

/** A held reminder planned after its send day, within the carry-over limit. */
function isCarriedOver(
  reminder: PlannedReminder,
  records: readonly AgendaReminderRecord[],
  today: string
): boolean {
  return (
    reminder.send_on < today &&
    today <= reminder.target_date &&
    today <= addUtcDays(reminder.send_on, REMINDER_CARRY_OVER_DAYS) &&
    isHeld(reminder, records)
  );
}

/**
 * One message a day per decider and respond-by date: a `due` whose decider
 * already got that date's `before_due` on (or after) the date — a carried-over
 * one — and a `before_due` (only ever carried over, on the date) whose
 * decider already got that date's `due`, whichever approval came first.
 */
export function isCoveredByEarlierReminder(
  reminder: Pick<PlannedReminder, 'kind' | 'actor_id' | 'target_date'>,
  records: readonly AgendaReminderRecord[]
): boolean {
  if (reminder.kind === 'override_closing') return false;
  const other = reminder.kind === 'due' ? 'before_due' : 'due';
  return records.some(
    (record) =>
      record.kind === other &&
      record.status === 'sent' &&
      record.actor_id === reminder.actor_id &&
      record.target_date === reminder.target_date &&
      (utcDate(record.at) ?? '') >= reminder.target_date
  );
}

/**
 * The reminders due at `now` that are not settled yet: `before_due` and
 * `due` on their exact day (or a held one carried over, see
 * `REMINDER_CARRY_OVER_DAYS`), `override_closing` from two days before the
 * deadline while the window is open. Sorted for a stable sweep.
 */
export function dueAgendaReminders(input: ReminderPlanInput): PlannedReminder[] {
  const today = utcDate(input.now);
  if (!today) return [];
  const records = input.agenda.reminders ?? [];
  const due: PlannedReminder[] = [];
  for (const reminder of scheduleAgendaReminders(input)) {
    if (isSettled(reminder, records) || isCoveredByEarlierReminder(reminder, records)) continue;
    if (reminder.kind === 'override_closing') {
      if (reminder.send_on <= today) due.push(reminder);
    } else if (reminder.send_on === today) due.push(reminder);
    else if (isCarriedOver(reminder, records, today)) due.push({ ...reminder, carried_over: true });
  }
  return due.sort((a, b) => a.reminder_id.localeCompare(b.reminder_id));
}

/**
 * The held (`approval_pending`) records not due at `now` any more — the send
 * day and carry-over passed, the decider answered, the agenda was closed or
 * changed, the invites lapsed, a carried-over `before_due` covered the `due`:
 * the sweep withdraws their requests and records them `lapsed`, never sends them.
 */
export function lapsedAgendaReminders(input: ReminderPlanInput): AgendaReminderRecord[] {
  if (!utcDate(input.now)) return [];
  const due = new Set(dueAgendaReminders(input).map((reminder) => reminder.reminder_id));
  return (input.agenda.reminders ?? [])
    .filter((record) => record.status === 'approval_pending' && !due.has(record.reminder_id))
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
