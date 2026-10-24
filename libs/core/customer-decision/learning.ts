/**
 * CD-12: what a tenant's customer decisions teach us (plan
 * docs/developer/improvement-plans-2026-10/CUSTOMER_DECISION_HEARING_PLAN_2026-10-24.ja.md
 * "CD-12 の実装設計"). Pure and deterministic: no I/O, no clock.
 *
 * Metrics (counts only — never the customer's free text):
 *   - overturn: switches from our side (`ours` / `org_default`) to a customer
 *     decision. A `value_changed` switch is an overturn, a `confirmed` switch
 *     is our proposal kept. Per item × key and per template entry, by the
 *     layer that was overturned;
 *   - questions: answers outside the offered options (free text on a
 *     non-hearing entry) and answers with a comment per entry; general
 *     questions per agenda;
 *   - change requests: decider answers that became a change request (override
 *     window closed) or a bolt-review `request_changes` / `reject`, per entry.
 *
 * Suggestions (with minimum sample sizes, {@link DEFAULT_LEARNING_THRESHOLDS}):
 *   - `change_org_default`: a template entry's organization default the
 *     customers keep overturning to one offered value;
 *   - `revise_options`: an entry with many change requests;
 *   - `clarify_entry`: an entry with many off-option answers / comments.
 * The exact rules are on {@link buildLearningSuggestions}.
 * Suggestions name the template and entry and the suggested change; nothing
 * here rewrites a product template.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../decision-ledger/model.js';
import type { AgendaEntry, DecisionAgenda, DecisionReceipt, DecisionSwitch } from './model.js';

export interface LearningCaseInput {
  case_id: string;
  agendas: readonly DecisionAgenda[];
  receipts: readonly DecisionReceipt[];
  switches: readonly DecisionSwitch[];
}

/** Where an entry came from: a template entry when its org default names one, else its item × key. */
export interface LearningSubject {
  item: string;
  key: string;
  /** `template:<id>` org default source → `<id>`; null for entries without one. */
  template_id: string | null;
  /** The template entry id (the agenda entry id), when `template_id` is set. */
  entry_id: string | null;
}

export interface LearningValueCount {
  value: unknown;
  count: number;
}

export interface OverturnStat extends LearningSubject {
  from_layer: 'ours' | 'org_default';
  /** Customer decisions on top of our side: overturned + kept. */
  decided: number;
  overturned: number;
  kept: number;
  /** overturned / decided (0 when nothing was decided). */
  overturn_rate: number;
  /** The values we proposed (offered options only), most frequent first. */
  proposed_values: LearningValueCount[];
  /** What the customer chose instead (offered options only), most frequent first. */
  customer_values: LearningValueCount[];
  /** Overturns to a value that is not an offered option (free text: not shown). */
  other_values: number;
}

export interface QuestionStat extends LearningSubject {
  /** Agendas (of the scanned cases) that asked this entry. */
  agendas: number;
  /** Answers outside the offered options. */
  off_option: number;
  /** Answers that carried a comment. */
  comments: number;
}

export interface AgendaQuestionStat {
  case_id: string;
  agenda_id: string;
  receipts: number;
  general_questions: number;
}

export interface ChangeRequestStat extends LearningSubject {
  kind: AgendaEntry['kind'];
  /** Decider answers to the entry. */
  answers: number;
  change_requests: number;
  request_changes: number;
  reject: number;
  /** (change_requests + request_changes + reject) / answers. */
  rate: number;
  /** Values asked for in change requests (offered options only). */
  requested_values: LearningValueCount[];
}

export interface CustomerDecisionLearningMetrics {
  cases: number;
  agendas: number;
  receipts: number;
  switches: number;
  overturn_by_item_key: OverturnStat[];
  overturn_by_template_entry: OverturnStat[];
  questions_by_entry: QuestionStat[];
  questions_by_agenda: AgendaQuestionStat[];
  change_requests_by_entry: ChangeRequestStat[];
}

export interface LearningThresholds {
  /** Minimum customer decisions on top of an org default before suggesting a change. */
  min_samples: number;
  /** Minimum overturn rate (0..1). */
  min_overturn_rate: number;
  /** Minimum times the suggested value was chosen. */
  min_value_count: number;
  /** Minimum change requests on an entry. */
  min_change_requests: number;
  /** Minimum change-request rate over decider answers (0..1). */
  min_change_request_rate: number;
  /** Minimum off-option answers + comments on an entry. */
  min_questions: number;
}

export const DEFAULT_LEARNING_THRESHOLDS: Readonly<LearningThresholds> = {
  min_samples: 5,
  min_overturn_rate: 0.6,
  min_value_count: 3,
  min_change_requests: 3,
  min_change_request_rate: 0.3,
  min_questions: 3,
};

