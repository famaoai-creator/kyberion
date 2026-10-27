import { describe, expect, it, vi } from 'vitest';
import type { DecisionRecord } from '../decision-ledger/model.js';
import {
  CASE_DETAIL_ENTRY_LIMIT,
  CASE_DETAIL_QUESTION_MAX,
  CASE_DETAIL_RECORD_LIMIT,
  CASE_DETAIL_TASK_LIMIT,
  buildCustomerDecisionCaseDetail,
} from './case-detail.js';
import { agendaContentHash } from './hash.js';
import type { CustomerDecisionInvite } from './invite.js';
import type {
  AgendaEntry,
  AgendaReminderRecord,
  DecisionAgenda,
  DecisionReceipt,
} from './model.js';
import type { CaseOverviewInput } from './overview.js';
import type { ConsumedDecisionLockRecord } from './store.js';

const CREATED = '2026-10-20T00:00:00.000Z';
const NOW = '2026-10-28T10:00:00.000Z';
const AGENDA = 'agd-0123456789abcdef';
/** Every value, free text, option label, rationale and name below carries it; none may reach the detail. */
const SECRET = 'zzsecret';
const ACTOR = `customer:${SECRET}-actor`;

const ENTRIES: AgendaEntry[] = [
  {
    entry_id: 'auth',
    item: 'NFR',
    key: 'auth.method',
    kind: 'choice',
    question: 'Which sign-in method?',
    background: `${SECRET} background`,
    options: [
      { value: `${SECRET}-password`, label: `${SECRET} Password`, impact: { cost: SECRET } },
      { value: `${SECRET}-sso`, label: `${SECRET} SSO` },
    ],
    our_decision: {
      value: `${SECRET}-sso`,
      rationale: `${SECRET} rationale`,
      decision_id: 'D-0001',
    },
    requires_customer: false,
    override_until: { kind: 'date', at: '2026-10-30T09:00:00.000Z' },
  },
  {
    entry_id: 'retention',
    item: 'DATA',
    key: 'retention.days',
    kind: 'choice',
    question: 'How long to keep data?',
    options: [
      { value: 30, label: `${SECRET} 30 days` },
      { value: 90, label: `${SECRET} 90 days` },
    ],
    org_default: { value: `${SECRET}-default`, source: 'template:aidlc-inception' },
    requires_customer: false,
    attachments: [{ id: 'a'.repeat(64), name: `${SECRET}.png`, media_type: 'image/png', bytes: 1 }],
    links: [
      { label: `${SECRET} preview`, url: `https://example.test/${SECRET}` },
      { label: 'two', url: 'https://example.test/2' },
    ],
  },
  {
    entry_id: 'price',
    item: 'DEAL',
    key: 'price.plan',
    kind: 'approval',
    question: 'Approve the price?',
    requires_customer: true,
  },
  {
    entry_id: 'notes',
    item: 'NOTES',
    key: 'notes.extra',
    kind: 'hearing',
    question: `Anything   else?\n${'x'.repeat(400)}`,
    requires_customer: false,
  },
];

