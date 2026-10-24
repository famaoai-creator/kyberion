/**
 * CD-12: the read-only operator overview of a tenant's customer decisions
 * (plan docs/developer/improvement-plans-2026-10/CUSTOMER_DECISION_HEARING_PLAN_2026-10-24.ja.md
 * "CD-12 の実装設計"). Pure: no I/O, no clock — the facade
 * (`customer-decision overview`) reads the stores and passes them with `now`.
 *
 * The JSON the facade prints is {@link CustomerDecisionOverview}: the
 * contract the Chronos organization view reads (wave 2). It carries agenda
 * titles and entry questions (the caller is a tenant-scoped operator view)
 * but never decision values or the customer's free text (comments, general
 * questions, off-option answers): only their counts.
 *
 * Status counts: every entry falls in exactly one bucket — a customer
 * decision on a `requires_customer` entry the operator has not confirmed is
 * `awaiting_operator_confirmation` (not `provisional`), so the five counts sum
 * to the entry count.
 */
import type { DecisionRecord } from '../decision-ledger/model.js';
import { resolveAgendaEffective } from './effective.js';
import { agendaContentHash } from './hash.js';
import type { CustomerDecisionInvite } from './invite.js';
import { pendingTaskProposals, taskProposalHolds } from './consumption.js';
import {
  dueAgendaReminders,
  handoffTargets,
  hasAnsweredAll,
  isHandoffDone,
  upcomingAgendaReminders,
  utcDate,
} from './reminders.js';
import { agendaAnswerState, openChangeRequests } from './respond.js';
import type { ConsumedDecisionLockRecord } from './store.js';
import type {
  AgendaStatus,
  DecisionAgenda,
  DecisionLayerName,
  DecisionReceipt,
  EffectiveDecision,
} from './model.js';

export const CUSTOMER_DECISION_OVERVIEW_VERSION = '1.0.0';
/** A respond-by date or override deadline this many days away (or less) needs attention. */
export const OVERVIEW_DUE_SOON_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

export type OverviewEntryStatus =
  | 'confirmed'
  | 'provisional'
  | 'awaiting_customer'
  | 'awaiting_operator_confirmation'
  | 'undecided';

export type OverviewStatusCounts = Record<OverviewEntryStatus, number>;

/** Why an item is on the attention list, in urgency order (most urgent first). */
export type OverviewAttentionReason =
  | 'respond_by_overdue'
  | 'awaiting_operator_confirmation'
  | 'open_change_requests'
  | 'pending_handoffs'
  | 'override_closing_soon'
  | 'respond_by_due_soon'
  | 'reminders_due'
  | 'held_tasks'
  | 'awaiting_customer'
  | 'pending_task_proposals';

export const OVERVIEW_ATTENTION_ORDER: readonly OverviewAttentionReason[] = [
  'respond_by_overdue',
  'awaiting_operator_confirmation',
  'open_change_requests',
  'pending_handoffs',
  'override_closing_soon',
  'respond_by_due_soon',
  'reminders_due',
  'held_tasks',
  'awaiting_customer',
  'pending_task_proposals',
];

export interface OverviewAttentionItem {
  reason: OverviewAttentionReason;
  case_id: string;
  /** Absent on case-level items (`held_tasks`, `pending_task_proposals`). */
  agenda_id?: string;
  title?: string;
  /** How many entries / receipts / reminders / tasks. */
  count: number;
  /** The date that makes it urgent (`YYYY-MM-DD` respond-by, or the ISO override deadline). */
  due?: string;
  /** Days from today (UTC) to `due`; negative when past. */
  days?: number;
}

export interface OverviewEntry {
  entry_id: string;
  item: string;
  key: string;
  kind: DecisionAgenda['entries'][number]['kind'];
  question: string;
  status: OverviewEntryStatus;
  layer: DecisionLayerName | 'none';
  requires_customer: boolean;
  overridable: boolean;
  /** A date override deadline still ahead (ISO). */
  override_until_at?: string;
}

export interface AgendaOverview {
  case_id: string;
  agenda_id: string;
  title: string;
  customer: string;
  phase: string;
  revision: number;
  status: AgendaStatus;
  locale: 'ja' | 'en';
  /** The customer can answer the current revision (sent and approved as is). */
  answerable: boolean;
  /** Invites to this agenda that are neither revoked nor expired. */
  active_invites: number;
  counts: OverviewStatusCounts;
  respond_by: string | null;
  respond_by_days: number | null;
  /** Deciders with a valid invite who have not answered every open entry yet. */
  unanswered_deciders: number;
  /** The nearest date override deadline still ahead, and how many entries close then. */
  next_override_deadline: { at: string; days: number; entries: number } | null;
  open_change_requests: number;
  /** Receipts with something the operator must read that were not handed off yet. */
  pending_handoffs: number;
  reminders: {
    due: number;
    upcoming: number;
    next_send_on: string | null;
    pending_approval: number;
    manual: number;
  };
  entries: OverviewEntry[];
}

