/**
 * CD-12 drill-down: the Chronos projection of the `CustomerDecisionLearningView`
 * contract (`libs/core/customer-decision/learning-view.ts`, version 1.0.0)
 * printed by the tenant-bound facade child
 * (`customer-decision overview --learning [--date <d>] --json`).
 *
 * Import-free on purpose (its only import is the shared import-free field
 * readers), like the overview parser. Every object is rebuilt from the
 * fields listed here: no option value, proposed / customer / requested
 * value or organization default (current or suggested) passes, even when a
 * child prints one. A default change only shows as `has_suggested_default`.
 */
import {
  count,
  flag,
  list,
  nullableText,
  oneOf,
  optionalOneOf,
  parseOrUndefined,
  rate,
  record,
  text,
  InvalidCustomerDecisionValue,
  type JsonRecord,
} from './customer-decision-parse';

export const SUPPORTED_CUSTOMER_DECISION_LEARNING_VIEW_VERSION = '1.0.0';

const REPORT_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * A learning report date: `YYYY-MM-DD` and a real calendar day (`2026-02-30`
 * is not), so the route answers 400 instead of letting the facade fail.
 */
export function isLearningReportDate(value: string): boolean {
  if (!REPORT_DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export const LEARNING_VIEW_LIMITS = {
  dates: 12,
  suggestions: 100,
  rows: 200,
} as const;

export const LEARNING_SUGGESTION_KINDS = [
  'change_org_default',
  'revise_options',
  'clarify_entry',
] as const;
export type LearningSuggestionKindView = (typeof LEARNING_SUGGESTION_KINDS)[number];
export const LEARNING_CANDIDATE_OUTCOMES = ['created', 'existing', 'refused', 'failed'] as const;
export const LEARNING_ENTRY_KINDS = ['choice', 'approval', 'ranking', 'hearing'] as const;

export interface LearningSubjectView {
  item: string;
  key: string;
  template_id: string | null;
  entry_id: string | null;
}

export interface LearningSuggestionView extends LearningSubjectView {
  suggestion_key: string;
  kind: LearningSuggestionKindView;
  evidence: { samples: number; count: number; rate?: number };
  learning_id: string;
  candidate?: (typeof LEARNING_CANDIDATE_OUTCOMES)[number];
  has_suggested_default: boolean;
}

export interface LearningOverturnView extends LearningSubjectView {
  scope: 'template_entry' | 'item_key';
  from_layer: 'ours' | 'org_default';
  decided: number;
  overturned: number;
  kept: number;
  overturn_rate: number;
  other_values: number;
}

export interface LearningQuestionView extends LearningSubjectView {
  agendas: number;
  off_option: number;
  comments: number;
}

export interface LearningAgendaQuestionView {
  case_id: string;
  agenda_id: string;
  receipts: number;
  general_questions: number;
}

export interface LearningChangeRequestView extends LearningSubjectView {
  kind: (typeof LEARNING_ENTRY_KINDS)[number];
  answers: number;
  change_requests: number;
  request_changes: number;
  reject: number;
  rate: number;
}

export interface CustomerDecisionLearningViewData {
  version: typeof SUPPORTED_CUSTOMER_DECISION_LEARNING_VIEW_VERSION;
  tenant_slug: string;
  report_date: string | null;
  available_dates: string[];
  generated_at: string | null;
  since: string | null;
  thresholds: {
    min_samples: number;
    min_overturn_rate: number;
    min_value_count: number;
    min_change_requests: number;
    min_change_request_rate: number;
    min_questions: number;
  };
  metrics: { cases: number; agendas: number; receipts: number; switches: number };
  suggestions: LearningSuggestionView[];
  overturns: LearningOverturnView[];
  questions: LearningQuestionView[];
  agenda_questions: LearningAgendaQuestionView[];
  change_requests: LearningChangeRequestView[];
}

function nullableId(source: JsonRecord, key: string): string | null {
  return source[key] === null ? null : text(source, key);
}

function subject(source: JsonRecord): LearningSubjectView {
  return {
    item: text(source, 'item'),
    key: text(source, 'key'),
    template_id: nullableId(source, 'template_id'),
    entry_id: nullableId(source, 'entry_id'),
  };
}

function date(value: unknown): string {
  if (typeof value !== 'string' || !isLearningReportDate(value))
    throw new InvalidCustomerDecisionValue();
  return value;
}

function suggestion(value: unknown): LearningSuggestionView {
  const source = record(value);
  const evidence = record(source.evidence);
  const candidate = optionalOneOf(source, 'candidate', LEARNING_CANDIDATE_OUTCOMES);
  return {
    ...subject(source),
    suggestion_key: text(source, 'suggestion_key'),
    kind: oneOf(source, 'kind', LEARNING_SUGGESTION_KINDS),
    evidence: {
      samples: count(evidence, 'samples'),
      count: count(evidence, 'count'),
      ...(evidence.rate === undefined ? {} : { rate: rate(evidence, 'rate') }),
    },
    learning_id: text(source, 'learning_id'),
    ...(candidate ? { candidate } : {}),
    has_suggested_default: flag(source, 'has_suggested_default'),
  };
}

function overturn(value: unknown): LearningOverturnView {
  const source = record(value);
  return {
    ...subject(source),
    scope: oneOf(source, 'scope', ['template_entry', 'item_key'] as const),
    from_layer: oneOf(source, 'from_layer', ['ours', 'org_default'] as const),
    decided: count(source, 'decided'),
    overturned: count(source, 'overturned'),
    kept: count(source, 'kept'),
    overturn_rate: rate(source, 'overturn_rate'),
    other_values: count(source, 'other_values'),
  };
}

function question(value: unknown): LearningQuestionView {
  const source = record(value);
  return {
    ...subject(source),
    agendas: count(source, 'agendas'),
    off_option: count(source, 'off_option'),
    comments: count(source, 'comments'),
  };
}

function agendaQuestion(value: unknown): LearningAgendaQuestionView {
  const source = record(value);
  return {
    case_id: text(source, 'case_id'),
    agenda_id: text(source, 'agenda_id'),
    receipts: count(source, 'receipts'),
    general_questions: count(source, 'general_questions'),
  };
}

function changeRequest(value: unknown): LearningChangeRequestView {
  const source = record(value);
  return {
    ...subject(source),
    kind: oneOf(source, 'kind', LEARNING_ENTRY_KINDS),
    answers: count(source, 'answers'),
    change_requests: count(source, 'change_requests'),
    request_changes: count(source, 'request_changes'),
    reject: count(source, 'reject'),
    rate: rate(source, 'rate'),
  };
}

/**
 * The learning view as Chronos shows it, or undefined when the value is not
 * a version-1.0.0 learning view (of `expectedTenant`, and of `expectedDate`
 * when a date was asked for).
 */
export function parseCustomerDecisionLearningView(
  value: unknown,
  expectedTenant?: string,
  expectedDate?: string
): CustomerDecisionLearningViewData | undefined {
  return parseOrUndefined(() => {
    const source = record(value);
    if (source.version !== SUPPORTED_CUSTOMER_DECISION_LEARNING_VIEW_VERSION) return undefined;
    const tenant = text(source, 'tenant_slug');
    if (expectedTenant !== undefined && tenant !== expectedTenant) return undefined;
    const reportDate = source.report_date === null ? null : date(source.report_date);
    if (expectedDate !== undefined && reportDate !== expectedDate) return undefined;
    const thresholds = record(source.thresholds);
    const metrics = record(source.metrics);
    const { rows } = LEARNING_VIEW_LIMITS;
    return {
      version: SUPPORTED_CUSTOMER_DECISION_LEARNING_VIEW_VERSION,
      tenant_slug: tenant,
      report_date: reportDate,
      // The most recent dates (the facade already keeps the last 12, oldest first).
      available_dates: list(source.available_dates, date, Number.MAX_SAFE_INTEGER).slice(
        -LEARNING_VIEW_LIMITS.dates
      ),
      generated_at: nullableText(source, 'generated_at'),
      since: nullableText(source, 'since'),
      thresholds: {
        min_samples: count(thresholds, 'min_samples'),
        min_overturn_rate: rate(thresholds, 'min_overturn_rate'),
        min_value_count: count(thresholds, 'min_value_count'),
        min_change_requests: count(thresholds, 'min_change_requests'),
        min_change_request_rate: rate(thresholds, 'min_change_request_rate'),
        min_questions: count(thresholds, 'min_questions'),
      },
      metrics: {
        cases: count(metrics, 'cases'),
        agendas: count(metrics, 'agendas'),
        receipts: count(metrics, 'receipts'),
        switches: count(metrics, 'switches'),
      },
      suggestions: list(source.suggestions, suggestion, LEARNING_VIEW_LIMITS.suggestions),
      overturns: list(source.overturns, overturn, rows),
      questions: list(source.questions, question, rows),
      agenda_questions: list(source.agenda_questions, agendaQuestion, rows),
      change_requests: list(source.change_requests, changeRequest, rows),
    };
  });
}

/** The route's response body: `{ learning }`. */
export function parseCustomerDecisionLearningResponse(
  value: unknown,
  expectedTenant?: string,
  expectedDate?: string
): CustomerDecisionLearningViewData | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return parseCustomerDecisionLearningView(
    (value as JsonRecord).learning,
    expectedTenant,
    expectedDate
  );
}
