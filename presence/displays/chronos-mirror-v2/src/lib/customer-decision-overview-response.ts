/**
 * CD-12: the Chronos projection of the `CustomerDecisionOverview` contract
 * (`libs/core/customer-decision/overview.ts`, version 1.0.0) printed by the
 * tenant-bound facade child (`customer-decision overview --json`).
 *
 * Import-free on purpose: the server route validates the child's stdout with
 * it and the browser card validates the route's response with it. The parser
 * rebuilds every object from the fields it knows, so anything the contract
 * may gain later (or anything unexpected) never reaches the browser. Entry
 * rows are dropped: the card shows counts and dates, never questions,
 * decision values or the customer's free text. (Its only import is the
 * import-free field readers it shares with the drill-down parsers.)
 */
import {
  count,
  days,
  flag,
  InvalidCustomerDecisionValue,
  lengthOf,
  list,
  nullableText,
  oneOf,
  optionalText,
  record,
  text,
  type JsonRecord,
} from './customer-decision-parse';

export const SUPPORTED_CUSTOMER_DECISION_OVERVIEW_VERSION = '1.0.0';

export const OVERVIEW_ENTRY_STATUSES = [
  'confirmed',
  'provisional',
  'awaiting_customer',
  'awaiting_operator_confirmation',
  'undecided',
] as const;
export type OverviewEntryStatus = (typeof OVERVIEW_ENTRY_STATUSES)[number];
export type OverviewStatusCounts = Record<OverviewEntryStatus, number>;

export const OVERVIEW_ATTENTION_REASONS = [
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
] as const;
export type OverviewAttentionReason = (typeof OVERVIEW_ATTENTION_REASONS)[number];

export const OVERVIEW_AGENDA_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'sent',
  'closed',
  'withdrawn',
] as const;
export type OverviewAgendaStatus = (typeof OVERVIEW_AGENDA_STATUSES)[number];

export interface OverviewAttentionItemView {
  reason: OverviewAttentionReason;
  case_id: string;
  agenda_id?: string;
  title?: string;
  count: number;
  due?: string;
  days?: number;
}

export interface AgendaOverviewView {
  agenda_id: string;
  title: string;
  customer: string;
  phase: string;
  revision: number;
  status: OverviewAgendaStatus;
  locale: 'ja' | 'en';
  answerable: boolean;
  active_invites: number;
  counts: OverviewStatusCounts;
  unanswered_deciders: number;
  respond_by: string | null;
  respond_by_days: number | null;
  next_override_deadline: { at: string; days: number; entries: number } | null;
  open_change_requests: number;
  pending_handoffs: number;
  reminders: {
    due: number;
    upcoming: number;
    next_send_on: string | null;
    pending_approval: number;
    manual: number;
  };
}

export interface CaseOverviewView {
  case_id: string;
  draft_only: boolean;
  tasks: { pending_proposals: number; held: number; ready_to_resume: number };
  agendas: AgendaOverviewView[];
  /** Agenda sets of the case before truncation. */
  agendas_total: number;
}

export interface CustomerDecisionOverviewView {
  version: typeof SUPPORTED_CUSTOMER_DECISION_OVERVIEW_VERSION;
  tenant_slug: string;
  generated_at: string;
  today: string;
  totals: {
    cases: number;
    agendas: number;
    open_agendas: number;
    entries: number;
    counts: OverviewStatusCounts;
    open_change_requests: number;
    pending_handoffs: number;
    reminders_due: number;
    held_tasks: number;
    pending_task_proposals: number;
    /** Attention items before any cap (`--summary` caps the list at 50). */
    attention_total: number;
  };
  attention: OverviewAttentionItemView[];
  cases: CaseOverviewView[];
  case_failures: Array<{ case_id: string; diagnostic_code: string }>;
}

/**
 * Hard caps: an oversized list is truncated, never rejected, so a large
 * tenant still gets an overview (the totals stay exact; the card says how many
 * more there are and points to the CLI). The facade's `--summary` form
 * already caps `attention` at 50 and reports `totals.attention_total`.
 */
export const OVERVIEW_LIMITS = {
  attention: 50,
  cases: 200,
  agendas_per_case: 100,
  case_failures: 50,
} as const;

