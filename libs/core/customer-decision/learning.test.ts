import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LEARNING_THRESHOLDS,
  buildDecisionLearningMetrics,
  buildLearningSuggestions,
  isMaterialEvidenceChange,
  learningCandidateId,
  standingLearningSuggestions,
  type LearningCaseInput,
} from './learning.js';
import type { AgendaEntry, DecisionAgenda, DecisionReceipt, DecisionSwitch } from './model.js';

const AT = '2026-10-20T00:00:00.000Z';
const SECRET = 'secret-free-text';

const RETENTION: AgendaEntry = {
  entry_id: 'retention',
  item: 'DATA',
  key: 'retention.days',
  kind: 'choice',
  question: 'How long to keep data?',
  options: [
    { value: 30, label: '30 days' },
    { value: 90, label: '90 days' },
    { value: 365, label: '1 year' },
  ],
  org_default: { value: 30, source: 'template:aidlc-inception' },
  requires_customer: false,
};
const AUTH: AgendaEntry = {
  entry_id: 'auth',
  item: 'NFR',
  key: 'auth.method',
  kind: 'choice',
  question: 'Which sign-in method?',
  options: [
    { value: 'password', label: 'Password' },
    { value: 'sso', label: 'SSO' },
  ],
  our_decision: { value: 'sso' },
  requires_customer: false,
};

function agenda(index: number, entries: AgendaEntry[] = [RETENTION, AUTH]): DecisionAgenda {
  return {
    version: '1.0.0',
    agenda_id: `agd-agenda${String(index).padStart(4, '0')}`,
    tenant_slug: 'acme-corp',
    case_id: `case-${index}`,
    customer: 'acme',
    title: 'Inception',
    phase: 'inception',
    revision: 1,
    locale: 'en',
    entries,
    status: 'sent',
    created_at: AT,
    updated_at: AT,
  };
}

function sw(
  a: DecisionAgenda,
  entry: AgendaEntry,
  kind: DecisionSwitch['kind'],
  from: { layer: 'ours' | 'org_default' | 'customer' | 'none'; value?: unknown },
  to: unknown,
  at = AT
): DecisionSwitch {
  return {
    version: '1.0.0',
    switch_id: `sw-${a.agenda_id.slice(4)}-${entry.entry_id}-${kind}`,
    case_id: a.case_id,
    agenda_id: a.agenda_id,
    entry_id: entry.entry_id,
    item: entry.item,
    key: entry.key,
    kind,
    from,
    to: { layer: 'customer', value: to },
    at,
  };
}

function receipt(
  a: DecisionAgenda,
  answers: DecisionReceipt['answers'],
  over: Partial<DecisionReceipt> = {}
): DecisionReceipt {
  return {
    version: '1.0.0',
    receipt_id: `rcp-${a.agenda_id.slice(4)}`,
    tenant_slug: 'acme-corp',
    case_id: a.case_id,
    agenda_id: a.agenda_id,
    agenda_revision: 1,
    content_hash: 'h',
    invite_id: 'inv-1',
    participant: { name: 'Hanako', role: 'decider', actor_id: 'customer:acme-cto' },
    answers,
    identity_assurance: 'invite_link',
    submitted_at: AT,
    decision_ids: [],
    ...over,
  };
}

/** `n` cases where the customer overturned the org default to `to`, `kept` where they kept it. */
function overturnCases(overturned: unknown[], kept: number): LearningCaseInput[] {
  const cases: LearningCaseInput[] = [];
  overturned.forEach((value, index) => {
    const a = agenda(index);
    cases.push({
      case_id: a.case_id,
      agendas: [a],
      receipts: [],
      switches: [sw(a, RETENTION, 'value_changed', { layer: 'org_default', value: 30 }, value)],
    });
  });
  for (let index = 0; index < kept; index += 1) {
    const a = agenda(100 + index);
    cases.push({
      case_id: a.case_id,
      agendas: [a],
      receipts: [],
      switches: [sw(a, RETENTION, 'confirmed', { layer: 'org_default', value: 30 }, 30)],
    });
  }
  return cases;
}

