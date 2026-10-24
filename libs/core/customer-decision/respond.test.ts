import { describe, expect, it } from 'vitest';
import type { DecisionCustomerActor, DecisionRecord } from '../decision-ledger/model.js';
import { agendaContentHash } from './hash.js';
import type { CustomerDecisionInvite } from './invite.js';
import type { DecisionAgenda, DecisionReceipt } from './model.js';
import {
  agendaAnswerState,
  buildResponseReceipt,
  findDuplicateReceipt,
  inviteeActorId,
  openChangeRequests,
  planCustomerResponse,
  type PlanCustomerResponseInput,
} from './respond.js';
import { resolveAgendaEffective } from './effective.js';

const NOW = '2026-10-24T00:00:00.000Z';
const ACTOR = 'customer:acme-cto';

function baseAgenda(): DecisionAgenda {
  const agenda: DecisionAgenda = {
    version: '1.0.0',
    agenda_id: 'agd-0123456789abcdef',
    tenant_slug: 'acme-corp',
    case_id: 'case-a',
    customer: 'acme',
    title: 'Inception decisions',
    phase: 'inception',
    revision: 1,
    locale: 'ja',
    entries: [
      {
        entry_id: 'nfr.auth',
        item: 'NFR',
        key: 'auth.method',
        kind: 'choice',
        question: 'Which sign-in method?',
        options: [
          { value: 'password', label: 'Password' },
          { value: 'sso', label: 'SSO', impact: { cost: '+10%' } },
        ],
        our_decision: { value: 'sso', decision_id: 'D-0001' },
        requires_customer: false,
      },
      {
        entry_id: 'release',
        item: 'RELEASE',
        key: 'release.go',
        kind: 'approval',
        question: 'Release?',
        requires_customer: true,
      },
      {
        entry_id: 'intent',
        item: 'INTENT',
        key: 'intent.goal',
        kind: 'hearing',
        question: 'What is the goal?',
        requires_customer: false,
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
        org_default: { value: 30, source: 'hearing:aidlc_inception' },
        requires_customer: false,
        override_until: { kind: 'date', at: '2026-10-01T00:00:00.000Z' },
      },
      {
        entry_id: 'mvp',
        item: 'SCOPE',
        key: 'mvp.order',
        kind: 'ranking',
        question: 'Order the units',
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
          { value: 'c', label: 'C' },
        ],
        requires_customer: false,
      },
    ],
    status: 'sent',
    created_at: NOW,
    updated_at: NOW,
  };
  agenda.approval = {
    content_hash: agendaContentHash(agenda),
    request_id: 'apr-1',
    approved_at: NOW,
    approved_by: 'user:boss',
  };
  return agenda;
}

const ledger: DecisionRecord[] = [
  {
    id: 'D-0001',
    case_id: 'case-a',
    item: 'NFR',
    key: 'auth.method',
    level: 'customer-value',
    state: 'proposed',
    value: 'sso',
    basis: [{ ref: 'agenda:agd-0123456789abcdef', version: 'h' }],
    origin: 'facade',
    status: 'active',
  },
];

function invite(role: 'decider' | 'contributor' = 'decider'): CustomerDecisionInvite {
  return {
    version: '1.0.0',
    invite_id: 'inv-0123456789abcdef',
    tenant_slug: 'acme-corp',
    case_id: 'case-a',
    agenda_id: 'agd-0123456789abcdef',
    participant: { name: 'Hanako', role, actor_id: ACTOR },
    secret_sha256: 'a'.repeat(64),
    created_at: NOW,
    expires_at: '2026-11-07T00:00:00.000Z',
    created_by: 'user:alice',
    uses: [],
  };
}

const actors: DecisionCustomerActor[] = [{ id: ACTOR, name: 'CTO', decides: ['customer-value'] }];

function input(overrides: Partial<PlanCustomerResponseInput> = {}): PlanCustomerResponseInput {
  const agenda = overrides.agenda ?? baseAgenda();
  return {
    agenda,
    ledger,
    invite: invite(),
    content_hash: agenda.approval?.content_hash,
    answers: [],
    customerActors: actors,
    receiptId: 'rcp-0000000000000001',
    now: NOW,
    ...overrides,
  };
}

