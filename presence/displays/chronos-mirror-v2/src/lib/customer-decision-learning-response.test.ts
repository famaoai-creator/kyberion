import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_DECISION_LEARNING_VIEW_VERSION,
  DEFAULT_LEARNING_THRESHOLDS,
  emptyLearningView,
  projectLearningReport,
  type CustomerDecisionLearningReport,
  type OverturnStat,
} from '@agent/core/customer-decision';
import {
  isLearningReportDate,
  LEARNING_VIEW_LIMITS,
  parseCustomerDecisionLearningResponse,
  parseCustomerDecisionLearningView,
  SUPPORTED_CUSTOMER_DECISION_LEARNING_VIEW_VERSION,
} from './customer-decision-learning-response';

const SECRET = 'zzsecret';

const overturnStat = (over: Partial<OverturnStat>): OverturnStat => ({
  item: 'DATA',
  key: 'retention.days',
  template_id: 'aidlc-inception',
  entry_id: 'retention',
  from_layer: 'org_default',
  decided: 6,
  overturned: 5,
  kept: 1,
  overturn_rate: 0.833,
  proposed_values: [{ value: `${SECRET}-30`, count: 6 }],
  customer_values: [{ value: `${SECRET}-90`, count: 4 }],
  other_values: 1,
  current_org_default: `${SECRET}-current`,
  ...over,
});

function report(): CustomerDecisionLearningReport {
  return {
    version: '1.0.0',
    tenant_slug: 'acme',
    report_date: '2026-10-24',
    generated_at: '2026-10-24T09:00:00.000Z',
    since: '2026-07-26T00:00:00.000Z',
    thresholds: { ...DEFAULT_LEARNING_THRESHOLDS },
    metrics: {
      cases: 3,
      agendas: 4,
      receipts: 9,
      switches: 7,
      overturn_by_item_key: [overturnStat({ template_id: null, entry_id: null })],
      overturn_by_template_entry: [overturnStat({})],
      questions_by_entry: [
        {
          item: 'NFR',
          key: 'auth.method',
          template_id: null,
          entry_id: null,
          agendas: 2,
          off_option: 3,
          comments: 1,
        },
      ],
      questions_by_agenda: [
        { case_id: 'case-a', agenda_id: 'agd-0123456789abcdef', receipts: 3, general_questions: 1 },
      ],
      change_requests_by_entry: [
        {
          item: 'NFR',
          key: 'auth.method',
          template_id: null,
          entry_id: null,
          kind: 'choice',
          answers: 6,
          change_requests: 2,
          request_changes: 1,
          reject: 0,
          rate: 0.5,
          requested_values: [{ value: `${SECRET}-password`, count: 2 }],
        },
      ],
    },
    suggestions: [
      {
        item: 'DATA',
        key: 'retention.days',
        template_id: 'aidlc-inception',
        entry_id: 'retention',
        suggestion_key: 'change_org_default:aidlc-inception#retention',
        kind: 'change_org_default',
        current_org_default: `${SECRET}-current`,
        suggested_org_default: `${SECRET}-90`,
        evidence: { samples: 6, count: 5, rate: 0.833 },
        learning_id: 'cdl-0123456789abcdef',
        candidate: 'created',
      },
    ],
  };
}

const real = () =>
  JSON.parse(JSON.stringify(projectLearningReport(report(), ['2026-10-17', '2026-10-24'])));