function agenda(over: Partial<DecisionAgenda> = {}): DecisionAgenda {
  const base: DecisionAgenda = {
    version: '1.0.0',
    agenda_id: AGENDA,
    tenant_slug: 'acme-corp',
    case_id: 'case-a',
    customer: 'acme',
    title: 'Inception decisions',
    from: `${SECRET} from`,
    phase: 'inception',
    revision: 1,
    locale: 'en',
    respond_by: '2026-10-27',
    entries: ENTRIES,
    status: 'sent',
    created_at: CREATED,
    updated_at: CREATED,
    operator_confirmations: [
      {
        entry_id: 'price',
        decision_id: 'D-0002',
        by: `user:${SECRET}-boss`,
        requested_by: `user:${SECRET}-member`,
        at: CREATED,
      },
    ],
    handoffs: [
      {
        receipt_id: 'rcp-000000000001',
        off_option: 1,
        comments: 1,
        general_question: 1,
        inbox_entry_id: 'INBOX-CDH-1',
        notified_at: '2026-10-25T01:00:00.000Z',
        at: '2026-10-25T01:00:00.000Z',
      },
    ],
    reminders: [
      {
        reminder_id: 'rmd-0000000000000001',
        kind: 'due',
        actor_id: ACTOR,
        target_date: '2026-10-27',
        status: 'manual',
        reason: 'no_channel',
        inbox_entry_id: 'INBOX-CDR-1',
        at: CREATED,
      },
    ],
    bolt_routing: [
      {
        entry_id: 'auth',
        ref: `rcp-${SECRET}-ref`,
        outcome: 'request_changes',
        work_item_id: 'WI-1',
        at: CREATED,
      },
      { entry_id: 'price', ref: 'D-0009', outcome: 'reject', notified_at: CREATED, at: CREATED },
    ],
    ...over,
  };
  const { approval: _approval, ...rest } = base;
  void _approval;
  return {
    ...rest,
    approval: {
      content_hash: agendaContentHash(rest),
      approved_at: CREATED,
      approved_by: `user:${SECRET}-approver`,
      approved_by_type: 'human',
      submitted_by: `user:${SECRET}-submitter`,
    },
  };
}

const decidedBy = {
  kind: 'human' as const,
  id: `user:${SECRET}-inv`,
  on_behalf_of: { actor_id: ACTOR, evidence: 'rcp-000000000001' },
};
const ledger = [
  {
    id: 'D-0001',
    case_id: 'case-a',
    item: 'NFR',
    key: 'auth.method',
    level: 'customer-value',
    state: 'proposed',
    status: 'active',
    value: `${SECRET}-sso`,
    origin: 'facade',
    basis: [],
    proposed_by: { kind: 'human', id: `user:${SECRET}-alice` },
    proposed_at: CREATED,
  },
  {
    id: 'D-0002',
    case_id: 'case-a',
    item: 'DEAL',
    key: 'price.plan',
    level: 'customer-value',
    state: 'decided',
    status: 'active',
    value: `${SECRET}-approve`,
    origin: 'facade',
    basis: [],
    decided_by: decidedBy,
    decided_at: CREATED,
    note: SECRET,
  },
] as unknown as DecisionRecord[];

function invite(over: Partial<CustomerDecisionInvite> = {}): CustomerDecisionInvite {
  return {
    version: '1.0.0',
    invite_id: 'inv-0000000000000001',
    tenant_slug: 'acme-corp',
    case_id: 'case-a',
    agenda_id: AGENDA,
    participant: { name: `${SECRET} Hanako`, role: 'decider', actor_id: ACTOR },
    secret_sha256: 'a'.repeat(64),
    created_at: CREATED,
    expires_at: '2026-11-30T00:00:00.000Z',
    created_by: `user:${SECRET}-alice`,
    uses: [],
    ...over,
  };
}

function receipt(a: DecisionAgenda): DecisionReceipt {
  return {
    version: '1.0.0',
    receipt_id: 'rcp-000000000001',
    tenant_slug: 'acme-corp',
    case_id: 'case-a',
    agenda_id: AGENDA,
    agenda_revision: 1,
    content_hash: agendaContentHash(a),
    invite_id: 'inv-0000000000000001',
    participant: { name: `${SECRET} Hanako`, role: 'decider', actor_id: ACTOR },
    answers: [
      { entry_id: 'price', choice: 'approve', outcome: 'decided' },
      {
        entry_id: 'auth',
        choice: 'option',
        value: `${SECRET}-password`,
        comment: `${SECRET} comment`,
        outcome: 'change_request',
      },
      {
        entry_id: 'retention',
        choice: 'free_text',
        comment: `${SECRET} off option`,
        outcome: 'opinion',
      },
    ],
    general_question: `${SECRET} general question`,
    identity_assurance: 'invite_link',
    submitted_at: '2026-10-25T00:00:00.000Z',
    decision_ids: ['D-0002'],
  };
}

