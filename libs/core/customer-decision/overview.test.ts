import { describe, expect, it } from 'vitest';
import type { DecisionRecord } from '../decision-ledger/model.js';
import { agendaContentHash } from './hash.js';
import type { CustomerDecisionInvite } from './invite.js';
import type { AgendaEntry, DecisionAgenda, DecisionReceipt } from './model.js';
import {
  OVERVIEW_ATTENTION_ORDER,
  buildCaseOverview,
  buildCustomerDecisionOverview,
  summarizeCustomerDecisionOverview,
  type CaseOverviewInput,
} from './overview.js';
import type { ConsumedDecisionLockRecord } from './store.js';

const CREATED = '2026-10-20T00:00:00.000Z';
const NOW = '2026-10-28T10:00:00.000Z';
const ACTOR = 'customer:acme-cto';
const AGENDA = 'agd-0123456789abcdef';
const SECRET_COMMENT = 'secret-comment-text';
const SECRET_QUESTION = 'secret-general-question';

const ENTRIES: AgendaEntry[] = [
  {
    entry_id: 'auth',
    item: 'NFR',
    key: 'auth.method',
    kind: 'choice',
    question: 'Which sign-in method?',
    options: [
      { value: 'password', label: 'Password' },
      { value: 'sso', label: 'SSO' },
    ],
    our_decision: { value: 'sso', decision_id: 'D-0001' },
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
      { value: 30, label: '30 days' },
      { value: 90, label: '90 days' },
    ],
    org_default: { value: 30, source: 'template:aidlc-inception' },
    requires_customer: false,
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
    entry_id: 'release',
    item: 'RELEASE',
    key: 'release.go',
    kind: 'approval',
    question: 'Release to production?',
    requires_customer: true,
  },
  {
    entry_id: 'notes',
    item: 'NOTES',
    key: 'notes.extra',
    kind: 'hearing',
    question: 'Anything else?',
    requires_customer: false,
  },
  {
    entry_id: 'locale',
    item: 'NFR',
    key: 'ui.locale',
    kind: 'choice',
    question: 'Which languages?',
    options: [
      { value: ['ja'], label: 'Japanese' },
      { value: ['ja', 'en'], label: 'Both' },
    ],
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
    phase: 'inception',
    revision: 1,
    locale: 'en',
    respond_by: '2026-10-27',
    entries: ENTRIES,
    status: 'sent',
    created_at: CREATED,
    updated_at: CREATED,
    ...over,
  };
  const { approval: _approval, ...rest } = base;
  void _approval;
  return {
    ...rest,
    approval: {
      content_hash: agendaContentHash(rest),
      approved_at: CREATED,
      approved_by: 'user:boss',
    },
  };
}

const ledger: DecisionRecord[] = [
  {
    id: 'D-0001',
    case_id: 'case-a',
    item: 'NFR',
    key: 'auth.method',
    level: 'customer-value',
    state: 'proposed',
    status: 'active',
    value: 'sso',
    origin: 'facade',
    proposed_by: { kind: 'human', id: 'user:alice' },
    proposed_at: CREATED,
  } as DecisionRecord,
  // The customer's answer on the requires_customer price entry: not confirmed by the operator.
  {
    id: 'D-0002',
    case_id: 'case-a',
    item: 'DEAL',
    key: 'price.plan',
    level: 'customer-value',
    state: 'decided',
    status: 'active',
    value: 'approve',
    origin: 'facade',
    decided_by: {
      kind: 'human',
      id: 'user:inv-1',
      on_behalf_of: { actor_id: ACTOR, evidence: 'rcp-000000000001' },
    },
    decided_at: CREATED,
  } as DecisionRecord,
  // The customer decided the locale: confirmed.
  {
    id: 'D-0003',
    case_id: 'case-a',
    item: 'NFR',
    key: 'ui.locale',
    level: 'customer-value',
    state: 'decided',
    status: 'active',
    value: ['ja'],
    origin: 'facade',
    decided_by: {
      kind: 'human',
      id: 'user:inv-1',
      on_behalf_of: { actor_id: ACTOR, evidence: 'rcp-000000000001' },
    },
    decided_at: CREATED,
  } as DecisionRecord,
];

function invite(over: Partial<CustomerDecisionInvite> = {}): CustomerDecisionInvite {
  return {
    version: '1.0.0',
    invite_id: 'inv-0000000000000001',
    tenant_slug: 'acme-corp',
    case_id: 'case-a',
    agenda_id: AGENDA,
    participant: { name: 'Hanako', role: 'decider', actor_id: ACTOR },
    secret_sha256: 'a'.repeat(64),
    created_at: CREATED,
    expires_at: '2026-11-30T00:00:00.000Z',
    created_by: 'user:alice',
    uses: [],
    ...over,
  };
}