export function parseOverviewStatusCounts(value: unknown): OverviewStatusCounts {
  const source = record(value);
  return Object.fromEntries(
    OVERVIEW_ENTRY_STATUSES.map((status) => [status, count(source, status)])
  ) as OverviewStatusCounts;
}

export function parseOverviewAttentionItem(value: unknown): OverviewAttentionItemView {
  const source = record(value);
  const agendaId = optionalText(source, 'agenda_id');
  const title = optionalText(source, 'title');
  const due = optionalText(source, 'due');
  return {
    reason: oneOf(source, 'reason', OVERVIEW_ATTENTION_REASONS),
    case_id: text(source, 'case_id'),
    ...(agendaId ? { agenda_id: agendaId } : {}),
    ...(title ? { title } : {}),
    count: count(source, 'count'),
    ...(due ? { due } : {}),
    ...(source.days === undefined ? {} : { days: days(source.days) }),
  };
}

function agenda(value: unknown): AgendaOverviewView {
  const source = record(value);
  const deadline =
    source.next_override_deadline === null ? null : record(source.next_override_deadline);
  const reminders = record(source.reminders);
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
    reminders: {
      due: count(reminders, 'due'),
      upcoming: count(reminders, 'upcoming'),
      next_send_on: nullableText(reminders, 'next_send_on'),
      pending_approval: count(reminders, 'pending_approval'),
      manual: count(reminders, 'manual'),
    },
  };
}

function caseOverview(value: unknown): CaseOverviewView {
  const source = record(value);
  const tasks = record(source.tasks);
  return {
    case_id: text(source, 'case_id'),
    draft_only: flag(source, 'draft_only'),
    tasks: {
      pending_proposals: count(tasks, 'pending_proposals'),
      held: count(tasks, 'held'),
      ready_to_resume: count(tasks, 'ready_to_resume'),
    },
    agendas: list(source.agendas, agenda, OVERVIEW_LIMITS.agendas_per_case),
    agendas_total: lengthOf(source.agendas),
  };
}

/**
 * The overview as Chronos shows it, or undefined when the value is not a
 * version-1.0.0 overview (of `expectedTenant`, when given).
 */
export function parseCustomerDecisionOverview(
  value: unknown,
  expectedTenant?: string
): CustomerDecisionOverviewView | undefined {
  try {
    const source = record(value);
    if (source.version !== SUPPORTED_CUSTOMER_DECISION_OVERVIEW_VERSION) return undefined;
    const tenant = text(source, 'tenant_slug');
    if (expectedTenant !== undefined && tenant !== expectedTenant) return undefined;
    const totals = record(source.totals);
    return {
      version: SUPPORTED_CUSTOMER_DECISION_OVERVIEW_VERSION,
      tenant_slug: tenant,
      generated_at: text(source, 'generated_at'),
      today: text(source, 'today'),
      totals: {
        cases: count(totals, 'cases'),
        agendas: count(totals, 'agendas'),
        open_agendas: count(totals, 'open_agendas'),
        entries: count(totals, 'entries'),
        counts: parseOverviewStatusCounts(totals.counts),
        open_change_requests: count(totals, 'open_change_requests'),
        pending_handoffs: count(totals, 'pending_handoffs'),
        reminders_due: count(totals, 'reminders_due'),
        held_tasks: count(totals, 'held_tasks'),
        pending_task_proposals: count(totals, 'pending_task_proposals'),
        attention_total:
          totals.attention_total === undefined
            ? lengthOf(source.attention)
            : count(totals, 'attention_total'),
      },
      attention: list(source.attention, parseOverviewAttentionItem, OVERVIEW_LIMITS.attention),
      cases: list(source.cases, caseOverview, OVERVIEW_LIMITS.cases),
      case_failures: list(
        source.case_failures,
        (entry) => {
          const failure = record(entry);
          return {
            case_id: text(failure, 'case_id'),
            diagnostic_code: text(failure, 'diagnostic_code'),
          };
        },
        OVERVIEW_LIMITS.case_failures
      ),
    };
  } catch (error) {
    if (error instanceof InvalidCustomerDecisionValue) return undefined;
    throw error;
  }
}

/** The route's response body: `{ overview }`. */
export function parseCustomerDecisionOverviewResponse(
  value: unknown,
  expectedTenant?: string
): CustomerDecisionOverviewView | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return parseCustomerDecisionOverview((value as JsonRecord).overview, expectedTenant);
}
