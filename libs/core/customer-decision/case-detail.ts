/**
 * CD-12 drill-down: one case of a tenant's customer decisions, for the
 * Chronos case / agenda views (`customer-decision overview --case <c>
 * --detail`). Pure: no I/O, no clock — the facade reads the stores and
 * passes them with `now`, exactly as for {@link buildCaseOverview}.
 *
 * The JSON is {@link CustomerDecisionCaseDetail}. It carries ids, statuses,
 * dates and counts, the agenda titles and each entry question cut to
 * {@link CASE_DETAIL_QUESTION_MAX} characters. It never carries a decision
 * value, our decision or the organization default value, a rationale,
 * background or option, who decided, the customer's free text (comments,
 * general questions, off-option answers), a task proposal's question,
 * options or rationale, a participant name or actor id, or the agenda's
 * `from`: every field below is copied one by one, never spread from a
 * store record.
 */
import { truncateNormalizedText } from '../foundation/text.js';
import { pendingTaskProposals, taskProposalHolds, taskProposalsOf } from './consumption.js';
import { resolveAgendaEffective } from './effective.js';
import type { CustomerDecisionInvite } from './invite.js';
import type { DecisionAgenda, AgendaReminderRecord, BoltReviewRouting } from './model.js';
import {
  buildCaseOverview,
  buildCustomerDecisionOverview,
  type AgendaOverview,
  type CaseOverview,
  type CaseOverviewInput,
  type OverviewAttentionItem,
  type OverviewEntry,
} from './overview.js';
import { handoffTargets, isHandoffDone, upcomingAgendaReminders, utcDate } from './reminders.js';
import { openChangeRequests } from './respond.js';
import type { ConsumedDecisionLockRecord } from './store.js';

export const CUSTOMER_DECISION_CASE_DETAIL_VERSION = '1.0.0';
/** Entry questions are cut to this many characters (whitespace normalized). */
export const CASE_DETAIL_QUESTION_MAX = 200;
/** Entries kept per agenda (`entries_total` is the full count). */
export const CASE_DETAIL_ENTRY_LIMIT = 200;
/** Records kept per list (change requests, hand-offs, reminders, routing, proposals, rework ids). */
export const CASE_DETAIL_RECORD_LIMIT = 100;
/** Tasks (consumer locks) kept per case (`tasks_total` is the full count). */
export const CASE_DETAIL_TASK_LIMIT = 200;

export interface CaseDetailEntry extends OverviewEntry {
  /** The ledger decision the entry resolves to now (absent when undecided). */
  decision_id?: string;
  /** The operator confirmed exactly that decision (CD-08). */
  operator_confirmed: boolean;
  attachment_count: number;
  link_count: number;
}

export interface CaseDetailChangeRequest {
  receipt_id: string;
  entry_id: string;
  at: string;
}

export interface CaseDetailHandoff {
  receipt_id: string;
  off_option: number;
  comments: number;
  general_question: boolean;
  inbox_entry_id?: string;
  /** The operator notification was accepted (`notified_at` is set). */
  notified: boolean;
  /** Nothing left to hand off for the receipt ({@link isHandoffDone}). */
  done: boolean;
  /** When it was handed off, else when the receipt was submitted. */
  at: string;
}

export interface CaseDetailReminderRecord {
  reminder_id: string;
  kind: AgendaReminderRecord['kind'];
  target_date: string;
  status: AgendaReminderRecord['status'];
  reason?: NonNullable<AgendaReminderRecord['reason']>;
  approval_request_id?: string;
  at: string;
}

export interface CaseDetailUpcomingReminder {
  kind: AgendaReminderRecord['kind'];
  send_on: string;
  target_date: string;
}

export interface CaseDetailBoltRouting {
  entry_id: string;
  outcome: BoltReviewRouting['outcome'];
  work_item_id?: string;
  notified: boolean;
  at: string;
}