describe('buildDecisionLearningMetrics (CD-12)', () => {
  it('counts overturns and kept proposals per item key and per template entry, by layer', () => {
    const cases = overturnCases([90, 90, 365, 'keep it forever please'], 1);
    // Our decision on auth overturned once; a customer re-decision is not an overturn.
    const a = agenda(50);
    cases.push({
      case_id: a.case_id,
      agendas: [a],
      receipts: [],
      switches: [
        sw(a, AUTH, 'value_changed', { layer: 'ours', value: 'sso' }, 'password'),
        sw(a, AUTH, 'value_changed', { layer: 'customer', value: 'password' }, 'sso', AT),
      ],
    });
    const metrics = buildDecisionLearningMetrics(cases);
    expect(metrics).toMatchObject({ cases: 6, agendas: 6, switches: 7 });
    const retention = metrics.overturn_by_template_entry.find(
      (stat) => stat.entry_id === 'retention'
    );
    expect(retention).toEqual({
      item: 'DATA',
      key: 'retention.days',
      template_id: 'aidlc-inception',
      entry_id: 'retention',
      from_layer: 'org_default',
      decided: 5,
      overturned: 4,
      kept: 1,
      overturn_rate: 0.8,
      proposed_values: [{ value: 30, count: 5 }],
      customer_values: [
        { value: 90, count: 2 },
        { value: 365, count: 1 },
      ],
      // Free text is counted, never shown.
      other_values: 1,
      current_org_default: 30,
    });
    expect(metrics.overturn_by_item_key).toEqual([
      expect.objectContaining({
        item: 'DATA',
        key: 'retention.days',
        template_id: null,
        from_layer: 'org_default',
        overturned: 4,
      }),
      expect.objectContaining({
        item: 'NFR',
        key: 'auth.method',
        from_layer: 'ours',
        decided: 1,
        overturned: 1,
        overturn_rate: 1,
      }),
    ]);
    // auth has no template org default: only the item × key view.
    expect(metrics.overturn_by_template_entry).toHaveLength(1);
    expect(JSON.stringify(metrics)).not.toContain('keep it forever');
  });

  it('counts off-option answers, comments, general questions and change requests (counts only)', () => {
    const a = agenda(1);
    const b = agenda(2);
    const metrics = buildDecisionLearningMetrics([
      {
        case_id: a.case_id,
        agendas: [a],
        switches: [],
        receipts: [
          receipt(
            a,
            [
              { entry_id: 'retention', choice: 'free_text', comment: SECRET, outcome: 'opinion' },
              {
                entry_id: 'auth',
                choice: 'option',
                value: 'password',
                comment: SECRET,
                outcome: 'change_request',
              },
            ],
            { general_question: SECRET }
          ),
          // A contributor's opinion: a question signal, never a change request.
          receipt(
            a,
            [{ entry_id: 'auth', choice: 'option', value: 'password', outcome: 'opinion' }],
            {
              receipt_id: 'rcp-contrib01',
              participant: { name: 'Taro', role: 'contributor', actor_id: 'customer:acme-pm' },
            }
          ),
        ],
      },
      {
        case_id: b.case_id,
        agendas: [b],
        switches: [],
        receipts: [
          receipt(b, [
            { entry_id: 'retention', choice: 'free_text', comment: SECRET, outcome: 'opinion' },
            { entry_id: 'auth', choice: 'option', value: 'sso', outcome: 'decided' },
          ]),
        ],
      },
    ]);
    expect(metrics.questions_by_entry).toEqual([
      expect.objectContaining({
        template_id: 'aidlc-inception',
        entry_id: 'retention',
        agendas: 2,
        off_option: 2,
        comments: 0,
      }),
      expect.objectContaining({ item: 'NFR', key: 'auth.method', agendas: 2, comments: 1 }),
    ]);
    expect(metrics.questions_by_agenda).toEqual([
      { case_id: 'case-1', agenda_id: a.agenda_id, receipts: 2, general_questions: 1 },
      { case_id: 'case-2', agenda_id: b.agenda_id, receipts: 1, general_questions: 0 },
    ]);
    expect(
      metrics.change_requests_by_entry.find((stat) => stat.key === 'auth.method')
    ).toMatchObject({
      answers: 2,
      change_requests: 1,
      rate: 0.5,
      requested_values: [{ value: 'password', count: 1 }],
    });
    expect(JSON.stringify(metrics)).not.toContain(SECRET);
  });

  it('keeps only switches and receipts at or after since', () => {
    const cases = overturnCases([90, 90], 0);
    cases[0] = {
      ...cases[0],
      switches: cases[0].switches.map((item) => ({ ...item, at: '2026-09-01T00:00:00.000Z' })),
    };
    const metrics = buildDecisionLearningMetrics(cases, { since: '2026-10-01T00:00:00.000Z' });
    expect(metrics.switches).toBe(1);
    expect(metrics.overturn_by_template_entry[0]).toMatchObject({ overturned: 1 });
  });
});