export interface CaseOverview {
  case_id: string;
  agendas: AgendaOverview[];
  /** No agenda of the case has been sent (no invite). */
  draft_only: boolean;
  tasks: {
    /** Customer-judgment proposals of mission tasks not on an agenda yet. */
    pending_proposals: number;
    /** Tasks holding on a requires_customer question with no confirmed answer. */
    held: number;
    /** Held tasks whose every question has a confirmed customer decision (resume the mission). */
    ready_to_resume: number;
  };
}

/**
 * `customer-decision overview --json` (CD-12). Stable contract of the Chronos
 * "customer decisions" card; add fields, never rename or repurpose them.
 */
export interface CustomerDecisionOverview {
  version: typeof CUSTOMER_DECISION_OVERVIEW_VERSION;
  tenant_slug: string;
  generated_at: string;
  /** Today's UTC date: the base of every `days` field. */
  today: string;
  totals: {
    cases: number;
    agendas: number;
    /** Agendas not closed or withdrawn. */
    open_agendas: number;
    /** Entries of agendas that are not withdrawn. */
    entries: number;
    counts: OverviewStatusCounts;
    open_change_requests: number;
    pending_handoffs: number;
    reminders_due: number;
    held_tasks: number;
    pending_task_proposals: number;
  };
  /** Sorted by {@link OVERVIEW_ATTENTION_ORDER}, then `days` (soonest first), then ids. */
  attention: OverviewAttentionItem[];
  cases: CaseOverview[];
  /** Cases that could not be read (diagnostic codes only). */
  case_failures: Array<{ case_id: string; diagnostic_code: string }>;
}

export interface CaseOverviewInput {
  case_id: string;
  agendas: readonly DecisionAgenda[];
  ledger: readonly DecisionRecord[];
  /** Receipts of the case (any agenda). */
  receipts: readonly DecisionReceipt[];
  /** Invites of the case (any agenda). */
  invites: readonly CustomerDecisionInvite[];
  consumers: readonly ConsumedDecisionLockRecord[];
  now: string;
}

export function emptyStatusCounts(): OverviewStatusCounts {
  return {
    confirmed: 0,
    provisional: 0,
    awaiting_customer: 0,
    awaiting_operator_confirmation: 0,
    undecided: 0,
  };
}

function entryStatus(decision: EffectiveDecision): OverviewEntryStatus {
  return decision.awaiting_operator_confirmation
    ? 'awaiting_operator_confirmation'
    : decision.status;
}

function daysBetween(date: string, today: string): number {
  return Math.round(
    (Date.parse(`${date}T00:00:00.000Z`) - Date.parse(`${today}T00:00:00.000Z`)) / DAY_MS
  );
}

function isLive(agenda: Pick<DecisionAgenda, 'status'>): boolean {
  return agenda.status !== 'closed' && agenda.status !== 'withdrawn';
}

function isValidInvite(invite: CustomerDecisionInvite, nowMs: number): boolean {
  const expires = Date.parse(invite.expires_at);
  return !invite.revoked_at && Number.isFinite(expires) && nowMs < expires;
}

