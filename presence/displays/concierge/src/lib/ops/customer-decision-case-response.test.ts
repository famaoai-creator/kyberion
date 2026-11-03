import { describe, expect, it } from 'vitest';
import {
  agendaContentHash,
  buildCustomerDecisionCaseDetail,
  CUSTOMER_DECISION_CASE_DETAIL_VERSION,
  type CaseOverviewInput,
  type DecisionAgenda,
  type DecisionReceipt,
} from '@agent/core/customer-decision';
import {
  CASE_DETAIL_LIMITS,
  CASE_QUESTION_MAX,
  isCustomerDecisionCaseId,
  parseCustomerDecisionCaseDetail,
  parseCustomerDecisionCaseResponse,
  SUPPORTED_CUSTOMER_DECISION_CASE_DETAIL_VERSION,
} from './customer-decision-case-response';

const CREATED = '2026-10-20T00:00:00.000Z';
const NOW = '2026-10-26T00:00:00.000Z';
const AGENDA = 'agd-0123456789abcdef';
/** Every value, free text, option label, rationale and name carries it; none may pass. */
const SECRET = 'zzsecret';
const ACTOR = `customer:${SECRET}-actor`;

function agenda(): DecisionAgenda {
  const base: DecisionAgenda = {
    version: '1.0.0',
    agenda_id: AGENDA,
    tenant_slug: 'acme',
    case_id: 'case-a',
    customer: 'globex',
    title: 'Inception decisions',
    from: `${SECRET} from`,
    phase: 'inception',
    revision: 1,
    locale: 'en',
    respond_by: '2026-10-27',
    entries: [
      {
        entry_id: 'auth',
        item: 'NFR',
        key: 'auth.method',
        kind: 'choice',
        question: 'Which sign-in method?',
        background: `${SECRET} background`,
        options: [
          { value: `${SECRET}-password`, label: `${SECRET} Password` },
          { value: `${SECRET}-sso`, label: `${SECRET} SSO` },
        ],
        our_decision: { value: `${SECRET}-sso`, rationale: `${SECRET} rationale` },
        requires_customer: false,
      },
      {
        entry_id: 'notes',
        item: 'NOTES',
        key: 'notes.extra',
        kind: 'hearing',
        question: `Anything else? ${'x'.repeat(400)}`,
        requires_customer: true,
      },
    ],
    status: 'sent',
    created_at: CREATED,
    updated_at: CREATED,
    reminders: [
      {
        reminder_id: 'rmd-0000000000000001',
        kind: 'due',
        actor_id: ACTOR,
        target_date: '2026-10-27',
        status: 'manual',
        reason: 'no_channel',
        at: CREATED,
      },
    ],
  };
  return {
    ...base,
    approval: {
      content_hash: agendaContentHash(base),
      approved_at: CREATED,
      approved_by: `user:${SECRET}-approver`,
      approved_by_type: 'human',
    },
  };
}

function receipt(a: DecisionAgenda): DecisionReceipt {
  return {
    version: '1.0.0',
    receipt_id: 'rcp-000000000001',
    tenant_slug: 'acme',
    case_id: 'case-a',
    agenda_id: AGENDA,
    agenda_revision: 1,
    content_hash: agendaContentHash(a),
    invite_id: 'inv-0000000000000001',
    participant: { name: `${SECRET} Hanako`, role: 'decider', actor_id: ACTOR },
    answers: [
      {
        entry_id: 'auth',
        choice: 'option',
        value: `${SECRET}-password`,
        comment: `${SECRET} comment`,
        outcome: 'change_request',
      },
    ],
    general_question: `${SECRET} general question`,
    identity_assurance: 'invite_link',
    submitted_at: '2026-10-25T00:00:00.000Z',
    decision_ids: [],
  };
}

function input(): CaseOverviewInput & { tenant_slug: string } {
  const a = agenda();
  return {
    tenant_slug: 'acme',
    case_id: 'case-a',
    agendas: [a],
    ledger: [],
    receipts: [receipt(a)],
    invites: [
      {
        version: '1.0.0',
        invite_id: 'inv-0000000000000001',
        tenant_slug: 'acme',
        case_id: 'case-a',
        agenda_id: AGENDA,
        participant: { name: `${SECRET} Hanako`, role: 'decider', actor_id: ACTOR },
        secret_sha256: 'a'.repeat(64),
        created_at: CREATED,
        expires_at: '2026-11-30T00:00:00.000Z',
        created_by: `user:${SECRET}-alice`,
        uses: [],
      },
    ],
    consumers: [
      {
        version: '1.0.0',
        case_id: 'case-a',
        consumer: 'mission-MSN-1.task-a',
        locked_at: CREATED,
        mission_id: 'MSN-1',
        task_id: 'task-a',
        status: 'in_progress',
        decisions: [],
        hold: { work_item_id: 'WI-HOLD', at: CREATED },
      },
    ],
    now: NOW,
  } as CaseOverviewInput & { tenant_slug: string };
}

const real = () => JSON.parse(JSON.stringify(buildCustomerDecisionCaseDetail(input())));