function receipt(a: DecisionAgenda, over: Partial<DecisionReceipt> = {}): DecisionReceipt {
  return {
    version: '1.0.0',
    receipt_id: 'rcp-000000000001',
    tenant_slug: 'acme-corp',
    case_id: 'case-a',
    agenda_id: AGENDA,
    agenda_revision: 1,
    content_hash: agendaContentHash(a),
    invite_id: 'inv-0000000000000001',
    participant: { name: 'Hanako', role: 'decider', actor_id: ACTOR },
    answers: [
      { entry_id: 'price', choice: 'approve', outcome: 'decided' },
      { entry_id: 'locale', choice: 'option', value: ['ja'], outcome: 'decided' },
      // A change request (override window closed elsewhere): still open.
      {
        entry_id: 'auth',
        choice: 'option',
        value: 'password',
        comment: SECRET_COMMENT,
        outcome: 'change_request',
      },
      // Free text outside the options: handed to the operator.
      { entry_id: 'retention', choice: 'free_text', comment: SECRET_COMMENT, outcome: 'opinion' },
    ],
    general_question: SECRET_QUESTION,
    identity_assurance: 'invite_link',
    submitted_at: '2026-10-25T00:00:00.000Z',
    decision_ids: ['D-0002', 'D-0003'],
    ...over,
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
  proposal: {
    proposal_id: `tp-${id.padEnd(16, '0')}`,
    question: 'Which cache?',
    requires_customer: requiresCustomer,
    proposed_at: CREATED,
  },
});

function caseInput(over: Partial<CaseOverviewInput> = {}): CaseOverviewInput {
  const a = agenda();
  return {
    case_id: 'case-a',
    agendas: [a],
    ledger,
    receipts: [receipt(a)],
    invites: [invite()],
    consumers: [
      // A pending proposal (not on an agenda yet) and a task holding on the customer.
      lock({ decisions: [proposal('aaaa', false)] }),
      lock({
        consumer: 'mission-MSN-1.task-b',
        task_id: 'task-b',
        hold: { at: CREATED },
        decisions: [proposal('bbbb', true)],
      }),
    ],
    now: NOW,
    ...over,
  };
}