describe('buildLearningSuggestions (CD-12)', () => {
  it('suggests the most chosen customer value as the org default only above the sample and rate thresholds', () => {
    const enough = buildLearningSuggestions(
      buildDecisionLearningMetrics(overturnCases([90, 90, 90, 365], 1))
    );
    expect(enough).toEqual([
      {
        item: 'DATA',
        key: 'retention.days',
        template_id: 'aidlc-inception',
        entry_id: 'retention',
        suggestion_key: 'change_org_default:aidlc-inception#retention',
        kind: 'change_org_default',
        current_org_default: 30,
        suggested_org_default: 90,
        evidence: { samples: 5, count: 4, rate: 0.8 },
      },
    ]);
    // Too few samples (4 < 5).
    expect(
      buildLearningSuggestions(buildDecisionLearningMetrics(overturnCases([90, 90, 90, 90], 0)))
    ).toEqual([]);
    // Rate below 60% (3 of 6).
    expect(
      buildLearningSuggestions(buildDecisionLearningMetrics(overturnCases([90, 90, 90], 3)))
    ).toEqual([]);
    // No single value chosen often enough (2 + 2 + 1 < 3 each).
    expect(
      buildLearningSuggestions(
        buildDecisionLearningMetrics(overturnCases([90, 90, 365, 365, 30], 0))
      ).filter((item) => item.kind === 'change_org_default')
    ).toEqual([]);
    // Thresholds can be tuned.
    expect(
      buildLearningSuggestions(buildDecisionLearningMetrics(overturnCases([90, 90, 90, 90], 0)), {
        min_samples: 4,
      })
    ).toHaveLength(1);
    expect(DEFAULT_LEARNING_THRESHOLDS.min_samples).toBe(5);
  });

  it('suggests revising options with many change requests and clarifying entries with many questions', () => {
    const cases: LearningCaseInput[] = [];
    for (let index = 0; index < 4; index += 1) {
      const a = agenda(index);
      cases.push({
        case_id: a.case_id,
        agendas: [a],
        switches: [],
        receipts: [
          receipt(a, [
            {
              entry_id: 'auth',
              choice: 'option',
              value: 'password',
              outcome: index < 3 ? 'change_request' : 'decided',
            },
            ...(index < 3
              ? [
                  {
                    entry_id: 'retention',
                    choice: 'free_text' as const,
                    comment: SECRET,
                    outcome: 'opinion' as const,
                  },
                ]
              : []),
          ]),
        ],
      });
    }
    const suggestions = buildLearningSuggestions(buildDecisionLearningMetrics(cases));
    expect(suggestions.map((item) => item.suggestion_key)).toEqual([
      'clarify_entry:aidlc-inception#retention',
      'revise_options:NFR/auth.method',
    ]);
    expect(suggestions[1]).toMatchObject({ evidence: { samples: 4, count: 3, rate: 0.75 } });
    // Two change requests are below the minimum of three.
    expect(
      buildLearningSuggestions(buildDecisionLearningMetrics(cases.slice(1)), {
        min_change_requests: 3,
      }).filter((item) => item.kind === 'revise_options')
    ).toEqual([]);
  });

  it('derives one stable candidate id per tenant, suggestion and date', () => {
    const id = learningCandidateId('acme-corp', 'revise_options:NFR/auth.method', '2026-10-25');
    expect(id).toMatch(/^cdl-[a-f0-9]{16}$/u);
    expect(learningCandidateId('acme-corp', 'revise_options:NFR/auth.method', '2026-10-25')).toBe(
      id
    );
    expect(
      learningCandidateId('other-corp', 'revise_options:NFR/auth.method', '2026-10-25')
    ).not.toBe(id);
    expect(
      learningCandidateId('acme-corp', 'revise_options:NFR/auth.method', '2026-11-01')
    ).not.toBe(id);
  });
});

