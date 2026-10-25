/**
 * CD-12 drill-down: the Chronos projection of the `CustomerDecisionCaseDetail`
 * contract (`libs/core/customer-decision/case-detail.ts`, version 1.0.0)
 * printed by the tenant-bound facade child
 * (`customer-decision overview --case <c> --detail --json`).
 *
 * Import-free on purpose (its only import is the shared import-free field
 * readers): the server route validates the child's stdout with it and the
 * browser views validate the route's response with it. Every object is
 * rebuilt from the fields listed here, so a decision value, a rationale, an
 * option, a comment, a participant name or anything the contract may gain
 * later never reaches the browser. The entry question is the only free text
 * kept, cut to {@link CASE_QUESTION_MAX} characters.
 */
import {
  anyText,
  count,
  flag,
  InvalidCustomerDecisionValue,
  lengthOf,
  capText,
  list,
  nullableText,
  oneOf,
  optionalOneOf,
  optionalText,
  parseOrUndefined,
  record,
  text,
  totalOf,
  days,
  type JsonRecord,
} from './customer-decision-parse';
import {
  OVERVIEW_AGENDA_STATUSES,
  OVERVIEW_ENTRY_STATUSES,
  parseOverviewAttentionItem,
  parseOverviewStatusCounts,
  type AgendaOverviewView,
  type OverviewAttentionItemView,
  type OverviewEntryStatus,
} from './customer-decision-overview-response';

export const SUPPORTED_CUSTOMER_DECISION_CASE_DETAIL_VERSION = '1.0.0';
/** Entry questions are kept to this many characters (the facade cuts them to 200 too). */
export const CASE_QUESTION_MAX = 200;

/** Same rule as the decision ledger's case id (`CASE_ID_PATTERN`). */
const CASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/u;

export function isCustomerDecisionCaseId(value: string): boolean {
  return CASE_ID_PATTERN.test(value);
}

/** Hard caps (the facade's own caps; `*_total` keeps the full counts). */
export const CASE_DETAIL_LIMITS = {
  agendas: 100,
  entries_per_agenda: 200,
  records: 100,
  tasks: 200,
  attention: 100,
} as const;

export const CASE_ENTRY_KINDS = ['choice', 'approval', 'ranking', 'hearing'] as const;
export const CASE_ENTRY_LAYERS = ['customer', 'ours', 'org_default', 'none'] as const;
export const CASE_REMINDER_KINDS = ['before_due', 'due', 'override_closing'] as const;
export const CASE_REMINDER_STATUSES = [
  'sent',
  'approval_pending',
  'manual',
  'denied',
  'lapsed',
] as const;
export const CASE_REMINDER_REASONS = [
  'no_channel',
  'binding_missing',
  'surface_unsupported',
  'template_refused',
  'approval_unreachable',
] as const;
export const CASE_ROUTING_OUTCOMES = ['request_changes', 'reject'] as const;
export const CASE_TASK_STATUSES = ['in_progress', 'completed'] as const;
export const CASE_APPROVER_TYPES = ['human', 'ai_agent', 'service'] as const;

export interface CaseEntryView {
  entry_id: string;
  item: string;
  key: string;
  kind: (typeof CASE_ENTRY_KINDS)[number];
  /** Cut to {@link CASE_QUESTION_MAX} characters. */
  question: string;
  status: OverviewEntryStatus;
  layer: (typeof CASE_ENTRY_LAYERS)[number];
  requires_customer: boolean;
  overridable: boolean;
  override_until_at?: string;
  decision_id?: string;
  operator_confirmed: boolean;
  attachment_count: number;
  link_count: number;
}

export interface CaseChangeRequestView {
  receipt_id: string;
  entry_id: string;
  at: string;
}

export interface CaseHandoffView {
  receipt_id: string;
  off_option: number;
  comments: number;
  general_question: boolean;
  inbox_entry_id?: string;
  notified: boolean;
  done: boolean;
  at: string;
}

export interface CaseReminderRecordView {
  reminder_id: string;
  kind: (typeof CASE_REMINDER_KINDS)[number];
  target_date: string;
  status: (typeof CASE_REMINDER_STATUSES)[number];
  reason?: (typeof CASE_REMINDER_REASONS)[number];
  approval_request_id?: string;
  at: string;
}