function lock(over: Partial<ConsumedDecisionLockRecord>): ConsumedDecisionLockRecord {
  return {
    version: '1.0.0',
    case_id: 'case-a',
    consumer: 'mission-MSN-1.task-a',
    locked_at: CREATED,
    mission_id: 'MSN-1',
    task_id: 'task-a',
    status: 'in_progress',
    decisions: [],
    ...over,
  };
}

const proposal = (id: string, requiresCustomer: boolean) => ({
  item: 'TASK',
  key: `task.${id}`,
  layer: 'task_proposal' as const,
  ...(requiresCustomer ? {} : { value: `${SECRET}-proposed` }),
  proposal: {
    proposal_id: `tp-${id.padEnd(16, '0')}`,
    question: `${SECRET} which cache?`,
    requires_customer: requiresCustomer,
    options: [{ value: `${SECRET}-redis`, label: `${SECRET} Redis` }],
    rationale: `${SECRET} rationale`,
    topic: SECRET,
    proposed_at: CREATED,
  },
});

function caseInput(over: Partial<CaseOverviewInput> = {}): CaseOverviewInput & {
  tenant_slug: string;
} {
  const a = agenda();
  return {
    tenant_slug: 'acme-corp',
    case_id: 'case-a',
    agendas: [a],
    ledger,
    receipts: [receipt(a)],
    invites: [
      invite(),
      invite({
        invite_id: 'inv-0000000000000002',
        participant: { name: `${SECRET} Taro`, role: 'contributor', actor_id: ACTOR },
      }),
      invite({ invite_id: 'inv-0000000000000003', revoked_at: CREATED }),
      invite({ invite_id: 'inv-0000000000000004', expires_at: '2026-10-21T00:00:00.000Z' }),
    ],
    consumers: [
      lock({
        consumer: 'mission-MSN-2.task-b',
        mission_id: 'MSN-2',
        task_id: 'task-b',
        hold: { work_item_id: 'WI-HOLD', at: CREATED },
        decisions: [proposal('bbbb', true)],
        rework: [{ work_item_id: 'WI-RW', refs: ['D-0001'], at: CREATED }],
      }),
      lock({ decisions: [proposal('aaaa', false)] }),
    ],
    now: NOW,
    ...over,
  };
}