function agendaOverview(
  agenda: DecisionAgenda,
  input: CaseOverviewInput,
  today: string
): AgendaOverview {
  const { now } = input;
  const nowMs = Date.parse(now);
  const effective = resolveAgendaEffective(agenda, input.ledger, { now });
  const byEntry = new Map(effective.map((decision) => [decision.entry_id, decision]));
  const receipts = input.receipts.filter((receipt) => receipt.agenda_id === agenda.agenda_id);
  const invites = input.invites.filter(
    (invite) => invite.agenda_id === agenda.agenda_id && invite.case_id === agenda.case_id
  );
  const counts = emptyStatusCounts();
  const entries: OverviewEntry[] = agenda.entries.map((entry) => {
    const decision = byEntry.get(entry.entry_id);
    const status = decision ? entryStatus(decision) : 'undecided';
    counts[status] += 1;
    const until = entry.override_until;
    const openDeadline =
      until?.kind === 'date' &&
      Number.isFinite(Date.parse(until.at)) &&
      nowMs < Date.parse(until.at)
        ? until.at
        : undefined;
    return {
      entry_id: entry.entry_id,
      item: entry.item,
      key: entry.key,
      kind: entry.kind,
      question: entry.question,
      status,
      layer: decision?.layer ?? 'none',
      requires_customer: entry.requires_customer,
      overridable: decision?.overridable ?? true,
      ...(openDeadline ? { override_until_at: openDeadline } : {}),
    };
  });

  // The nearest open date deadline of an entry still on our side (the
  // customer has not decided it): what the override-closing notice is about.
  let next: AgendaOverview['next_override_deadline'] = null;
  for (const entry of entries) {
    if (!entry.override_until_at || (entry.layer !== 'ours' && entry.layer !== 'org_default'))
      continue;
    const date = utcDate(entry.override_until_at);
    if (!date) continue;
    if (!next || Date.parse(entry.override_until_at) < Date.parse(next.at)) {
      next = { at: entry.override_until_at, days: daysBetween(date, today), entries: 0 };
    }
  }
  if (next) {
    const nextDate = utcDate(next.at);
    next.entries = entries.filter(
      (entry) =>
        entry.override_until_at &&
        (entry.layer === 'ours' || entry.layer === 'org_default') &&
        utcDate(entry.override_until_at) === nextDate
    ).length;
  }

  const answerable = agendaAnswerState(agenda).ok;
  const hash = agendaContentHash(agenda);
  const deciders = new Set(
    invites
      .filter((invite) => invite.participant.role === 'decider' && isValidInvite(invite, nowMs))
      .map((invite) => invite.participant.actor_id)
  );
  const unanswered = answerable
    ? [...deciders].filter((actorId) => !hasAnsweredAll(agenda, receipts, actorId, hash, now))
        .length
    : 0;

  const reminderInput = { agenda, invites, receipts, effective, now };
  const upcoming = upcomingAgendaReminders(reminderInput);
  const records = agenda.reminders ?? [];
  const respondBy = agenda.respond_by ?? null;
  return {
    case_id: agenda.case_id,
    agenda_id: agenda.agenda_id,
    title: agenda.title,
    customer: agenda.customer,
    phase: agenda.phase,
    revision: agenda.revision,
    status: agenda.status,
    locale: agenda.locale,
    answerable,
    active_invites: invites.filter((invite) => isValidInvite(invite, nowMs)).length,
    counts,
    respond_by: respondBy,
    respond_by_days: respondBy ? daysBetween(respondBy, today) : null,
    unanswered_deciders: unanswered,
    next_override_deadline: next,
    open_change_requests: openChangeRequests(agenda, receipts, effective).length,
    pending_handoffs: handoffTargets(agenda, receipts).filter(
      (target) => !isHandoffDone(target, agenda.handoffs ?? [])
    ).length,
    reminders: {
      due: dueAgendaReminders(reminderInput).length,
      upcoming: upcoming.length,
      next_send_on: upcoming[0]?.send_on ?? null,
      pending_approval: records.filter((record) => record.status === 'approval_pending').length,
      manual: records.filter((record) => record.status === 'manual').length,
    },
    entries,
  };
}

/** One case: every agenda (drafts, closed and withdrawn included) and its mission tasks. */
export function buildCaseOverview(input: CaseOverviewInput): CaseOverview {
  const today = utcDate(input.now);
  if (!today) throw new Error('[CUSTOMER_DECISION_OVERVIEW_NOW_INVALID] now is not a timestamp');
  const agendas = [...input.agendas]
    .sort((a, b) => a.agenda_id.localeCompare(b.agenda_id))
    .map((agenda) => agendaOverview(agenda, input, today));
  let pendingProposals = 0;
  let held = 0;
  let ready = 0;
  for (const lock of input.consumers) {
    pendingProposals += pendingTaskProposals(lock).length;
    if (!lock.hold || lock.status !== 'in_progress') continue;
    const holds = taskProposalHolds(lock, input.agendas, input.ledger, input.now);
    if (holds.length > 0 && holds.every((hold) => hold.resolved_decision_id)) ready += 1;
    else held += 1;
  }
  return {
    case_id: input.case_id,
    agendas,
    draft_only: input.invites.length === 0,
    tasks: { pending_proposals: pendingProposals, held, ready_to_resume: ready },
  };
}