export interface CaseUpcomingReminderView {
  kind: (typeof CASE_REMINDER_KINDS)[number];
  send_on: string;
  target_date: string;
}

export interface CaseBoltRoutingView {
  entry_id: string;
  outcome: (typeof CASE_ROUTING_OUTCOMES)[number];
  work_item_id?: string;
  notified: boolean;
  at: string;
}

export interface CaseAgendaView extends Omit<AgendaOverviewView, 'reminders'> {
  entries: CaseEntryView[];
  entries_total: number;
  change_requests: CaseChangeRequestView[];
  change_requests_total: number;
  handoffs: CaseHandoffView[];
  handoffs_total: number;
  reminders: {
    due: number;
    next_send_on: string | null;
    pending_approval: number;
    manual: number;
    records: CaseReminderRecordView[];
    records_total: number;
    upcoming: CaseUpcomingReminderView[];
    upcoming_total: number;
  };
  invites: {
    active: number;
    expired: number;
    revoked: number;
    deciders: number;
    contributors: number;
  };
  bolt_routing: CaseBoltRoutingView[];
  bolt_routing_total: number;
  approval?: { approved_at: string; approved_by_type?: (typeof CASE_APPROVER_TYPES)[number] };
}

export interface CaseTaskProposalView {
  proposal_id: string;
  requires_customer: boolean;
  collected: boolean;
  agenda_id?: string;
  entry_id?: string;
  resolved_decision_id?: string;
  unresolvable?: true;
}

export interface CaseTaskView {
  consumer: string;
  mission_id: string;
  task_id: string;
  status: (typeof CASE_TASK_STATUSES)[number];
  hold?: { work_item_id?: string; at: string; resolved_at?: string };
  proposals: CaseTaskProposalView[];
  proposals_total: number;
  rework: { count: number; work_item_ids: string[] };
}

export interface CustomerDecisionCaseDetailView {
  version: typeof SUPPORTED_CUSTOMER_DECISION_CASE_DETAIL_VERSION;
  tenant_slug: string;
  case_id: string;
  generated_at: string;
  today: string;
  draft_only: boolean;
  task_counts: { pending_proposals: number; held: number; ready_to_resume: number };
  attention: OverviewAttentionItemView[];
  agendas: CaseAgendaView[];
  /** Agenda sets of the case before truncation. */
  agendas_total: number;
  tasks: CaseTaskView[];
  tasks_total: number;
}

/** `{...(value ? { key: value } : {})}` for an optional text field. */
function optional<K extends string>(source: JsonRecord, key: K): { [P in K]?: string } {
  const value = optionalText(source, key);
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: string };
}

function entry(value: unknown): CaseEntryView {
  const source = record(value);
  return {
    entry_id: text(source, 'entry_id'),
    item: text(source, 'item'),
    key: text(source, 'key'),
    kind: oneOf(source, 'kind', CASE_ENTRY_KINDS),
    question: capText(text(source, 'question'), CASE_QUESTION_MAX),
    status: oneOf(source, 'status', OVERVIEW_ENTRY_STATUSES),
    layer: oneOf(source, 'layer', CASE_ENTRY_LAYERS),
    requires_customer: flag(source, 'requires_customer'),
    overridable: flag(source, 'overridable'),
    ...optional(source, 'override_until_at'),
    ...optional(source, 'decision_id'),
    operator_confirmed: flag(source, 'operator_confirmed'),
    attachment_count: count(source, 'attachment_count'),
    link_count: count(source, 'link_count'),
  };
}

function changeRequest(value: unknown): CaseChangeRequestView {
  const source = record(value);
  return {
    receipt_id: text(source, 'receipt_id'),
    entry_id: text(source, 'entry_id'),
    at: text(source, 'at'),
  };
}

function handoff(value: unknown): CaseHandoffView {
  const source = record(value);
  return {
    receipt_id: text(source, 'receipt_id'),
    off_option: count(source, 'off_option'),
    comments: count(source, 'comments'),
    general_question: flag(source, 'general_question'),
    ...optional(source, 'inbox_entry_id'),
    notified: flag(source, 'notified'),
    done: flag(source, 'done'),
    at: anyText(source, 'at'),
  };
}