describe('buildCaseOverview (CD-12)', () => {
  it('puts every entry in exactly one status bucket', () => {
    const overview = buildCaseOverview(caseInput());
    const [item] = overview.agendas;
    expect(item.counts).toEqual({
      confirmed: 1, // locale (customer)
      provisional: 2, // auth (ours), retention (org default)
      awaiting_customer: 1, // release
      awaiting_operator_confirmation: 1, // price (customer, not confirmed)
      undecided: 1, // notes
    });
    expect(Object.values(item.counts).reduce((a, b) => a + b, 0)).toBe(ENTRIES.length);
    expect(item.entries.find((entry) => entry.entry_id === 'price')).toMatchObject({
      status: 'awaiting_operator_confirmation',
      layer: 'customer',
      requires_customer: true,
    });
    // An operator confirmation of that exact decision makes it confirmed.
    const confirmed = buildCaseOverview(
      caseInput({
        agendas: [
          agenda({
            operator_confirmations: [
              { entry_id: 'price', decision_id: 'D-0002', by: 'user:boss', at: CREATED },
            ],
          }),
        ],
      })
    );
    expect(confirmed.agendas[0].counts).toMatchObject({
      confirmed: 2,
      awaiting_operator_confirmation: 0,
    });
  });

  it('reports respond-by, the nearest open override deadline, change requests, hand-offs and reminders', () => {
    const [item] = buildCaseOverview(caseInput()).agendas;
    expect(item).toMatchObject({
      answerable: true,
      active_invites: 1,
      respond_by: '2026-10-27',
      respond_by_days: -1,
      // The decider answered only some open entries.
      unanswered_deciders: 1,
      next_override_deadline: { at: '2026-10-30T09:00:00.000Z', days: 2, entries: 1 },
      open_change_requests: 1,
      pending_handoffs: 1,
    });
    expect(item.entries.find((entry) => entry.entry_id === 'auth')?.override_until_at).toBe(
      '2026-10-30T09:00:00.000Z'
    );
    // Override-closing notice from D-2: due today and not settled.
    expect(item.reminders).toMatchObject({ due: 1, pending_approval: 0, manual: 0 });
    // Handed off (notified) → no longer pending.
    const handed = buildCaseOverview(
      caseInput({
        agendas: [
          agenda({
            handoffs: [
              {
                receipt_id: 'rcp-000000000001',
                off_option: 1,
                comments: 1,
                general_question: 1,
                inbox_entry_id: 'INBOX-CDH-1',
                notified_at: NOW,
                at: NOW,
              },
            ],
          }),
        ],
      })
    );
    expect(handed.agendas[0].pending_handoffs).toBe(0);
  });

  it('counts pending task proposals, held tasks and tasks ready to resume', () => {
    expect(buildCaseOverview(caseInput()).tasks).toEqual({
      pending_proposals: 2,
      held: 1,
      ready_to_resume: 0,
      unresolvable: 0,
    });
    // Collected onto the price entry; the customer's answer (D-0002) is in force once confirmed.
    const resolvedLock = lock({
      hold: { at: CREATED },
      decisions: [
        {
          ...proposal('cccc', true),
          item: 'DEAL',
          key: 'price.plan',
          agenda_id: AGENDA,
          entry_id: 'price',
          proposal: {
            ...proposal('cccc', true).proposal,
            collected_at: CREATED,
            resolved: { decision_id: 'D-0002', at: CREATED },
          },
        },
      ],
    });
    const confirmed = agenda({
      operator_confirmations: [
        { entry_id: 'price', decision_id: 'D-0002', by: 'user:boss', at: CREATED },
      ],
    });
    const resolved = buildCaseOverview(
      caseInput({ agendas: [confirmed], consumers: [resolvedLock] })
    );
    expect(resolved.tasks).toEqual({
      pending_proposals: 0,
      held: 0,
      ready_to_resume: 1,
      unresolvable: 0,
    });
    // Released before, but the decision is no longer confirmed: held again.
    const unconfirmed = buildCaseOverview(caseInput({ consumers: [resolvedLock] }));
    expect(unconfirmed.tasks).toEqual({
      pending_proposals: 0,
      held: 1,
      ready_to_resume: 0,
      unresolvable: 0,
    });
    // Its agenda withdrawn with no standing confirmed answer: unresolvable, with how to clear it.
    const gone = buildCaseOverview(
      caseInput({
        agendas: [agenda({ status: 'withdrawn' })],
        ledger: [],
        consumers: [resolvedLock],
      })
    );
    expect(gone.tasks).toMatchObject({ held: 1, unresolvable: 1 });
    expect(gone.tasks.unresolvable_next).toMatch(/--from-tasks --reask .*mission supersede-task/u);
    // A task superseded by a verified approval is skipped entirely; a mark
    // alone (no verifier, or one that refuses it) is a live task.
    const marked = caseInput().consumers.map((item) => ({
      ...item,
      superseded: {
        by_consumer: `${item.consumer}-v2`,
        by_task_id: 'v2',
        at: CREATED,
        approval_request_id: '0f6c2a4e-8b1d-4c3a-9e2f-1a2b3c4d5e6f',
      },
    }));
    expect(buildCaseOverview(caseInput({ consumers: marked })).tasks).toMatchObject({
      pending_proposals: 2,
      held: 1,
    });
    expect(
      buildCaseOverview(caseInput({ consumers: marked, isSuperseded: () => false })).tasks
    ).toMatchObject({ pending_proposals: 2, held: 1 });
    const superseded = buildCaseOverview(
      caseInput({ consumers: marked, isSuperseded: (lock) => lock.superseded !== undefined })
    );
    expect(superseded.tasks).toEqual({
      pending_proposals: 0,
      held: 0,
      ready_to_resume: 0,
      unresolvable: 0,
    });
  });

  it('includes draft-only cases and shows no decision values or customer free text', () => {
    const draft = agenda({ status: 'draft', respond_by: undefined });
    const overview = buildCaseOverview(
      caseInput({ agendas: [draft], receipts: [], invites: [], consumers: [] })
    );
    expect(overview.draft_only).toBe(true);
    expect(overview.agendas[0]).toMatchObject({
      status: 'draft',
      answerable: false,
      unanswered_deciders: 0,
      reminders: { due: 0, upcoming: 0 },
    });
    const text = JSON.stringify(buildCaseOverview(caseInput()));
    expect(text).not.toContain(SECRET_COMMENT);
    expect(text).not.toContain(SECRET_QUESTION);
    expect(text).not.toContain('password');
    expect(text).not.toContain('"value"');
    // Titles and questions are for the tenant-scoped operator view.
    expect(text).toContain('Inception decisions');
    expect(text).toContain('Which sign-in method?');
  });
});