function attentionFor(agenda: AgendaOverview): OverviewAttentionItem[] {
  if (agenda.status === 'closed' || agenda.status === 'withdrawn') return [];
  const base = { case_id: agenda.case_id, agenda_id: agenda.agenda_id, title: agenda.title };
  const items: OverviewAttentionItem[] = [];
  if (agenda.respond_by && agenda.respond_by_days !== null && agenda.unanswered_deciders > 0) {
    if (agenda.respond_by_days < 0)
      items.push({
        ...base,
        reason: 'respond_by_overdue',
        count: agenda.unanswered_deciders,
        due: agenda.respond_by,
        days: agenda.respond_by_days,
      });
    else if (agenda.respond_by_days <= OVERVIEW_DUE_SOON_DAYS)
      items.push({
        ...base,
        reason: 'respond_by_due_soon',
        count: agenda.unanswered_deciders,
        due: agenda.respond_by,
        days: agenda.respond_by_days,
      });
  }
  const counted: Array<[OverviewAttentionReason, number]> = [
    ['awaiting_operator_confirmation', agenda.counts.awaiting_operator_confirmation],
    ['open_change_requests', agenda.open_change_requests],
    ['pending_handoffs', agenda.pending_handoffs],
    ['reminders_due', agenda.reminders.due],
  ];
  for (const [reason, count] of counted) if (count > 0) items.push({ ...base, reason, count });
  const next = agenda.next_override_deadline;
  if (next && next.days <= OVERVIEW_DUE_SOON_DAYS)
    items.push({
      ...base,
      reason: 'override_closing_soon',
      count: next.entries,
      due: next.at,
      days: next.days,
    });
  if (agenda.counts.awaiting_customer > 0)
    items.push({
      ...base,
      reason: 'awaiting_customer',
      count: agenda.counts.awaiting_customer,
      ...(agenda.respond_by && agenda.respond_by_days !== null
        ? { due: agenda.respond_by, days: agenda.respond_by_days }
        : {}),
    });
  return items;
}

function compareAttention(a: OverviewAttentionItem, b: OverviewAttentionItem): number {
  const rank =
    OVERVIEW_ATTENTION_ORDER.indexOf(a.reason) - OVERVIEW_ATTENTION_ORDER.indexOf(b.reason);
  if (rank !== 0) return rank;
  const da = a.days ?? Number.POSITIVE_INFINITY;
  const db = b.days ?? Number.POSITIVE_INFINITY;
  if (da !== db) return da < db ? -1 : 1;
  return a.case_id.localeCompare(b.case_id) || (a.agenda_id ?? '').localeCompare(b.agenda_id ?? '');
}

/** The tenant summary over its cases (each built with {@link buildCaseOverview}). */
export function buildCustomerDecisionOverview(input: {
  tenant_slug: string;
  cases: readonly CaseOverview[];
  case_failures?: ReadonlyArray<{ case_id: string; diagnostic_code: string }>;
  now: string;
}): CustomerDecisionOverview {
  const today = utcDate(input.now);
  if (!today) throw new Error('[CUSTOMER_DECISION_OVERVIEW_NOW_INVALID] now is not a timestamp');
  const cases = [...input.cases].sort((a, b) => a.case_id.localeCompare(b.case_id));
  const counts = emptyStatusCounts();
  const totals: CustomerDecisionOverview['totals'] = {
    cases: cases.length,
    agendas: 0,
    open_agendas: 0,
    entries: 0,
    counts,
    open_change_requests: 0,
    pending_handoffs: 0,
    reminders_due: 0,
    held_tasks: 0,
    pending_task_proposals: 0,
  };
  const attention: OverviewAttentionItem[] = [];
  for (const item of cases) {
    totals.held_tasks += item.tasks.held;
    totals.pending_task_proposals += item.tasks.pending_proposals;
    if (item.tasks.held > 0)
      attention.push({ reason: 'held_tasks', case_id: item.case_id, count: item.tasks.held });
    if (item.tasks.pending_proposals > 0)
      attention.push({
        reason: 'pending_task_proposals',
        case_id: item.case_id,
        count: item.tasks.pending_proposals,
      });
    for (const agenda of item.agendas) {
      totals.agendas += 1;
      if (isLive(agenda)) totals.open_agendas += 1;
      if (agenda.status !== 'withdrawn') {
        totals.entries += agenda.entries.length;
        for (const key of Object.keys(counts) as OverviewEntryStatus[])
          counts[key] += agenda.counts[key];
      }
      if (isLive(agenda)) {
        totals.open_change_requests += agenda.open_change_requests;
        totals.pending_handoffs += agenda.pending_handoffs;
        totals.reminders_due += agenda.reminders.due;
      }
      attention.push(...attentionFor(agenda));
    }
  }
  return {
    version: CUSTOMER_DECISION_OVERVIEW_VERSION,
    tenant_slug: input.tenant_slug,
    generated_at: input.now,
    today,
    totals,
    attention: attention.sort(compareAttention),
    cases,
    case_failures: [...(input.case_failures ?? [])].sort((a, b) =>
      a.case_id.localeCompare(b.case_id)
    ),
  };
}