describe('learning review fixes (CD-12)', () => {
  it('counts the latest answer per decider and revision once, and a new revision separately', () => {
    const a = agenda(1);
    const answer = (outcome: 'change_request' | 'decided', value: unknown) => ({
      entry_id: 'auth',
      choice: 'option' as const,
      value,
      outcome,
    });
    const metrics = buildDecisionLearningMetrics([
      {
        case_id: a.case_id,
        agendas: [a],
        switches: [],
        receipts: [
          receipt(a, [answer('change_request', 'password')], {
            receipt_id: 'rcp-r1-first',
            submitted_at: '2026-10-20T01:00:00.000Z',
          }),
          // The same decider re-submits revision 1: replaces the first answer.
          receipt(a, [answer('change_request', 'password')], {
            receipt_id: 'rcp-r1-second',
            submitted_at: '2026-10-20T02:00:00.000Z',
          }),
          // Revision 2 is a new question to the decider.
          receipt(a, [answer('decided', 'sso')], {
            receipt_id: 'rcp-r2-first',
            agenda_revision: 2,
            submitted_at: '2026-10-21T00:00:00.000Z',
          }),
        ],
      },
    ]);
    expect(
      metrics.change_requests_by_entry.find((stat) => stat.key === 'auth.method')
    ).toMatchObject({ answers: 2, change_requests: 1, rate: 0.5 });
  });

  it('takes option membership from the answered revision, not only the current options', () => {
    // Revision 1 offered 'passkey'; the current revision no longer does.
    const a = agenda(1);
    const metrics = buildDecisionLearningMetrics([
      {
        case_id: a.case_id,
        agendas: [a],
        switches: [
          {
            ...sw(a, RETENTION, 'value_changed', { layer: 'org_default', value: 30 }, 180),
            cause_receipt_id: 'rcp-old-rev',
          },
        ],
        receipts: [
          receipt(
            a,
            [
              { entry_id: 'retention', choice: 'option', value: 180, outcome: 'decided' },
              { entry_id: 'auth', choice: 'option', value: 'passkey', outcome: 'change_request' },
            ],
            { receipt_id: 'rcp-old-rev', agenda_revision: 1 }
          ),
        ],
      },
    ]);
    expect(metrics.overturn_by_template_entry[0]).toMatchObject({
      customer_values: [{ value: 180, count: 1 }],
      other_values: 0,
    });
    expect(
      metrics.change_requests_by_entry.find((stat) => stat.key === 'auth.method')?.requested_values
    ).toEqual([{ value: 'passkey', count: 1 }]);
  });

  it('compares with the default in force, so an applied change is not suggested again', () => {
    const cases = overturnCases([90, 90, 90, 365], 1);
    // The newest agenda already carries the changed default (applied).
    const applied = agenda(999, [
      { ...RETENTION, org_default: { value: 90, source: 'template:aidlc-inception' } },
    ]);
    applied.updated_at = '2026-10-25T00:00:00.000Z';
    cases.push({ case_id: applied.case_id, agendas: [applied], receipts: [], switches: [] });
    const metrics = buildDecisionLearningMetrics(cases);
    expect(metrics.overturn_by_template_entry[0]).toMatchObject({ current_org_default: 90 });
    expect(buildLearningSuggestions(metrics)).toEqual([]);
    // The product template's current default wins over the agendas'.
    const fromTemplate = buildLearningSuggestions(
      metrics,
      {},
      {
        currentDefaults: new Map([['aidlc-inception#retention', 30]]),
      }
    );
    expect(fromTemplate).toEqual([
      expect.objectContaining({ current_org_default: 30, suggested_org_default: 90 }),
    ]);
  });

  it('treats a suggestion as new only when the evidence materially changed', () => {
    const next = { suggested_org_default: 90, evidence: { samples: 6, count: 5 } };
    expect(isMaterialEvidenceChange(undefined, next)).toBe(true);
    expect(
      isMaterialEvidenceChange({ suggested_org_default: 90, evidence: { count: 4 } }, next)
    ).toBe(false);
    expect(
      isMaterialEvidenceChange({ suggested_org_default: 365, evidence: { count: 4 } }, next)
    ).toBe(true);
    expect(
      isMaterialEvidenceChange({ suggested_org_default: 90, evidence: { count: 2 } }, next)
    ).toBe(true);
    expect(isMaterialEvidenceChange({ suggested_org_default: 90 }, next)).toBe(true);
  });
});