describe('customer-decision learning view projection (CD-12 drill-down)', () => {
  it('tracks the contract version of the core builder', () => {
    expect(SUPPORTED_CUSTOMER_DECISION_LEARNING_VIEW_VERSION).toBe(
      CUSTOMER_DECISION_LEARNING_VIEW_VERSION
    );
  });

  it('accepts a real view: counts, subjects, suggestions, candidates', () => {
    const parsed = parseCustomerDecisionLearningView(real(), 'acme', '2026-10-24');
    expect(parsed).toMatchObject({
      report_date: '2026-10-24',
      available_dates: ['2026-10-17', '2026-10-24'],
      metrics: { cases: 3, agendas: 4, receipts: 9, switches: 7 },
      suggestions: [
        {
          kind: 'change_org_default',
          learning_id: 'cdl-0123456789abcdef',
          candidate: 'created',
          has_suggested_default: true,
          evidence: { samples: 6, count: 5, rate: 0.833 },
        },
      ],
    });
    expect(parsed!.overturns.map((row) => row.scope)).toEqual(['template_entry', 'item_key']);
    expect(parsed!.agenda_questions).toHaveLength(1);
    expect(JSON.stringify(parsed)).not.toContain(SECRET);
  });

  it('accepts the no-report view (nulls and default thresholds)', () => {
    const parsed = parseCustomerDecisionLearningView(
      JSON.parse(JSON.stringify(emptyLearningView('acme'))),
      'acme'
    );
    expect(parsed).toMatchObject({ report_date: null, generated_at: null, since: null });
  });

  it('never passes a value or default, even when a child prints one', () => {
    const value = real();
    value.suggestions[0].suggested_org_default = `${SECRET}-90`;
    value.suggestions[0].current_org_default = `${SECRET}-cur`;
    value.overturns[0].customer_values = [{ value: SECRET, count: 1 }];
    value.change_requests[0].requested_values = [{ value: SECRET, count: 1 }];
    value.extra = SECRET;
    const parsed = parseCustomerDecisionLearningView(value, 'acme');
    expect(parsed).toBeDefined();
    expect(JSON.stringify(parsed)).not.toContain(SECRET);
  });

  it('caps the rows and the date list', () => {
    const value = real();
    value.overturns = Array.from(
      { length: LEARNING_VIEW_LIMITS.rows + 3 },
      () => value.overturns[0]
    );
    value.available_dates = Array.from(
      { length: 20 },
      (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`
    );
    const parsed = parseCustomerDecisionLearningView(value);
    expect(parsed!.overturns).toHaveLength(LEARNING_VIEW_LIMITS.rows);
    expect(parsed!.available_dates).toHaveLength(LEARNING_VIEW_LIMITS.dates);
    expect(parsed!.available_dates.at(-1)).toBe('2026-01-20');
  });

  it.each([
    ['another tenant', (v: Record<string, unknown>) => v, 'globex', undefined],
    ['another report date', (v: Record<string, unknown>) => v, 'acme', '2026-10-17'],
    [
      'another version',
      (v: Record<string, unknown>) => ({ ...v, version: '2.0.0' }),
      'acme',
      undefined,
    ],
    [
      'a bad date',
      (v: Record<string, unknown>) => ({ ...v, report_date: '24/10/2026' }),
      'acme',
      undefined,
    ],
    [
      'a rate above 1',
      (v: Record<string, unknown>) => {
        (v.overturns as Array<Record<string, unknown>>)[0].overturn_rate = 2;
        return v;
      },
      'acme',
      undefined,
    ],
    [
      'an unknown suggestion kind',
      (v: Record<string, unknown>) => {
        (v.suggestions as Array<Record<string, unknown>>)[0].kind = 'x';
        return v;
      },
      'acme',
      undefined,
    ],
  ] as const)('rejects %s', (_label, mutate, tenant, date) => {
    expect(parseCustomerDecisionLearningView(mutate(real()), tenant, date)).toBeUndefined();
  });

  it('reads the route body and validates report dates', () => {
    expect(parseCustomerDecisionLearningResponse({ learning: real() }, 'acme')).toBeDefined();
    expect(parseCustomerDecisionLearningResponse({ case: real() }, 'acme')).toBeUndefined();
    expect(isLearningReportDate('2026-10-24')).toBe(true);
    for (const bad of ['2026-1-24', 'latest', '2026-10-24T00:00', '../2026-10-24'])
      expect(isLearningReportDate(bad)).toBe(false);
  });
});