describe('customer-decision case detail projection (CD-12 drill-down)', () => {
  it('tracks the contract version of the core builder', () => {
    expect(SUPPORTED_CUSTOMER_DECISION_CASE_DETAIL_VERSION).toBe(
      CUSTOMER_DECISION_CASE_DETAIL_VERSION
    );
  });

  it('accepts a real case detail and keeps ids, statuses, dates and counts', () => {
    const source = real();
    const parsed = parseCustomerDecisionCaseDetail(source, 'acme', 'case-a');
    expect(parsed).toBeDefined();
    expect(parsed).toMatchObject({
      case_id: 'case-a',
      draft_only: false,
      task_counts: source.task_counts,
      tasks_total: 1,
      agendas_total: 1,
    });
    const [item] = parsed!.agendas;
    expect(item).toMatchObject({
      agenda_id: AGENDA,
      title: 'Inception decisions',
      entries_total: 2,
      change_requests_total: 1,
      handoffs_total: source.agendas[0].handoffs_total,
      invites: { active: 1, deciders: 1, contributors: 0 },
      approval: { approved_at: CREATED, approved_by_type: 'human' },
    });
    expect(item.reminders.records[0]).toMatchObject({ kind: 'due', reason: 'no_channel' });
    expect(parsed!.tasks[0]).toMatchObject({
      mission_id: 'MSN-1',
      hold: { work_item_id: 'WI-HOLD' },
    });
    expect(parsed!.attention.length).toBe(source.attention.length);
  });

  it('lets no value, option, rationale, comment, name or actor through', () => {
    const parsed = parseCustomerDecisionCaseDetail(real(), 'acme');
    expect(JSON.stringify(parsed)).not.toContain(SECRET);
  });

  it('drops keys outside the contract, even an injected decision value', () => {
    const value = real();
    value.agendas[0].entries[0].value = `${SECRET}-value`;
    value.agendas[0].entries[0].options = [{ label: SECRET }];
    value.agendas[0].handoffs.push({
      receipt_id: 'rcp-2',
      off_option: 0,
      comments: 1,
      general_question: false,
      comment: SECRET,
      notified: false,
      done: false,
      at: CREATED,
    });
    value.agendas[0].reminders.records[0].actor_id = ACTOR;
    value.tasks[0].proposals = [
      {
        proposal_id: 'tp-1',
        requires_customer: true,
        collected: false,
        question: SECRET,
        options: [SECRET],
      },
    ];
    value.extra = SECRET;
    const parsed = parseCustomerDecisionCaseDetail(value, 'acme', 'case-a');
    expect(parsed).toBeDefined();
    expect(JSON.stringify(parsed)).not.toContain(SECRET);
  });

  it('keeps a frozen task mark and rejects any other value for it', () => {
    const value = real();
    value.tasks[0].frozen = true;
    expect(parseCustomerDecisionCaseDetail(value, 'acme')?.tasks[0].frozen).toBe(true);
    value.tasks[0].frozen = false;
    expect(parseCustomerDecisionCaseDetail(value, 'acme')).toBeUndefined();
    delete value.tasks[0].frozen;
    expect(parseCustomerDecisionCaseDetail(value, 'acme')?.tasks[0]).not.toHaveProperty('frozen');
  });

  it('cuts an entry question to 200 characters', () => {
    const value = real();
    value.agendas[0].entries[1].question = 'q'.repeat(500);
    const parsed = parseCustomerDecisionCaseDetail(value);
    expect(parsed!.agendas[0].entries[1].question.length).toBe(CASE_QUESTION_MAX);
  });

  it('caps lists and keeps the totals', () => {
    const value = real();
    const entry = value.agendas[0].entries[0];
    value.agendas[0].entries = Array.from(
      { length: CASE_DETAIL_LIMITS.entries_per_agenda + 5 },
      (_, index) => ({ ...entry, entry_id: `e${index}` })
    );
    value.agendas[0].entries_total = CASE_DETAIL_LIMITS.entries_per_agenda + 50;
    const parsed = parseCustomerDecisionCaseDetail(value);
    expect(parsed!.agendas[0].entries).toHaveLength(CASE_DETAIL_LIMITS.entries_per_agenda);
    expect(parsed!.agendas[0].entries_total).toBe(CASE_DETAIL_LIMITS.entries_per_agenda + 50);
    // A re-serialized copy (the route's response) keeps the agenda total.
    expect(parseCustomerDecisionCaseDetail(JSON.parse(JSON.stringify(parsed)))?.agendas_total).toBe(
      1
    );
  });

  it.each([
    ['another tenant', (v: Record<string, unknown>) => v, 'globex', 'case-a'],
    ['another case', (v: Record<string, unknown>) => v, 'acme', 'case-b'],
    [
      'another version',
      (v: Record<string, unknown>) => ({ ...v, version: '2.0.0' }),
      'acme',
      undefined,
    ],
    [
      'an unknown entry status',
      (v: Record<string, unknown>) => {
        (v.agendas as Array<{ entries: Array<Record<string, unknown>> }>)[0].entries[0].status =
          'x';
        return v;
      },
      'acme',
      undefined,
    ],
    [
      'a negative total',
      (v: Record<string, unknown>) => ({ ...v, tasks_total: -1 }),
      'acme',
      undefined,
    ],
    [
      'a prototype key',
      (v: Record<string, unknown>) =>
        JSON.parse(JSON.stringify(v).replace('"today"', '"__proto__":{},"today"')),
      'acme',
      undefined,
    ],
  ] as const)('rejects %s', (_label, mutate, tenant, caseId) => {
    expect(parseCustomerDecisionCaseDetail(mutate(real()), tenant, caseId)).toBeUndefined();
  });

  it('reads the route body and validates case ids like the ledger', () => {
    expect(parseCustomerDecisionCaseResponse({ case: real() }, 'acme', 'case-a')).toBeDefined();
    expect(parseCustomerDecisionCaseResponse({ overview: real() })).toBeUndefined();
    expect(isCustomerDecisionCaseId('case-a_1')).toBe(true);
    for (const bad of ['', '-a', '../a', 'a b', 'a'.repeat(82)])
      expect(isCustomerDecisionCaseId(bad)).toBe(false);
  });
});