export interface CaseDetailAgenda extends Omit<AgendaOverview, 'entries' | 'reminders'> {
  entries: CaseDetailEntry[];
  entries_total: number;
  change_requests: CaseDetailChangeRequest[];
  change_requests_total: number;
  handoffs: CaseDetailHandoff[];
  handoffs_total: number;
  /** The overview's reminder counts, with the records and the upcoming list (`upcoming_total` is the overview's `upcoming` count). */
  reminders: Omit<AgendaOverview['reminders'], 'upcoming'> & {
    records: CaseDetailReminderRecord[];
    records_total: number;
    upcoming: CaseDetailUpcomingReminder[];
    upcoming_total: number;
  };
  /** Invites of this agenda, counts only (deciders / contributors: active invites per role). */
  invites: {
    active: number;
    expired: number;
    revoked: number;
    deciders: number;
    contributors: number;
  };
  bolt_routing: CaseDetailBoltRouting[];
  bolt_routing_total: number;
  approval?: { approved_at: string; approved_by_type?: 'human' | 'ai_agent' | 'service' };
}

export interface CaseDetailTaskProposal {
  proposal_id: string;
  requires_customer: boolean;
  collected: boolean;
  agenda_id?: string;
  entry_id?: string;
  resolved_decision_id?: string;
  unresolvable?: true;
}

export interface CaseDetailTask {
  consumer: string;
  mission_id: string;
  task_id: string;
  status: ConsumedDecisionLockRecord['status'];
  hold?: { work_item_id?: string; at: string; resolved_at?: string };
  proposals: CaseDetailTaskProposal[];
  proposals_total: number;
  rework: { count: number; work_item_ids: string[] };
}

/**
 * `customer-decision overview --case <c> --detail --json` (CD-12 drill-down).
 * Stable contract of the Chronos case / agenda views; add fields, never
 * rename or repurpose them.
 */
export interface CustomerDecisionCaseDetail {
  version: typeof CUSTOMER_DECISION_CASE_DETAIL_VERSION;
  tenant_slug: string;
  case_id: string;
  generated_at: string;
  /** Today's UTC date: the base of every `days` field. */
  today: string;
  draft_only: boolean;
  /** The case's task counts, as on the overview (`CaseOverview.tasks`). */
  task_counts: CaseOverview['tasks'];
  /** The case's attention items, as on the overview (same order). */
  attention: OverviewAttentionItem[];
  agendas: CaseDetailAgenda[];
  /** Sorted by mission id, then task id. */
  tasks: CaseDetailTask[];
  tasks_total: number;
}

function capped<T>(items: readonly T[], limit: number): { list: T[]; total: number } {
  return { list: items.slice(0, limit), total: items.length };
}

function inviteCounts(
  invites: readonly CustomerDecisionInvite[],
  nowMs: number
): CaseDetailAgenda['invites'] {
  const counts = { active: 0, expired: 0, revoked: 0, deciders: 0, contributors: 0 };
  for (const invite of invites) {
    if (invite.revoked_at) {
      counts.revoked += 1;
      continue;
    }
    const expires = Date.parse(invite.expires_at);
    if (!Number.isFinite(expires) || nowMs >= expires) {
      counts.expired += 1;
      continue;
    }
    counts.active += 1;
    if (invite.participant.role === 'decider') counts.deciders += 1;
    else counts.contributors += 1;
  }
  return counts;
}