describe('buildCustomerDecisionCaseDetail (CD-12 drill-down)', () => {
  it('carries the overview of the case plus ids, statuses, dates and counts', () => {
    const detail = buildCustomerDecisionCaseDetail(caseInput());
    expect(detail).toMatchObject({
      version: '1.0.0',
      tenant_slug: 'acme-corp',
      case_id: 'case-a',
      generated_at: NOW,
      today: '2026-10-28',
      draft_only: false,
      task_counts: { pending_proposals: 2, held: 1, ready_to_resume: 0 },
      tasks_total: 2,
    });
    expect(detail.attention.map((item) => item.reason)).toEqual(
      expect.arrayContaining(['respond_by_overdue', 'open_change_requests', 'held_tasks'])
    );
    const [item] = detail.agendas;
    expect(item).toMatchObject({
      agenda_id: AGENDA,
      title: 'Inception decisions',
      status: 'sent',
      open_change_requests: 1,
      entries_total: ENTRIES.length,
      invites: { active: 2, expired: 1, revoked: 1, deciders: 1, contributors: 1 },
      approval: { approved_at: CREATED, approved_by_type: 'human' },
      change_requests: [
        { receipt_id: 'rcp-000000000001', entry_id: 'auth', at: '2026-10-25T00:00:00.000Z' },
      ],
      change_requests_total: 1,
      handoffs: [
        {
          receipt_id: 'rcp-000000000001',
          off_option: 1,
          comments: 1,
          general_question: true,
          inbox_entry_id: 'INBOX-CDH-1',
          notified: true,
          done: true,
          at: '2026-10-25T01:00:00.000Z',
        },
      ],
      bolt_routing: [
        { entry_id: 'auth', outcome: 'request_changes', work_item_id: 'WI-1', notified: false },
        { entry_id: 'price', outcome: 'reject', notified: true },
      ],
      bolt_routing_total: 2,
    });
    expect(item.reminders).toMatchObject({
      manual: 1,
      records: [
        {
          reminder_id: 'rmd-0000000000000001',
          kind: 'due',
          target_date: '2026-10-27',
          status: 'manual',
          reason: 'no_channel',
          at: CREATED,
        },
      ],
      records_total: 1,
    });
    expect(item.reminders.upcoming_total).toBe(item.reminders.upcoming.length);
    expect(item.reminders.records[0]).not.toHaveProperty('actor_id');
    expect(item.approval).not.toHaveProperty('approved_by');

    const byId = new Map(item.entries.map((entry) => [entry.entry_id, entry]));
    expect(byId.get('auth')).toMatchObject({
      layer: 'ours',
      decision_id: 'D-0001',
      operator_confirmed: false,
      attachment_count: 0,
      link_count: 0,
      override_until_at: '2026-10-30T09:00:00.000Z',
    });
    expect(byId.get('retention')).toMatchObject({
      layer: 'org_default',
      attachment_count: 1,
      link_count: 2,
    });
    expect(byId.get('retention')).not.toHaveProperty('decision_id');
    // The operator confirmed exactly the decision the entry resolves to.
    expect(byId.get('price')).toMatchObject({
      status: 'confirmed',
      decision_id: 'D-0002',
      operator_confirmed: true,
    });
    // Question: whitespace normalized, cut to 200 characters.
    const notes = byId.get('notes');
    expect(notes?.question.length).toBe(CASE_DETAIL_QUESTION_MAX);
    expect(notes?.question.startsWith('Anything else? xxx')).toBe(true);
    expect(byId.get('auth')?.question).toBe('Which sign-in method?');
  });

  it('lists tasks by mission with proposal ids, hold and rework, never the proposal text', () => {
    const { tasks } = buildCustomerDecisionCaseDetail(caseInput());
    expect(tasks.map((task) => task.mission_id)).toEqual(['MSN-1', 'MSN-2']);
    expect(tasks[0]).toEqual({
      consumer: 'mission-MSN-1.task-a',
      mission_id: 'MSN-1',
      task_id: 'task-a',
      status: 'in_progress',
      proposals: [
        { proposal_id: 'tp-aaaa000000000000', requires_customer: false, collected: false },
      ],
      proposals_total: 1,
      rework: { count: 0, work_item_ids: [] },
    });
    expect(tasks[1]).toMatchObject({
      hold: { work_item_id: 'WI-HOLD', at: CREATED },
      proposals: [
        { proposal_id: 'tp-bbbb000000000000', requires_customer: true, collected: false },
      ],
      rework: { count: 1, work_item_ids: ['WI-RW'] },
    });
  });

  it('leaves out tasks whose lock is an approved supersede, like the overview counts', () => {
    const detail = buildCustomerDecisionCaseDetail(
      caseInput({ isSuperseded: (lock) => lock.mission_id === 'MSN-2' })
    );
    expect(detail.tasks.map((task) => task.mission_id)).toEqual(['MSN-1']);
    expect(detail.tasks_total).toBe(1);
  });

  it('marks a task whose lock carries an unproven superseded mark as frozen', () => {
    const consumers = caseInput().consumers.map((lock) =>
      lock.mission_id === 'MSN-2'
        ? {
            ...lock,
            superseded: {
              by_consumer: `${lock.consumer}-v2`,
              by_task_id: 'v2',
              at: CREATED,
              approval_request_id: '0f6c2a4e-8b1d-4c3a-9e2f-1a2b3c4d5e6f',
            },
          }
        : lock
    );
    const detail = buildCustomerDecisionCaseDetail(caseInput({ consumers }));
    expect(detail.tasks.map((task) => [task.mission_id, task.frozen])).toEqual([
      ['MSN-1', undefined],
      ['MSN-2', true],
    ]);
    expect(detail.task_counts.frozen_locks).toBe(1);
    expect(detail.attention[0]).toMatchObject({ reason: 'frozen_locks', count: 1 });

    // Proven by the verifier: left out of the tasks and of the frozen count,
    // and each lock is verified once for the counts and the list together.
    const verify = vi.fn((lock: (typeof consumers)[number]) => lock.mission_id === 'MSN-2');
    const proven = buildCustomerDecisionCaseDetail(caseInput({ consumers, isSuperseded: verify }));
    expect(proven.tasks.map((task) => task.mission_id)).toEqual(['MSN-1']);
    expect(proven.task_counts.frozen_locks).toBe(0);
    expect(proven.attention.some((item) => item.reason === 'frozen_locks')).toBe(false);
    expect(verify).toHaveBeenCalledTimes(consumers.length);
  });

  it('never emits a value, free text, option, rationale, name, actor id or from', () => {
    const text = JSON.stringify(buildCustomerDecisionCaseDetail(caseInput())).toLowerCase();
    expect(text).not.toContain(SECRET);
    for (const field of [
      '"value"',
      '"our_decision"',
      '"org_default":',
      '"rationale"',
      '"background"',
      '"options"',
      '"decided_by"',
      '"comment"',
      '"from"',
      '"participant"',
      '"actor_id"',
      '"ref"',
    ])
      expect(text).not.toContain(field);
  });

  it('caps entries, records and tasks and reports the full totals', () => {
    const many: AgendaEntry[] = Array.from({ length: CASE_DETAIL_ENTRY_LIMIT + 25 }, (_, i) => ({
      entry_id: `e${i}`,
      item: 'ITEM',
      key: `k${i}`,
      kind: 'hearing',
      question: `q${i}`,
      requires_customer: false,
    }));
    const reminders: AgendaReminderRecord[] = Array.from(
      { length: CASE_DETAIL_RECORD_LIMIT + 50 },
      (_, i) => ({
        reminder_id: `rmd-${String(i).padStart(16, '0')}`,
        kind: 'due',
        actor_id: ACTOR,
        target_date: '2026-10-27',
        status: 'sent',
        at: CREATED,
      })
    );
    const a = agenda({ entries: many, reminders });
    const consumers = Array.from({ length: CASE_DETAIL_TASK_LIMIT + 10 }, (_, i) =>
      lock({
        consumer: `mission-MSN-${String(i).padStart(4, '0')}.t`,
        mission_id: `MSN-${String(i).padStart(4, '0')}`,
        task_id: 't',
      })
    );
    const detail = buildCustomerDecisionCaseDetail(
      caseInput({ agendas: [a], receipts: [], consumers })
    );
    const [item] = detail.agendas;
    expect(item.entries).toHaveLength(CASE_DETAIL_ENTRY_LIMIT);
    expect(item.entries_total).toBe(CASE_DETAIL_ENTRY_LIMIT + 25);
    // The status counts still cover every entry.
    expect(Object.values(item.counts).reduce((x, y) => x + y, 0)).toBe(
      CASE_DETAIL_ENTRY_LIMIT + 25
    );
    expect(item.reminders.records).toHaveLength(CASE_DETAIL_RECORD_LIMIT);
    expect(item.reminders.records_total).toBe(CASE_DETAIL_RECORD_LIMIT + 50);
    expect(detail.tasks).toHaveLength(CASE_DETAIL_TASK_LIMIT);
    expect(detail.tasks_total).toBe(CASE_DETAIL_TASK_LIMIT + 10);
    expect(detail.tasks[0].mission_id).toBe('MSN-0000');
  });

  it('refuses an invalid now', () => {
    expect(() => buildCustomerDecisionCaseDetail(caseInput({ now: 'nope' }))).toThrow(
      /CUSTOMER_DECISION_OVERVIEW_NOW_INVALID/u
    );
  });
});