function reminderRecord(value: unknown): CaseReminderRecordView {
  const source = record(value);
  const reason = optionalOneOf(source, 'reason', CASE_REMINDER_REASONS);
  return {
    reminder_id: text(source, 'reminder_id'),
    kind: oneOf(source, 'kind', CASE_REMINDER_KINDS),
    target_date: text(source, 'target_date'),
    status: oneOf(source, 'status', CASE_REMINDER_STATUSES),
    ...(reason ? { reason } : {}),
    ...optional(source, 'approval_request_id'),
    at: text(source, 'at'),
  };
}

function upcomingReminder(value: unknown): CaseUpcomingReminderView {
  const source = record(value);
  return {
    kind: oneOf(source, 'kind', CASE_REMINDER_KINDS),
    send_on: text(source, 'send_on'),
    target_date: text(source, 'target_date'),
  };
}

function routing(value: unknown): CaseBoltRoutingView {
  const source = record(value);
  return {
    entry_id: text(source, 'entry_id'),
    outcome: oneOf(source, 'outcome', CASE_ROUTING_OUTCOMES),
    ...optional(source, 'work_item_id'),
    notified: flag(source, 'notified'),
    at: text(source, 'at'),
  };
}

function agenda(value: unknown): CaseAgendaView {
  const source = record(value);
  const deadline =
    source.next_override_deadline === null ? null : record(source.next_override_deadline);
  const reminders = record(source.reminders);
  const invites = record(source.invites);
  const approval = source.approval === undefined ? undefined : record(source.approval);
  const approverType = approval
    ? optionalOneOf(approval, 'approved_by_type', CASE_APPROVER_TYPES)
    : undefined;
  const { records: recordCap } = CASE_DETAIL_LIMITS;
  return {
    agenda_id: text(source, 'agenda_id'),
    title: text(source, 'title'),
    customer: text(source, 'customer'),
    phase: text(source, 'phase'),
    revision: count(source, 'revision'),
    status: oneOf(source, 'status', OVERVIEW_AGENDA_STATUSES),
    locale: oneOf(source, 'locale', ['ja', 'en'] as const),
    answerable: flag(source, 'answerable'),
    active_invites: count(source, 'active_invites'),
    counts: parseOverviewStatusCounts(source.counts),
    unanswered_deciders: count(source, 'unanswered_deciders'),
    respond_by: nullableText(source, 'respond_by'),
    respond_by_days: source.respond_by_days === null ? null : days(source.respond_by_days),
    next_override_deadline: deadline
      ? {
          at: text(deadline, 'at'),
          days: days(deadline.days),
          entries: count(deadline, 'entries'),
        }
      : null,
    open_change_requests: count(source, 'open_change_requests'),
    pending_handoffs: count(source, 'pending_handoffs'),
    entries: list(source.entries, entry, CASE_DETAIL_LIMITS.entries_per_agenda),
    entries_total: totalOf(source, 'entries_total', source.entries),
    change_requests: list(source.change_requests, changeRequest, recordCap),
    change_requests_total: totalOf(source, 'change_requests_total', source.change_requests),
    handoffs: list(source.handoffs, handoff, recordCap),
    handoffs_total: totalOf(source, 'handoffs_total', source.handoffs),
    reminders: {
      due: count(reminders, 'due'),
      next_send_on: nullableText(reminders, 'next_send_on'),
      pending_approval: count(reminders, 'pending_approval'),
      manual: count(reminders, 'manual'),
      records: list(reminders.records, reminderRecord, recordCap),
      records_total: totalOf(reminders, 'records_total', reminders.records),
      upcoming: list(reminders.upcoming, upcomingReminder, recordCap),
      upcoming_total: totalOf(reminders, 'upcoming_total', reminders.upcoming),
    },
    invites: {
      active: count(invites, 'active'),
      expired: count(invites, 'expired'),
      revoked: count(invites, 'revoked'),
      deciders: count(invites, 'deciders'),
      contributors: count(invites, 'contributors'),
    },
    bolt_routing: list(source.bolt_routing, routing, recordCap),
    bolt_routing_total: totalOf(source, 'bolt_routing_total', source.bolt_routing),
    ...(approval
      ? {
          approval: {
            approved_at: text(approval, 'approved_at'),
            ...(approverType ? { approved_by_type: approverType } : {}),
          },
        }
      : {}),
  };
}