describe('planCustomerResponse', () => {
  it('turns a decider option into a customer decision superseding ours', () => {
    const result = planCustomerResponse(
      input({ answers: [{ entry_id: 'nfr.auth', choice: 'option', value: 'password' }] })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.appends).toEqual([
      expect.objectContaining({
        item: 'NFR',
        key: 'auth.method',
        level: 'customer-value',
        state: 'decided',
        value: 'password',
        supersedes: 'D-0001',
        origin: 'facade',
        decided_at: NOW,
        basis: [{ ref: 'agenda:agd-0123456789abcdef', version: result.plan.content_hash }],
        decided_by: {
          kind: 'human',
          id: 'user:inv-0123456789abcdef',
          display_name: 'Hanako',
          on_behalf_of: { actor_id: ACTOR, evidence: 'rcp-0000000000000001' },
        },
      }),
    ]);
    expect(result.plan.answers[0]).toMatchObject({ outcome: 'decided', append_index: 0 });
  });

  it('keep adopts the current effective value; refused while awaiting or undecided', () => {
    const kept = planCustomerResponse(
      input({ answers: [{ entry_id: 'nfr.auth', choice: 'keep' }] })
    );
    expect(kept.ok && kept.plan.appends[0]?.value).toBe('sso');
    expect(kept.ok && kept.plan.answers[0].answer).toEqual({
      entry_id: 'nfr.auth',
      choice: 'keep',
      value: 'sso',
    });
    for (const entry_id of ['release', 'intent', 'mvp']) {
      expect(planCustomerResponse(input({ answers: [{ entry_id, choice: 'keep' }] }))).toEqual({
        ok: false,
        reason: 'invalid_answers',
        errors: [{ entry_id, error: 'keep_not_available' }],
      });
    }
  });

  it('validates options by canonical JSON, rankings as ordered subsets', () => {
    expect(
      planCustomerResponse(
        input({ answers: [{ entry_id: 'nfr.auth', choice: 'option', value: 'magic-link' }] })
      )
    ).toMatchObject({ ok: false, errors: [{ error: 'option_not_offered' }] });
    expect(
      planCustomerResponse(
        input({ answers: [{ entry_id: 'mvp', choice: 'option', value: ['b', 'a'] }] })
      ).ok
    ).toBe(true);
    expect(
      planCustomerResponse(
        input({ answers: [{ entry_id: 'mvp', choice: 'option', value: ['b', 'b'] }] })
      )
    ).toMatchObject({ ok: false, errors: [{ error: 'option_not_offered' }] });
    expect(
      planCustomerResponse(input({ answers: [{ entry_id: 'nfr.auth', choice: 'option' }] }))
    ).toMatchObject({ ok: false, errors: [{ error: 'option_not_offered' }] });
  });

  it('allows approve / request_changes only on approval entries', () => {
    const approved = planCustomerResponse(
      input({ answers: [{ entry_id: 'release', choice: 'approve' }] })
    );
    expect(approved.ok && approved.plan.appends[0].value).toEqual({ approved: true });
    expect(approved.ok && approved.plan.appends[0].supersedes).toBeUndefined();
    const changes = planCustomerResponse(
      input({ answers: [{ entry_id: 'release', choice: 'request_changes', comment: 'not yet' }] })
    );
    expect(changes.ok && changes.plan.appends[0].value).toEqual({
      approved: false,
      comment: 'not yet',
    });
    expect(
      planCustomerResponse(input({ answers: [{ entry_id: 'release', choice: 'request_changes' }] }))
    ).toMatchObject({ ok: false, errors: [{ error: 'text_required' }] });
    expect(
      planCustomerResponse(input({ answers: [{ entry_id: 'nfr.auth', choice: 'approve' }] }))
    ).toMatchObject({ ok: false, errors: [{ error: 'choice_not_allowed' }] });
  });

  it('approve adopts the approved draft value when the entry carries one', () => {
    const agenda = baseAgenda();
    agenda.entries[1] = { ...agenda.entries[1], our_decision: { value: { stories: 3 } } };
    agenda.approval = { ...agenda.approval!, content_hash: agendaContentHash(agenda) };
    const result = planCustomerResponse(
      input({ agenda, answers: [{ entry_id: 'release', choice: 'approve' }] })
    );
    expect(result.ok && result.plan.appends[0].value).toEqual({ stories: 3 });
  });

  it('free text decides a hearing entry and is comment-only elsewhere', () => {
    const result = planCustomerResponse(
      input({
        answers: [
          { entry_id: 'intent', choice: 'free_text', value: 'cut manual work' },
          { entry_id: 'nfr.auth', choice: 'free_text', comment: 'none of these' },
        ],
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.appends.map((record) => record.value)).toEqual(['cut manual work']);
    expect(result.plan.answers.map((item) => item.outcome)).toEqual(['decided', 'recorded']);
    expect(
      planCustomerResponse(input({ answers: [{ entry_id: 'intent', choice: 'free_text' }] }))
    ).toMatchObject({ ok: false, errors: [{ error: 'text_required' }] });
  });

  it('a contributor never reaches the ledger', () => {
    const result = planCustomerResponse(
      input({
        invite: invite('contributor'),
        answers: [{ entry_id: 'nfr.auth', choice: 'option', value: 'password' }],
      })
    );
    expect(result.ok && result.plan.appends).toEqual([]);
    expect(result.ok && result.plan.answers[0].outcome).toBe('recorded');
  });

  it('turns a different value after the override window into a change request', () => {
    const result = planCustomerResponse(
      input({
        answers: [{ entry_id: 'retention', choice: 'option', value: 90, comment: 'audit needs' }],
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.appends).toEqual([]);
    expect(result.plan.change_requests).toEqual([
      { entry_id: 'retention', value: 90, comment: 'audit needs' },
    ]);
    // Confirming the value in force is not an override.
    const confirm = planCustomerResponse(
      input({ answers: [{ entry_id: 'retention', choice: 'keep' }] })
    );
    expect(confirm.ok && confirm.plan.appends[0].value).toBe(30);
  });

  it('is idempotent against the same customer value', () => {
    const decided: DecisionRecord[] = [
      { ...ledger[0], status: 'superseded' },
      {
        id: 'D-0002',
        case_id: 'case-a',
        item: 'NFR',
        key: 'auth.method',
        level: 'customer-value',
        state: 'decided',
        value: 'password',
        basis: [{ ref: 'agenda:x', version: 'h' }],
        origin: 'facade',
        status: 'active',
        supersedes: 'D-0001',
        decided_by: {
          kind: 'human',
          id: 'user:inv-0123456789abcdef',
          on_behalf_of: { actor_id: ACTOR, evidence: 'rcp-x' },
        },
      },
    ];
    const result = planCustomerResponse(
      input({
        ledger: decided,
        answers: [{ entry_id: 'nfr.auth', choice: 'option', value: 'password' }],
      })
    );
    expect(result.ok && result.plan.appends).toEqual([]);
    expect(result.ok && result.plan.answers[0].outcome).toBe('unchanged');
    // A different value supersedes the customer's own earlier decision.
    const changed = planCustomerResponse(
      input({
        ledger: decided,
        answers: [{ entry_id: 'nfr.auth', choice: 'option', value: 'sso' }],
      })
    );
    expect(changed.ok && changed.plan.appends[0].supersedes).toBe('D-0002');
  });

  it('binds the answer to the approved revision', () => {
    const agenda = baseAgenda();
    expect(planCustomerResponse(input({ content_hash: 'f'.repeat(64) }))).toEqual({
      ok: false,
      reason: 'stale_version',
    });
    const edited = { ...agenda, title: 'Edited after sending' };
    expect(planCustomerResponse(input({ agenda: edited }))).toEqual({
      ok: false,
      reason: 'updating',
    });
    expect(agendaAnswerState({ ...agenda, status: 'draft' })).toEqual({
      ok: false,
      reason: 'updating',
    });
    expect(agendaAnswerState({ ...agenda, status: 'withdrawn' })).toEqual({
      ok: false,
      reason: 'closed',
    });
  });

  it('refuses an invite of another agenda, malformed answers and unknown or duplicate entries', () => {
    expect(
      planCustomerResponse(input({ invite: { ...invite(), agenda_id: 'agd-ffffffffffffffff' } }))
    ).toEqual({ ok: false, reason: 'invalid_link' });
    expect(planCustomerResponse(input({ answers: 'x' }))).toMatchObject({
      reason: 'invalid_answers',
    });
    expect(planCustomerResponse(input({ answers: [] }))).toMatchObject({
      reason: 'invalid_answers',
    });
    expect(
      planCustomerResponse(
        input({
          answers: [
            { entry_id: 'nope', choice: 'keep' },
            { entry_id: 'nfr.auth', choice: 'keep' },
            { entry_id: 'nfr.auth', choice: 'keep' },
            { entry_id: 'intent', choice: 'bogus' },
          ],
        })
      )
    ).toEqual({
      ok: false,
      reason: 'invalid_answers',
      errors: [
        { entry_id: 'nope', error: 'unknown_entry' },
        { entry_id: 'nfr.auth', error: 'duplicate_entry' },
        { entry_id: 'intent', error: 'choice_invalid' },
      ],
    });
  });

  it('requires a registered, entitled customer actor for a decider', () => {
    const answers = [{ entry_id: 'nfr.auth', choice: 'keep' }];
    expect(planCustomerResponse(input({ answers, customerActors: [] }))).toEqual({
      ok: false,
      reason: 'not_entitled',
    });
    expect(
      planCustomerResponse(
        input({ answers, customerActors: [{ id: ACTOR, name: 'CTO', decides: ['product-fixed'] }] })
      )
    ).toEqual({ ok: false, reason: 'not_entitled' });
    // A contributor needs no entitlement.
    expect(
      planCustomerResponse(input({ answers, customerActors: [], invite: invite('contributor') })).ok
    ).toBe(true);
  });
});

describe('receipts, duplicates and change requests', () => {
  it('builds the receipt, detects a double submit and lists open change requests', () => {
    const agenda = baseAgenda();
    const result = planCustomerResponse(
      input({
        answers: [
          { entry_id: 'retention', choice: 'option', value: 90 },
          { entry_id: 'nfr.auth', choice: 'free_text', comment: 'call me' },
        ],
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const receipt: DecisionReceipt = buildResponseReceipt(result.plan, agenda, invite(), [], NOW);
    expect(receipt).toMatchObject({
      receipt_id: 'rcp-0000000000000001',
      identity_assurance: 'invite_link',
      content_hash: agenda.approval?.content_hash,
      decision_ids: [],
    });
    expect(receipt.answers.map((answer) => [answer.entry_id, answer.outcome])).toEqual([
      ['retention', 'change_request'],
      ['nfr.auth', 'opinion'],
    ]);
    expect(findDuplicateReceipt(result.plan, invite(), [receipt])).toBe(receipt);
    expect(
      findDuplicateReceipt(result.plan, { invite_id: 'inv-ffffffffffffffff' }, [receipt])
    ).toBeUndefined();
    const effective = resolveAgendaEffective(agenda, ledger, { now: NOW });
    expect(openChangeRequests(agenda, [receipt], effective)).toEqual([
      { receipt_id: receipt.receipt_id, entry_id: 'retention', value: 90, at: NOW },
    ]);
  });

  it('lists change requests from recorded outcomes, not from answer values', () => {
    const agenda = baseAgenda();
    const effective = resolveAgendaEffective(agenda, ledger, { now: NOW });
    const receipt = (
      answers: DecisionReceipt['answers'],
      id = 'rcp-0000000000000001'
    ): DecisionReceipt => ({
      version: '1.0.0',
      receipt_id: id,
      tenant_slug: agenda.tenant_slug,
      case_id: agenda.case_id,
      agenda_id: agenda.agenda_id,
      agenda_revision: agenda.revision,
      content_hash: agenda.approval!.content_hash,
      invite_id: invite().invite_id,
      participant: { name: 'Hanako', role: 'decider', actor_id: 'customer:acme-cto' },
      answers,
      identity_assurance: 'invite_link',
      submitted_at: NOW,
      decision_ids: [],
    });
    // A decided answer whose value is not in force (e.g. an operator applied ours later)
    // is not a change request.
    expect(
      openChangeRequests(
        agenda,
        [receipt([{ entry_id: 'retention', choice: 'option', value: 90, outcome: 'decided' }])],
        effective
      )
    ).toEqual([]);
    // A later decided answer closes an earlier change request.
    expect(
      openChangeRequests(
        agenda,
        [
          receipt([
            { entry_id: 'retention', choice: 'option', value: 90, outcome: 'change_request' },
          ]),
          receipt(
            [{ entry_id: 'retention', choice: 'option', value: 90, outcome: 'decided' }],
            'rcp-0000000000000002'
          ),
        ],
        effective
      )
    ).toEqual([]);
  });

  it('derives the invitee actor id from the invite id', () => {
    expect(inviteeActorId(invite())).toBe('user:inv-0123456789abcdef');
  });
});