export type LearningSuggestionKind = 'change_org_default' | 'revise_options' | 'clarify_entry';

export interface LearningSuggestion extends LearningSubject {
  /** Stable across runs: `<kind>:<template>#<entry>` or `<kind>:<item>/<key>`. */
  suggestion_key: string;
  kind: LearningSuggestionKind;
  /** `change_org_default`: the default in force and the value customers chose. */
  current_org_default?: unknown;
  suggested_org_default?: unknown;
  evidence: {
    samples: number;
    count: number;
    rate?: number;
  };
}

const OUR_LAYERS = new Set(['ours', 'org_default']);

function valueKey(value: unknown): string {
  return value === undefined ? '\u0000undefined' : canonicalJson(value);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function subjectOf(entry: AgendaEntry): LearningSubject {
  const source = entry.org_default?.source ?? '';
  const template = source.startsWith('template:') ? source.slice('template:'.length) : '';
  return {
    item: entry.item,
    key: entry.key,
    template_id: template || null,
    entry_id: template ? entry.entry_id : null,
  };
}

function itemKeyId(subject: Pick<LearningSubject, 'item' | 'key'>): string {
  return `${subject.item}/${subject.key}`;
}

function subjectId(subject: LearningSubject): string {
  return subject.template_id
    ? `${subject.template_id}#${subject.entry_id ?? ''}`
    : itemKeyId(subject);
}

function isOffered(entry: AgendaEntry | undefined, value: unknown): boolean {
  if (!entry?.options || value === undefined) return false;
  const key = valueKey(value);
  return entry.options.some((option) => valueKey(option.value) === key);
}

class ValueTally {
  private readonly counts = new Map<string, { value: unknown; count: number }>();
  add(value: unknown): void {
    const key = valueKey(value);
    const current = this.counts.get(key);
    if (current) current.count += 1;
    else this.counts.set(key, { value, count: 1 });
  }
  sorted(): LearningValueCount[] {
    return [...this.counts.entries()]
      .sort(([ka, a], [kb, b]) => b.count - a.count || ka.localeCompare(kb))
      .map(([, item]) => ({ value: item.value, count: item.count }));
  }
}

interface OverturnAccumulator {
  subject: LearningSubject;
  from_layer: 'ours' | 'org_default';
  overturned: number;
  kept: number;
  proposed: ValueTally;
  customer: ValueTally;
  other: number;
}

function inSince(at: string, since?: string): boolean {
  return !since || at >= since;
}

function sortBySubject<T extends LearningSubject>(items: T[], extra?: (item: T) => string): T[] {
  return items.sort(
    (a, b) =>
      subjectId(a).localeCompare(subjectId(b)) || (extra ? extra(a).localeCompare(extra(b)) : 0)
  );
}

/**
 * Count overturns, questions and change requests over a tenant's cases.
 * `since` (an ISO timestamp or date) keeps switches and receipts at or after it.
 */
export function buildDecisionLearningMetrics(
  cases: readonly LearningCaseInput[],
  opts: { since?: string } = {}
): CustomerDecisionLearningMetrics {
  const byItemKey = new Map<string, OverturnAccumulator>();
  const byTemplate = new Map<string, OverturnAccumulator>();
  const questions = new Map<string, QuestionStat & { agendaIds: Set<string> }>();
  const agendaQuestions: AgendaQuestionStat[] = [];
  const changes = new Map<
    string,
    Omit<ChangeRequestStat, 'rate' | 'requested_values'> & { values: ValueTally }
  >();
  let agendaCount = 0;
  let receiptCount = 0;
  let switchCount = 0;

  const overturnSlot = (
    map: Map<string, OverturnAccumulator>,
    id: string,
    subject: LearningSubject,
    layer: 'ours' | 'org_default'
  ): OverturnAccumulator => {
    const slotId = `${id}\u0000${layer}`;
    let slot = map.get(slotId);
    if (!slot) {
      slot = {
        subject,
        from_layer: layer,
        overturned: 0,
        kept: 0,
        proposed: new ValueTally(),
        customer: new ValueTally(),
        other: 0,
      };
      map.set(slotId, slot);
    }
    return slot;
  };

  for (const item of cases) {
    const agendas = new Map(item.agendas.map((agenda) => [agenda.agenda_id, agenda]));
    agendaCount += item.agendas.length;
    const entryOf = (agendaId: string, entryId: string): AgendaEntry | undefined =>
      agendas.get(agendaId)?.entries.find((entry) => entry.entry_id === entryId);

    for (const record of item.switches) {
      if (!inSince(record.at, opts.since)) continue;
      switchCount += 1;
      if (!OUR_LAYERS.has(record.from.layer) || record.to.layer !== 'customer') continue;
      const layer = record.from.layer as 'ours' | 'org_default';
      const entry = entryOf(record.agenda_id, record.entry_id);
      const subject: LearningSubject = entry
        ? subjectOf(entry)
        : { item: record.item, key: record.key, template_id: null, entry_id: null };
      const slots = [
        overturnSlot(
          byItemKey,
          itemKeyId(subject),
          { item: subject.item, key: subject.key, template_id: null, entry_id: null },
          layer
        ),
        ...(subject.template_id
          ? [overturnSlot(byTemplate, subjectId(subject), subject, layer)]
          : []),
      ];
      for (const slot of slots) {
        if (isOffered(entry, record.from.value)) slot.proposed.add(record.from.value);
        if (record.kind === 'confirmed') {
          slot.kept += 1;
          continue;
        }
        slot.overturned += 1;
        if (isOffered(entry, record.to.value)) slot.customer.add(record.to.value);
        else slot.other += 1;
      }
    }

    for (const agenda of item.agendas) {
      for (const entry of agenda.entries) {
        const subject = subjectOf(entry);
        const id = subjectId(subject);
        const question = questions.get(id) ?? {
          ...subject,
          agendas: 0,
          off_option: 0,
          comments: 0,
          agendaIds: new Set<string>(),
        };
        question.agendaIds.add(`${item.case_id}\u0000${agenda.agenda_id}`);
        questions.set(id, question);
      }
    }

    const receiptsByAgenda = new Map<string, { receipts: number; general: number }>();
    for (const receipt of item.receipts) {
      if (!inSince(receipt.submitted_at, opts.since)) continue;
      receiptCount += 1;
      const tally = receiptsByAgenda.get(receipt.agenda_id) ?? { receipts: 0, general: 0 };
      tally.receipts += 1;
      if (receipt.general_question) tally.general += 1;
      receiptsByAgenda.set(receipt.agenda_id, tally);
      for (const answer of receipt.answers) {
        const entry = entryOf(receipt.agenda_id, answer.entry_id);
        if (!entry) continue;
        const subject = subjectOf(entry);
        const id = subjectId(subject);
        const question = questions.get(id);
        if (question) {
          if (answer.choice === 'free_text' && entry.kind !== 'hearing') question.off_option += 1;
          else if (answer.comment) question.comments += 1;
        }
        if (receipt.participant.role !== 'decider') continue;
        const change = changes.get(id) ?? {
          ...subject,
          kind: entry.kind,
          answers: 0,
          change_requests: 0,
          request_changes: 0,
          reject: 0,
          values: new ValueTally(),
        };
        change.answers += 1;
        if (answer.outcome === 'change_request') {
          change.change_requests += 1;
          if (isOffered(entry, answer.value)) change.values.add(answer.value);
        } else if (answer.choice === 'request_changes') change.request_changes += 1;
        else if (answer.choice === 'reject') change.reject += 1;
        changes.set(id, change);
      }
    }
    for (const [agendaId, tally] of receiptsByAgenda) {
      agendaQuestions.push({
        case_id: item.case_id,
        agenda_id: agendaId,
        receipts: tally.receipts,
        general_questions: tally.general,
      });
    }
  }

  const overturnStats = (map: Map<string, OverturnAccumulator>): OverturnStat[] =>
    sortBySubject(
      [...map.values()].map((slot) => {
        const decided = slot.overturned + slot.kept;
        return {
          ...slot.subject,
          from_layer: slot.from_layer,
          decided,
          overturned: slot.overturned,
          kept: slot.kept,
          overturn_rate: decided === 0 ? 0 : round(slot.overturned / decided),
          proposed_values: slot.proposed.sorted(),
          customer_values: slot.customer.sorted(),
          other_values: slot.other,
        };
      }),
      (stat) => stat.from_layer
    );

  return {
    cases: cases.length,
    agendas: agendaCount,
    receipts: receiptCount,
    switches: switchCount,
    overturn_by_item_key: overturnStats(byItemKey),
    overturn_by_template_entry: overturnStats(byTemplate),
    questions_by_entry: sortBySubject(
      [...questions.values()].map(({ agendaIds, ...stat }) => ({
        ...stat,
        agendas: agendaIds.size,
      }))
    ),
    questions_by_agenda: agendaQuestions.sort(
      (a, b) => a.case_id.localeCompare(b.case_id) || a.agenda_id.localeCompare(b.agenda_id)
    ),
    change_requests_by_entry: sortBySubject(
      [...changes.values()].map(({ values, ...stat }) => {
        const total = stat.change_requests + stat.request_changes + stat.reject;
        return {
          ...stat,
          rate: stat.answers === 0 ? 0 : round(total / stat.answers),
          requested_values: values.sorted(),
        };
      })
    ),
  };
}

function subjectFields(subject: LearningSubject): LearningSubject {
  return {
    item: subject.item,
    key: subject.key,
    template_id: subject.template_id,
    entry_id: subject.entry_id,
  };
}

/**
 * Improvement suggestions from the metrics:
 *   - `change_org_default`: a template entry whose organization default was
 *     decided on top of at least `min_samples` times and overturned at
 *     `min_overturn_rate` or more, when one offered value was chosen at least
 *     `min_value_count` times (the most chosen one) and differs from the
 *     default in force → change the default to that value;
 *   - `revise_options`: an entry with at least `min_change_requests` change
 *     requests at `min_change_request_rate` or more of its decider answers →
 *     revise its options (labels, impact) or the draft under review;
 *   - `clarify_entry`: an entry with at least `min_questions` off-option
 *     answers and comments → clarify the question / background or add an option.
 * Sorted by suggestion key.
 */
export function buildLearningSuggestions(
  metrics: CustomerDecisionLearningMetrics,
  thresholds: Partial<LearningThresholds> = {}
): LearningSuggestion[] {
  const limits = { ...DEFAULT_LEARNING_THRESHOLDS, ...thresholds };
  const suggestions: LearningSuggestion[] = [];
  for (const stat of metrics.overturn_by_template_entry) {
    if (stat.from_layer !== 'org_default' || !stat.template_id) continue;
    if (stat.decided < limits.min_samples || stat.overturn_rate < limits.min_overturn_rate)
      continue;
    const top = stat.customer_values[0];
    if (!top || top.count < limits.min_value_count) continue;
    const current = stat.proposed_values[0]?.value;
    if (current !== undefined && valueKey(current) === valueKey(top.value)) continue;
    suggestions.push({
      ...subjectFields(stat),
      suggestion_key: `change_org_default:${subjectId(stat)}`,
      kind: 'change_org_default',
      ...(current !== undefined ? { current_org_default: current } : {}),
      suggested_org_default: top.value,
      evidence: { samples: stat.decided, count: stat.overturned, rate: stat.overturn_rate },
    });
  }
  for (const stat of metrics.change_requests_by_entry) {
    const count = stat.change_requests + stat.request_changes + stat.reject;
    if (count < limits.min_change_requests || stat.rate < limits.min_change_request_rate) continue;
    suggestions.push({
      ...subjectFields(stat),
      suggestion_key: `revise_options:${subjectId(stat)}`,
      kind: 'revise_options',
      evidence: { samples: stat.answers, count, rate: stat.rate },
    });
  }
  for (const stat of metrics.questions_by_entry) {
    const count = stat.off_option + stat.comments;
    if (count < limits.min_questions) continue;
    suggestions.push({
      ...subjectFields(stat),
      suggestion_key: `clarify_entry:${subjectId(stat)}`,
      kind: 'clarify_entry',
      evidence: { samples: stat.agendas, count },
    });
  }
  return suggestions.sort((a, b) => a.suggestion_key.localeCompare(b.suggestion_key));
}

export const CUSTOMER_DECISION_LEARNING_REPORT_VERSION = '1.0.0';
/** `learning-<YYYY-MM-DD>.json` under the tenant's `decisions/_reports/`. */
export const LEARNING_REPORT_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * The tenant learning report (`knowledge/confidential/<tenant>/decisions/_reports/learning-<date>.json`,
 * schema `customer-decision-learning-report.schema.json`). Counts, ids and
 * offered option values only.
 */
export interface CustomerDecisionLearningReport {
  version: typeof CUSTOMER_DECISION_LEARNING_REPORT_VERSION;
  tenant_slug: string;
  report_date: string;
  generated_at: string;
  since: string | null;
  thresholds: LearningThresholds;
  metrics: CustomerDecisionLearningMetrics;
  suggestions: Array<LearningSuggestion & { learning_id: string }>;
}

/**
 * The organization learning candidate id of a suggestion: one per tenant ×
 * suggestion key × report date (`cdl-<hex16>`), so a re-run the same day
 * never queues it twice and never overwrites a reviewed candidate.
 */
export function learningCandidateId(
  tenantSlug: string,
  suggestionKey: string,
  reportDate: string
): string {
  const digest = createHash('sha256')
    .update([tenantSlug, suggestionKey, reportDate].join('\u0000'))
    .digest('hex')
    .slice(0, 16);
  return `cdl-${digest}`;
}
