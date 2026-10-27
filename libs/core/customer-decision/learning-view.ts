/**
 * CD-12 drill-down: the operator's view of a tenant learning report
 * (`customer-decision overview --learning [--date <d>]`, the Chronos
 * learning panel). Pure: the facade reads the report and its dates.
 *
 * The JSON is {@link CustomerDecisionLearningView}: the report's counts,
 * subjects (item × key, template entry), suggestions and candidate ids. It
 * drops every value the report carries — the proposed / customer / requested
 * option values and the current and suggested organization defaults — so a
 * `change_org_default` suggestion only says a default change is suggested
 * (`has_suggested_default`); the operator reviews the candidate itself with
 * `pnpm organization learning transition`. Every field is copied one by one.
 */
import {
  DEFAULT_LEARNING_THRESHOLDS,
  type AgendaQuestionStat,
  type ChangeRequestStat,
  type CustomerDecisionLearningReport,
  type LearningCandidateOutcome,
  type LearningSubject,
  type LearningSuggestionKind,
  type LearningThresholds,
  type OverturnStat,
  type QuestionStat,
} from './learning.js';

export const CUSTOMER_DECISION_LEARNING_VIEW_VERSION = '1.0.0';
/** Report dates listed in the view (the most recent ones). */
export const LEARNING_VIEW_DATE_LIMIT = 12;

export interface LearningViewSuggestion extends LearningSubject {
  suggestion_key: string;
  kind: LearningSuggestionKind;
  evidence: { samples: number; count: number; rate?: number };
  learning_id: string;
  candidate?: LearningCandidateOutcome;
  /** `change_org_default`: a default change is suggested (the value is not shown). */
  has_suggested_default: boolean;
}

export interface LearningViewOverturn extends LearningSubject {
  /** Which report table the row comes from (`overturn_by_template_entry` / `overturn_by_item_key`). */
  scope: 'template_entry' | 'item_key';
  from_layer: OverturnStat['from_layer'];
  decided: number;
  overturned: number;
  kept: number;
  overturn_rate: number;
  /** Overturns to a value outside the offered options (a count). */
  other_values: number;
}

export type LearningViewQuestion = QuestionStat;
export type LearningViewAgendaQuestion = AgendaQuestionStat;
export type LearningViewChangeRequest = Omit<ChangeRequestStat, 'requested_values'>;

/**
 * `customer-decision overview --learning --json`. Stable contract of the
 * Chronos learning panel; add fields, never rename or repurpose them.
 */
export interface CustomerDecisionLearningView {
  version: typeof CUSTOMER_DECISION_LEARNING_VIEW_VERSION;
  tenant_slug: string;
  /** The report shown; null when the tenant has none yet. */
  report_date: string | null;
  /** The last {@link LEARNING_VIEW_DATE_LIMIT} report dates, oldest first. */
  available_dates: string[];
  /** When the report was written; null when there is none. */
  generated_at: string | null;
  since: string | null;
  /** The report's thresholds (the defaults when there is no report). */
  thresholds: LearningThresholds;
  metrics: { cases: number; agendas: number; receipts: number; switches: number };
  suggestions: LearningViewSuggestion[];
  /** Template-entry rows first, then item × key rows (each in report order). */
  overturns: LearningViewOverturn[];
  /** Per entry (`questions_by_entry`). */
  questions: LearningViewQuestion[];
  /** Per agenda (`questions_by_agenda`). */
  agenda_questions: LearningViewAgendaQuestion[];
  change_requests: LearningViewChangeRequest[];
}

function subject(item: LearningSubject): LearningSubject {
  return {
    item: item.item,
    key: item.key,
    template_id: item.template_id,
    entry_id: item.entry_id,
  };
}

function lastDates(dates: readonly string[]): string[] {
  return [...dates].sort().slice(-LEARNING_VIEW_DATE_LIMIT);
}

function overturn(stat: OverturnStat, scope: LearningViewOverturn['scope']): LearningViewOverturn {
  return {
    ...subject(stat),
    scope,
    from_layer: stat.from_layer,
    decided: stat.decided,
    overturned: stat.overturned,
    kept: stat.kept,
    overturn_rate: stat.overturn_rate,
    other_values: stat.other_values,
  };
}

/** The view of one report; `availableDates` are the tenant's report dates (any order). */
export function projectLearningReport(
  report: CustomerDecisionLearningReport,
  availableDates: readonly string[]
): CustomerDecisionLearningView {
  const { metrics } = report;
  return {
    version: CUSTOMER_DECISION_LEARNING_VIEW_VERSION,
    tenant_slug: report.tenant_slug,
    report_date: report.report_date,
    available_dates: lastDates(availableDates),
    generated_at: report.generated_at,
    since: report.since,
    thresholds: { ...report.thresholds },
    metrics: {
      cases: metrics.cases,
      agendas: metrics.agendas,
      receipts: metrics.receipts,
      switches: metrics.switches,
    },
    suggestions: report.suggestions.map((item) => ({
      ...subject(item),
      suggestion_key: item.suggestion_key,
      kind: item.kind,
      evidence: {
        samples: item.evidence.samples,
        count: item.evidence.count,
        ...(item.evidence.rate !== undefined ? { rate: item.evidence.rate } : {}),
      },
      learning_id: item.learning_id,
      ...(item.candidate ? { candidate: item.candidate } : {}),
      has_suggested_default: item.suggested_org_default !== undefined,
    })),
    overturns: [
      ...metrics.overturn_by_template_entry.map((stat) => overturn(stat, 'template_entry')),
      ...metrics.overturn_by_item_key.map((stat) => overturn(stat, 'item_key')),
    ],
    questions: metrics.questions_by_entry.map((stat) => ({
      ...subject(stat),
      agendas: stat.agendas,
      off_option: stat.off_option,
      comments: stat.comments,
    })),
    agenda_questions: metrics.questions_by_agenda.map((stat) => ({
      case_id: stat.case_id,
      agenda_id: stat.agenda_id,
      receipts: stat.receipts,
      general_questions: stat.general_questions,
    })),
    change_requests: metrics.change_requests_by_entry.map((stat) => ({
      ...subject(stat),
      kind: stat.kind,
      answers: stat.answers,
      change_requests: stat.change_requests,
      request_changes: stat.request_changes,
      reject: stat.reject,
      rate: stat.rate,
    })),
  };
}

/** The view when the tenant has no report yet (`report_date: null`). */
export function emptyLearningView(
  tenantSlug: string,
  availableDates: readonly string[] = []
): CustomerDecisionLearningView {
  return {
    version: CUSTOMER_DECISION_LEARNING_VIEW_VERSION,
    tenant_slug: tenantSlug,
    report_date: null,
    available_dates: lastDates(availableDates),
    generated_at: null,
    since: null,
    thresholds: { ...DEFAULT_LEARNING_THRESHOLDS },
    metrics: { cases: 0, agendas: 0, receipts: 0, switches: 0 },
    suggestions: [],
    overturns: [],
    questions: [],
    agenda_questions: [],
    change_requests: [],
  };
}