describe('standingLearningSuggestions (CD-12)', () => {
  it('keeps the latest queued entry per suggestion key across reports, skipping failed ones', () => {
    const entry = (learningId: string, candidate?: 'created' | 'existing' | 'failed') => ({
      item: 'NFR',
      key: 'auth.method',
      template_id: null,
      entry_id: null,
      suggestion_key: 'revise_options:NFR/auth.method',
      kind: 'revise_options' as const,
      evidence: { samples: 4, count: 3 },
      learning_id: learningId,
      ...(candidate ? { candidate } : {}),
    });
    const standing = standingLearningSuggestions([
      { report_date: '2026-10-31', suggestions: [entry('cdl-0000000000000003', 'failed')] },
      { report_date: '2026-10-17', suggestions: [entry('cdl-0000000000000001')] },
      { report_date: '2026-10-24', suggestions: [entry('cdl-0000000000000002', 'existing')] },
    ]);
    expect(standing.get('revise_options:NFR/auth.method')?.learning_id).toBe(
      'cdl-0000000000000002'
    );
  });
});

describe('standing baseline (CD-12)', () => {
  it('compares against the evidence the candidate was queued with: 3 → 5 → 9 re-queues', () => {
    const entry = (
      date: string,
      learningId: string,
      count: number,
      candidate: 'created' | 'existing'
    ) => ({
      report_date: date,
      suggestions: [
        {
          item: 'NFR',
          key: 'auth.method',
          template_id: null,
          entry_id: null,
          suggestion_key: 'revise_options:NFR/auth.method',
          kind: 'revise_options' as const,
          evidence: { samples: 10, count },
          learning_id: learningId,
          candidate,
        },
      ],
    });
    const reports = [
      entry('2026-10-17', 'cdl-0000000000000001', 3, 'created'),
      // Next week: 5 < 2 × 3, the candidate stands; the report records 5.
      entry('2026-10-24', 'cdl-0000000000000001', 5, 'existing'),
    ];
    const prior = standingLearningSuggestions(reports).get('revise_options:NFR/auth.method');
    expect(prior?.evidence.count).toBe(3);
    expect(isMaterialEvidenceChange(prior, { evidence: { samples: 10, count: 5 } })).toBe(false);
    // 9 ≥ 2 × 3 (queued baseline), although only 1.8 × last week's 5.
    expect(isMaterialEvidenceChange(prior, { evidence: { samples: 10, count: 9 } })).toBe(true);
  });
});