describe('buildCustomerDecisionOverview (CD-12)', () => {
  it('sums the cases and sorts what needs attention by urgency', () => {
    const a = buildCaseOverview(caseInput());
    const b = buildCaseOverview(
      caseInput({
        case_id: 'case-b',
        agendas: [agenda({ case_id: 'case-b', respond_by: '2026-10-29' })],
        receipts: [],
        invites: [invite({ case_id: 'case-b' })],
        consumers: [],
      })
    );
    const closed = buildCaseOverview(
      caseInput({
        case_id: 'case-c',
        agendas: [agenda({ case_id: 'case-c', status: 'closed' })],
        receipts: [],
        invites: [],
        consumers: [],
      })
    );
    const overview = buildCustomerDecisionOverview({
      tenant_slug: 'acme-corp',
      cases: [closed, b, a],
      case_failures: [{ case_id: 'case-z', diagnostic_code: 'DECISION_LEDGER_X' }],
      now: NOW,
    });
    expect(overview).toMatchObject({
      version: '1.0.0',
      tenant_slug: 'acme-corp',
      today: '2026-10-28',
      totals: {
        cases: 3,
        agendas: 3,
        open_agendas: 2,
        entries: 18,
        open_change_requests: 1,
        pending_handoffs: 1,
        held_tasks: 1,
        pending_task_proposals: 2,
      },
      case_failures: [{ case_id: 'case-z', diagnostic_code: 'DECISION_LEDGER_X' }],
    });
    expect(overview.cases.map((item) => item.case_id)).toEqual(['case-a', 'case-b', 'case-c']);
    const reasons = overview.attention.map((item) => `${item.reason}:${item.case_id}`);
    // Closed agendas raise nothing; order follows OVERVIEW_ATTENTION_ORDER.
    expect(reasons.some((reason) => reason.endsWith(':case-c'))).toBe(false);
    const ranks = overview.attention.map((item) => OVERVIEW_ATTENTION_ORDER.indexOf(item.reason));
    expect([...ranks].sort((x, y) => x - y)).toEqual(ranks);
    expect(reasons[0]).toBe('respond_by_overdue:case-a');
    expect(overview.attention).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'respond_by_due_soon',
          case_id: 'case-b',
          due: '2026-10-29',
          days: 1,
          title: 'Inception decisions',
        }),
        expect.objectContaining({ reason: 'override_closing_soon', case_id: 'case-a', days: 2 }),
        expect.objectContaining({ reason: 'held_tasks', case_id: 'case-a', count: 1 }),
        expect.objectContaining({ reason: 'awaiting_operator_confirmation', count: 1 }),
      ])
    );
    // Within one reason, the soonest first.
    const awaiting = overview.attention.filter((item) => item.reason === 'awaiting_customer');
    expect(awaiting.map((item) => item.case_id)).toEqual(['case-a', 'case-b']);
  });

  it('the summary form drops entries, caps attention and keeps the full count', () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      buildCaseOverview(
        caseInput({
          case_id: `case-${String(index).padStart(2, '0')}`,
          agendas: [agenda({ case_id: `case-${String(index).padStart(2, '0')}` })],
          invites: [invite({ case_id: `case-${String(index).padStart(2, '0')}` })],
        })
      )
    );
    const full = buildCustomerDecisionOverview({ tenant_slug: 'acme-corp', cases: many, now: NOW });
    expect(full.attention.length).toBeGreaterThan(50);
    expect(full.totals).not.toHaveProperty('attention_total');
    expect(full.cases[0].agendas[0].entries).toHaveLength(ENTRIES.length);
    const summary = summarizeCustomerDecisionOverview(full);
    expect(summary.attention).toEqual(full.attention.slice(0, 50));
    expect(summary.totals).toEqual({ ...full.totals, attention_total: full.attention.length });
    expect(summary.cases[0].agendas[0]).not.toHaveProperty('entries');
    expect(summary.cases[0].agendas[0].counts).toEqual(full.cases[0].agendas[0].counts);
    expect(JSON.stringify(summary)).not.toContain('Which sign-in method?');
    // The full form is left as it was.
    expect(full.cases[0].agendas[0].entries).toHaveLength(ENTRIES.length);
  });

  it('refuses a now that is not a timestamp', () => {
    expect(() => buildCaseOverview(caseInput({ now: 'soon' }))).toThrow(/NOW_INVALID/u);
  });
});