function agendaDetail(
  overview: AgendaOverview,
  agenda: DecisionAgenda,
  input: CaseOverviewInput
): CaseDetailAgenda {
  const { entries: overviewEntries = [], reminders, ...summary } = overview;
  const effective = resolveAgendaEffective(agenda, input.ledger, { now: input.now });
  const byEntry = new Map(effective.map((decision) => [decision.entry_id, decision]));
  const sources = new Map(agenda.entries.map((entry) => [entry.entry_id, entry]));
  const confirmations = agenda.operator_confirmations ?? [];
  const receipts = input.receipts.filter((receipt) => receipt.agenda_id === agenda.agenda_id);
  const invites = input.invites.filter(
    (invite) => invite.agenda_id === agenda.agenda_id && invite.case_id === agenda.case_id
  );

  const entries = capped(overviewEntries, CASE_DETAIL_ENTRY_LIMIT);
  const detailEntries: CaseDetailEntry[] = entries.list.map((entry) => {
    const decisionId = byEntry.get(entry.entry_id)?.decision_id;
    const source = sources.get(entry.entry_id);
    return {
      entry_id: entry.entry_id,
      item: entry.item,
      key: entry.key,
      kind: entry.kind,
      question: truncateNormalizedText(entry.question, CASE_DETAIL_QUESTION_MAX),
      status: entry.status,
      layer: entry.layer,
      requires_customer: entry.requires_customer,
      overridable: entry.overridable,
      ...(entry.override_until_at ? { override_until_at: entry.override_until_at } : {}),
      ...(decisionId ? { decision_id: decisionId } : {}),
      operator_confirmed:
        decisionId !== undefined &&
        confirmations.some(
          (item) => item.entry_id === entry.entry_id && item.decision_id === decisionId
        ),
      attachment_count: source?.attachments?.length ?? 0,
      link_count: source?.links?.length ?? 0,
    };
  });

  const changes = capped(
    openChangeRequests(agenda, receipts, effective).map((item) => ({
      receipt_id: item.receipt_id,
      entry_id: item.entry_id,
      at: item.at,
    })),
    CASE_DETAIL_RECORD_LIMIT
  );

  const records = agenda.handoffs ?? [];
  const submitted = new Map(receipts.map((receipt) => [receipt.receipt_id, receipt.submitted_at]));
  const handoffs = capped(
    handoffTargets(agenda, receipts).map((target): CaseDetailHandoff => {
      const record = records.find((item) => item.receipt_id === target.receipt_id);
      return {
        receipt_id: target.receipt_id,
        off_option: target.off_option,
        comments: target.comments,
        general_question: target.general_question > 0,
        ...(record?.inbox_entry_id ? { inbox_entry_id: record.inbox_entry_id } : {}),
        notified: Boolean(record?.notified_at),
        done: isHandoffDone(target, records),
        at: record?.at ?? submitted.get(target.receipt_id) ?? '',
      };
    }),
    CASE_DETAIL_RECORD_LIMIT
  );

  const reminderRecords = capped(
    (agenda.reminders ?? []).map((record): CaseDetailReminderRecord => ({
      reminder_id: record.reminder_id,
      kind: record.kind,
      target_date: record.target_date,
      status: record.status,
      ...(record.reason ? { reason: record.reason } : {}),
      ...(record.approval_request_id ? { approval_request_id: record.approval_request_id } : {}),
      at: record.at,
    })),
    CASE_DETAIL_RECORD_LIMIT
  );
  const upcoming = capped(
    upcomingAgendaReminders({ agenda, invites, receipts, effective, now: input.now }).map(
      (reminder): CaseDetailUpcomingReminder => ({
        kind: reminder.kind,
        send_on: reminder.send_on,
        target_date: reminder.target_date,
      })
    ),
    CASE_DETAIL_RECORD_LIMIT
  );

  const routing = capped(
    (agenda.bolt_routing ?? []).map((item): CaseDetailBoltRouting => ({
      entry_id: item.entry_id,
      outcome: item.outcome,
      ...(item.work_item_id ? { work_item_id: item.work_item_id } : {}),
      notified: Boolean(item.notified_at),
      at: item.at,
    })),
    CASE_DETAIL_RECORD_LIMIT
  );

  return {
    ...summary,
    entries: detailEntries,
    entries_total: entries.total,
    change_requests: changes.list,
    change_requests_total: changes.total,
    handoffs: handoffs.list,
    handoffs_total: handoffs.total,
    reminders: {
      due: reminders.due,
      next_send_on: reminders.next_send_on,
      pending_approval: reminders.pending_approval,
      manual: reminders.manual,
      records: reminderRecords.list,
      records_total: reminderRecords.total,
      upcoming: upcoming.list,
      upcoming_total: upcoming.total,
    },
    invites: inviteCounts(invites, Date.parse(input.now)),
    bolt_routing: routing.list,
    bolt_routing_total: routing.total,
    ...(agenda.approval
      ? {
          approval: {
            approved_at: agenda.approval.approved_at,
            ...(agenda.approval.approved_by_type
              ? { approved_by_type: agenda.approval.approved_by_type }
              : {}),
          },
        }
      : {}),
  };
}

