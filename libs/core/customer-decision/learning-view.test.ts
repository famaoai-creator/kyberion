import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LEARNING_THRESHOLDS,
  type CustomerDecisionLearningReport,
  type OverturnStat,
} from './learning.js';
import {
  LEARNING_VIEW_DATE_LIMIT,
  emptyLearningView,
  projectLearningReport,
} from './learning-view.js';

/** Every value in the report carries it; none may reach the view. */
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
    tenant_slug: 'acme-corp',
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
      {
        item: 'NFR',
        key: 'auth.method',
        template_id: null,
        entry_id: null,
        suggestion_key: 'clarify_entry:NFR/auth.method',
        kind: 'clarify_entry',
        evidence: { samples: 2, count: 4 },
        learning_id: 'cdl-fedcba9876543210',
      },
    ],
  };
}

describe('projectLearningReport (CD-12 learning view)', () => {
  it('keeps counts, subjects, suggestions and candidate ids', () => {
    const view = projectLearningReport(report(), ['2026-10-24', '2026-10-17']);
    expect(view).toMatchObject({
      version: '1.0.0',
      tenant_slug: 'acme-corp',
      report_date: '2026-10-24',
      available_dates: ['2026-10-17', '2026-10-24'],
      generated_at: '2026-10-24T09:00:00.000Z',
      since: '2026-07-26T00:00:00.000Z',
      thresholds: DEFAULT_LEARNING_THRESHOLDS,
      metrics: { cases: 3, agendas: 4, receipts: 9, switches: 7 },
    });
    expect(view.suggestions).toEqual([
      {
        item: 'DATA',
        key: 'retention.days',
        template_id: 'aidlc-inception',
        entry_id: 'retention',
        suggestion_key: 'change_org_default:aidlc-inception#retention',
        kind: 'change_org_default',
        evidence: { samples: 6, count: 5, rate: 0.833 },
        learning_id: 'cdl-0123456789abcdef',
        candidate: 'created',
        has_suggested_default: true,
      },
      {
        item: 'NFR',
        key: 'auth.method',
        template_id: null,
        entry_id: null,
        suggestion_key: 'clarify_entry:NFR/auth.method',
        kind: 'clarify_entry',
        evidence: { samples: 2, count: 4 },
        learning_id: 'cdl-fedcba9876543210',
        has_suggested_default: false,
      },
    ]);
    expect(view.overturns.map((row) => [row.scope, row.template_id])).toEqual([
      ['template_entry', 'aidlc-inception'],
      ['item_key', null],
    ]);
    expect(view.overturns[0]).toEqual({
      item: 'DATA',
      key: 'retention.days',
      template_id: 'aidlc-inception',
      entry_id: 'retention',
      scope: 'template_entry',
      from_layer: 'org_default',
      decided: 6,
      overturned: 5,
      kept: 1,
      overturn_rate: 0.833,
      other_values: 1,
    });
    expect(view.questions).toEqual([report().metrics.questions_by_entry[0]]);
    expect(view.agenda_questions).toEqual(report().metrics.questions_by_agenda);
    expect(view.change_requests[0]).toMatchObject({ change_requests: 2, rate: 0.5 });
  });

  it('drops every value and default the report carries', () => {
    const text = JSON.stringify(projectLearningReport(report(), []));
    expect(text).not.toContain(SECRET);
    for (const field of [
      'current_org_default',
      'suggested_org_default',
      'proposed_values',
      'customer_values',
      'requested_values',
      '"value"',
    ])
      expect(text).not.toContain(field);
  });

  it('lists only the most recent report dates, oldest first', () => {
    const dates = Array.from(
      { length: 20 },
      (_, i) => `2026-0${1 + Math.floor(i / 10)}-1${i % 10}`
    );
    const view = projectLearningReport(report(), [...dates].reverse());
    expect(view.available_dates).toHaveLength(LEARNING_VIEW_DATE_LIMIT);
    expect(view.available_dates).toEqual(dates.slice(-LEARNING_VIEW_DATE_LIMIT));
  });

  it('has an empty form when the tenant has no report', () => {
    expect(emptyLearningView('acme-corp')).toEqual({
      version: '1.0.0',
      tenant_slug: 'acme-corp',
      report_date: null,
      available_dates: [],
      generated_at: null,
      since: null,
      thresholds: DEFAULT_LEARNING_THRESHOLDS,
      metrics: { cases: 0, agendas: 0, receipts: 0, switches: 0 },
      suggestions: [],
      overturns: [],
      questions: [],
      agenda_questions: [],
      change_requests: [],
    });
  });
});