function proposal(value: unknown): CaseTaskProposalView {
  const source = record(value);
  if (source.unresolvable !== undefined && source.unresolvable !== true)
    throw new InvalidCustomerDecisionValue();
  return {
    proposal_id: text(source, 'proposal_id'),
    requires_customer: flag(source, 'requires_customer'),
    collected: flag(source, 'collected'),
    ...optional(source, 'agenda_id'),
    ...optional(source, 'entry_id'),
    ...optional(source, 'resolved_decision_id'),
    ...(source.unresolvable === true ? { unresolvable: true as const } : {}),
  };
}

function task(value: unknown): CaseTaskView {
  const source = record(value);
  const hold = source.hold === undefined ? undefined : record(source.hold);
  const rework = record(source.rework);
  return {
    consumer: text(source, 'consumer'),
    mission_id: text(source, 'mission_id'),
    task_id: text(source, 'task_id'),
    status: oneOf(source, 'status', CASE_TASK_STATUSES),
    ...(hold
      ? {
          hold: {
            ...optional(hold, 'work_item_id'),
            at: text(hold, 'at'),
            ...optional(hold, 'resolved_at'),
          },
        }
      : {}),
    proposals: list(source.proposals, proposal, CASE_DETAIL_LIMITS.records),
    proposals_total: totalOf(source, 'proposals_total', source.proposals),
    rework: {
      count: count(rework, 'count'),
      work_item_ids: list(
        rework.work_item_ids,
        (id) => {
          if (typeof id !== 'string' || !id.trim()) throw new InvalidCustomerDecisionValue();
          return id;
        },
        CASE_DETAIL_LIMITS.records
      ),
    },
  };
}

/**
 * The case detail as Chronos shows it, or undefined when the value is not a
 * version-1.0.0 case detail (of `expectedTenant` / `expectedCase`, when given).
 */
export function parseCustomerDecisionCaseDetail(
  value: unknown,
  expectedTenant?: string,
  expectedCase?: string
): CustomerDecisionCaseDetailView | undefined {
  return parseOrUndefined(() => {
    const source = record(value);
    if (source.version !== SUPPORTED_CUSTOMER_DECISION_CASE_DETAIL_VERSION) return undefined;
    const tenant = text(source, 'tenant_slug');
    if (expectedTenant !== undefined && tenant !== expectedTenant) return undefined;
    const caseId = text(source, 'case_id');
    if (expectedCase !== undefined && caseId !== expectedCase) return undefined;
    const taskCounts = record(source.task_counts);
    const agendas = list(source.agendas, agenda, CASE_DETAIL_LIMITS.agendas);
    return {
      version: SUPPORTED_CUSTOMER_DECISION_CASE_DETAIL_VERSION,
      tenant_slug: tenant,
      case_id: caseId,
      generated_at: text(source, 'generated_at'),
      today: text(source, 'today'),
      draft_only: flag(source, 'draft_only'),
      task_counts: {
        pending_proposals: count(taskCounts, 'pending_proposals'),
        held: count(taskCounts, 'held'),
        ready_to_resume: count(taskCounts, 'ready_to_resume'),
      },
      attention: list(source.attention, parseOverviewAttentionItem, CASE_DETAIL_LIMITS.attention),
      agendas,
      // The contract has no agenda total: the length before the cap (kept
      // through the route's re-serialized copy, which carries it).
      agendas_total:
        source.agendas_total === undefined
          ? lengthOf(source.agendas)
          : totalOf(source, 'agendas_total', source.agendas),
      tasks: list(source.tasks, task, CASE_DETAIL_LIMITS.tasks),
      tasks_total: totalOf(source, 'tasks_total', source.tasks),
    };
  });
}

/** The route's response body: `{ case }`. */
export function parseCustomerDecisionCaseResponse(
  value: unknown,
  expectedTenant?: string,
  expectedCase?: string
): CustomerDecisionCaseDetailView | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return parseCustomerDecisionCaseDetail((value as JsonRecord).case, expectedTenant, expectedCase);
}