function taskDetail(lock: ConsumedDecisionLockRecord, input: CaseOverviewInput): CaseDetailTask {
  const holds = new Map(
    taskProposalHolds(lock, input.agendas, input.ledger, input.now).map((hold) => [
      hold.proposal_id,
      hold,
    ])
  );
  const pending = new Set(pendingTaskProposals(lock).map((entry) => entry.proposal.proposal_id));
  const proposals = capped(
    taskProposalsOf(lock).map((entry): CaseDetailTaskProposal => {
      const hold = holds.get(entry.proposal.proposal_id);
      return {
        proposal_id: entry.proposal.proposal_id,
        requires_customer: entry.proposal.requires_customer,
        collected: !pending.has(entry.proposal.proposal_id),
        ...(entry.agenda_id ? { agenda_id: entry.agenda_id } : {}),
        ...(entry.entry_id ? { entry_id: entry.entry_id } : {}),
        ...(hold?.resolved_decision_id ? { resolved_decision_id: hold.resolved_decision_id } : {}),
        ...(hold?.unresolvable ? { unresolvable: true as const } : {}),
      };
    }),
    CASE_DETAIL_RECORD_LIMIT
  );
  const rework = lock.rework ?? [];
  return {
    consumer: lock.consumer,
    mission_id: lock.mission_id,
    task_id: lock.task_id,
    status: lock.status,
    ...(lock.hold
      ? {
          hold: {
            ...(lock.hold.work_item_id ? { work_item_id: lock.hold.work_item_id } : {}),
            at: lock.hold.at,
            ...(lock.hold.resolved_at ? { resolved_at: lock.hold.resolved_at } : {}),
          },
        }
      : {}),
    proposals: proposals.list,
    proposals_total: proposals.total,
    rework: {
      count: rework.length,
      work_item_ids: rework.slice(0, CASE_DETAIL_RECORD_LIMIT).map((item) => item.work_item_id),
    },
  };
}

/** One case in full for the drill-down views (see the file header for what is never emitted). */
export function buildCustomerDecisionCaseDetail(
  input: CaseOverviewInput & { tenant_slug: string }
): CustomerDecisionCaseDetail {
  const today = utcDate(input.now);
  if (!today) throw new Error('[CUSTOMER_DECISION_OVERVIEW_NOW_INVALID] now is not a timestamp');
  const overview = buildCaseOverview(input);
  const { attention } = buildCustomerDecisionOverview({
    tenant_slug: input.tenant_slug,
    cases: [overview],
    now: input.now,
  });
  const agendas = new Map(input.agendas.map((agenda) => [agenda.agenda_id, agenda]));
  const tasks = capped(
    [...input.consumers].sort(
      (a, b) =>
        a.mission_id.localeCompare(b.mission_id) ||
        a.task_id.localeCompare(b.task_id) ||
        a.consumer.localeCompare(b.consumer)
    ),
    CASE_DETAIL_TASK_LIMIT
  );
  return {
    version: CUSTOMER_DECISION_CASE_DETAIL_VERSION,
    tenant_slug: input.tenant_slug,
    case_id: input.case_id,
    generated_at: input.now,
    today,
    draft_only: overview.draft_only,
    task_counts: { ...overview.tasks },
    attention,
    agendas: overview.agendas.flatMap((item) => {
      const agenda = agendas.get(item.agenda_id);
      return agenda ? [agendaDetail(item, agenda, input)] : [];
    }),
    tasks: tasks.list.map((lock) => taskDetail(lock, input)),
    tasks_total: tasks.total,
  };
}
