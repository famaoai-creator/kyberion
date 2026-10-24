import { describe, expect, it } from 'vitest';
import type { DecisionRecord } from '../decision-ledger/model.js';
import { renderCustomerRoutineTemplate } from '../customer-outbound-templates.js';
import { resolveAgendaEffective } from './effective.js';
import { agendaContentHash } from './hash.js';
import type { CustomerDecisionInvite } from './invite.js';
import type { DecisionAgenda, DecisionReceipt } from './model.js';
import {
  addUtcDays,
  dueAgendaReminders,
  handoffInboxEntryId,
  handoffTargets,
  isCalendarDate,
  isHandoffDone,
  reminderId,
  scheduleAgendaReminders,
  upcomingAgendaReminders,
  utcDate,
  type ReminderPlanInput,
} from './reminders.js';

const CREATED = '2026-10-20T00:00:00.000Z';
const ACTOR = 'customer:acme-cto';
const OTHER = 'customer:acme-pm';

function agenda(over: Partial<DecisionAgenda> = {}): DecisionAgenda {
  const base: DecisionAgenda = {
    version: '1.0.0',
    agenda_id: 'agd-0123456789abcdef',
    tenant_slug: 'acme-corp',
    case_id: 'case-a',
    customer: 'acme',
    title: 'Inception decisions',
    phase: 'inception',
    revision: 1,
    locale: 'en',
    respond_by: '2026-10-30',
    entries: [
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
        override_until: { kind: 'date', at: '2026-11-05T09:00:00.000Z' },
      },
    ],
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

function invite(
  id: string,
  actorId: string,
  over: Partial<CustomerDecisionInvite> = {}
): CustomerDecisionInvite {
  return {
    version: '1.0.0',
    invite_id: id,
    tenant_slug: 'acme-corp',
    case_id: 'case-a',
    agenda_id: 'agd-0123456789abcdef',
    participant: { name: 'Hanako', role: 'decider', actor_id: actorId },
    secret_sha256: 'a'.repeat(64),
    created_at: CREATED,
    expires_at: '2026-11-30T00:00:00.000Z',
    created_by: 'user:alice',
    uses: [],
    ...over,
  };
}

const OURS: DecisionRecord = {
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
} as DecisionRecord;

function input(
  a: DecisionAgenda,
  now: string,
  over: Partial<ReminderPlanInput> = {}
): ReminderPlanInput {
  return {
    agenda: a,
    invites: [invite('inv-0000000000000001', ACTOR)],
    receipts: [],
    effective: resolveAgendaEffective(a, [OURS], { now }),
    now,
    ...over,
  };
}

function receipt(
  a: DecisionAgenda,
  actorId: string,
  over: Partial<DecisionReceipt> = {}
): DecisionReceipt {
  return {
    version: '1.0.0',
    receipt_id: 'rcp-0000000000000001',
    tenant_slug: 'acme-corp',
    case_id: 'case-a',
    agenda_id: a.agenda_id,
    agenda_revision: a.revision,
    content_hash: agendaContentHash(a),
    invite_id: 'inv-0000000000000001',
    participant: { name: 'Hanako', role: 'decider', actor_id: actorId },
    answers: [{ entry_id: 'auth', choice: 'option', value: 'password', outcome: 'decided' }],
    identity_assurance: 'invite_link',
    submitted_at: '2026-10-25T00:00:00.000Z',
    decision_ids: ['D-0002'],
    ...over,
  };
}

const kinds = (list: Array<{ kind: string }>) => list.map((item) => item.kind);

describe('UTC date helpers', () => {
  it('works on UTC calendar dates whatever the offset of the timestamp', () => {
    // 2026-10-29T23:30-01:00 is already the 30th in UTC; 23:30+09:00 is still the 29th.
    expect(utcDate('2026-10-29T23:30:00.000-01:00')).toBe('2026-10-30');
    expect(utcDate('2026-10-29T23:30:00.000+09:00')).toBe('2026-10-29');
    expect(utcDate('not a date')).toBeNull();
    expect(addUtcDays('2026-11-01', -1)).toBe('2026-10-31');
    expect(addUtcDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(isCalendarDate('2026-02-30')).toBe(false);
    expect(isCalendarDate('2026-10-30')).toBe(true);
    expect(isCalendarDate('2026-10-30T00:00:00Z')).toBe(false);
  });
});

describe('dueAgendaReminders', () => {
  it('reminds an undecided decider on the day before respond_by and on the day (UTC)', () => {
    const a = agenda();
    expect(dueAgendaReminders(input(a, '2026-10-28T12:00:00.000Z'))).toEqual([]);
    const before = dueAgendaReminders(input(a, '2026-10-29T00:00:00.000Z'));
    expect(kinds(before)).toEqual(['before_due']);
    expect(before[0]).toMatchObject({
      actor_id: ACTOR,
      target_date: '2026-10-30',
      send_on: '2026-10-29',
      invite_ids: ['inv-0000000000000001'],
      reminder_id: reminderId(a.agenda_id, ACTOR, 'before_due', '2026-10-30'),
      template: {
        id: 'customer_decision.reminder.before_due',
        params: { title: 'Inception decisions', date: '2026-10-30' },
        locale: 'en',
      },
    });
    // The rendered template is the registered routine text.
    expect(renderCustomerRoutineTemplate(before[0].template)).toContain('2026-10-30');
    // 23:59 UTC on the 29th is still D-1; a +09:00 clock already on the 30th is not D0 yet.
    expect(kinds(dueAgendaReminders(input(a, '2026-10-30T08:59:00.000+09:00')))).toEqual([
      'before_due',
    ]);
    expect(kinds(dueAgendaReminders(input(a, '2026-10-30T23:59:59.000Z')))).toEqual(['due']);
    expect(dueAgendaReminders(input(a, '2026-10-31T00:00:00.000Z'))).toEqual([]);
  });

  it('skips a decider who answered the current revision, but not an earlier one', () => {
    const a = agenda();
    const now = '2026-10-30T09:00:00.000Z';
    expect(dueAgendaReminders(input(a, now, { receipts: [receipt(a, ACTOR)] }))).toEqual([]);
    const stale = receipt(a, ACTOR, { content_hash: 'b'.repeat(64) });
    expect(kinds(dueAgendaReminders(input(a, now, { receipts: [stale] })))).toEqual(['due']);
    // A contributor's receipt does not count for the decider.
    const contributor = receipt(a, ACTOR, {
      participant: { name: 'H', role: 'contributor', actor_id: ACTOR },
    });
    expect(kinds(dueAgendaReminders(input(a, now, { receipts: [contributor] })))).toEqual(['due']);
  });

  it('only reminds deciders with a valid invite: not revoked, not expired, not contributors', () => {
    const a = agenda();
    const now = '2026-10-30T09:00:00.000Z';
    const invites = [
      invite('inv-0000000000000002', OTHER, { revoked_at: '2026-10-26T00:00:00.000Z' }),
      invite('inv-0000000000000003', 'customer:acme-late', {
        expires_at: '2026-10-30T09:00:00.000Z',
      }),
      invite('inv-0000000000000004', 'customer:acme-helper', {
        participant: { name: 'X', role: 'contributor', actor_id: 'customer:acme-helper' },
      }),
      invite('inv-0000000000000005', 'customer:acme-elsewhere', {
        agenda_id: 'agd-ffffffffffffffff',
      }),
    ];
    expect(dueAgendaReminders(input(a, now, { invites }))).toEqual([]);
    // Two valid invites of one actor make one reminder.
    const both = [invite('inv-0000000000000001', ACTOR), invite('inv-0000000000000006', ACTOR)];
    const due = dueAgendaReminders(input(a, now, { invites: both }));
    expect(due).toHaveLength(1);
    expect(due[0].invite_ids).toEqual(['inv-0000000000000001', 'inv-0000000000000006']);
  });

  it('sends nothing for closed, withdrawn, unsent or edited-but-not-re-approved agendas', () => {
    const now = '2026-10-30T09:00:00.000Z';
    for (const status of ['closed', 'withdrawn', 'approved', 'draft'] as const) {
      expect(dueAgendaReminders(input(agenda({ status }), now))).toEqual([]);
    }
    const edited = { ...agenda(), title: 'Edited after approval' };
    expect(dueAgendaReminders(input(edited, now))).toEqual([]);
    // No respond_by: no answer reminders.
    const noDate = agenda({ respond_by: undefined });
    expect(dueAgendaReminders(input(noDate, now))).toEqual([]);
  });

  it('notices an override deadline from two days before while our decision is in force', () => {
    const a = agenda({ respond_by: undefined });
    expect(dueAgendaReminders(input(a, '2026-11-02T23:00:00.000Z'))).toEqual([]);
    const notice = dueAgendaReminders(input(a, '2026-11-03T00:00:00.000Z'));
    expect(notice).toMatchObject([
      { kind: 'override_closing', target_date: '2026-11-05', send_on: '2026-11-03' },
    ]);
    // A missed run catches up until the window closes (09:00 UTC on the 5th).
    expect(kinds(dueAgendaReminders(input(a, '2026-11-05T08:59:00.000Z')))).toEqual([
      'override_closing',
    ]);
    expect(dueAgendaReminders(input(a, '2026-11-05T09:00:00.000Z'))).toEqual([]);
    // The customer decided: our decision is no longer in force, no notice.
    const customer: DecisionRecord = {
      ...OURS,
      id: 'D-0002',
      state: 'decided',
      decided_by: {
        kind: 'human',
        id: 'user:inv-0000000000000001',
        on_behalf_of: { actor_id: ACTOR, evidence: 'rcp-0000000000000001' },
      },
      decided_at: '2026-10-25T00:00:00.000Z',
      supersedes: 'D-0001',
    } as DecisionRecord;
    const now = '2026-11-04T00:00:00.000Z';
    const decided = resolveAgendaEffective(a, [{ ...OURS, status: 'superseded' }, customer], {
      now,
    });
    expect(dueAgendaReminders(input(a, now, { effective: decided }))).toEqual([]);
  });

  it('is idempotent: a settled record stops the reminder; approval_pending plans it again', () => {
    const now = '2026-10-29T10:00:00.000Z';
    const first = dueAgendaReminders(input(agenda(), now));
    expect(first).toHaveLength(1);
    const record = (status: 'sent' | 'approval_pending' | 'manual' | 'denied') => ({
      reminder_id: first[0].reminder_id,
      kind: first[0].kind,
      actor_id: ACTOR,
      target_date: first[0].target_date,
      status,
      at: now,
    });
    for (const status of ['sent', 'manual', 'denied'] as const) {
      expect(dueAgendaReminders(input(agenda({ reminders: [record(status)] }), now))).toEqual([]);
    }
    expect(
      dueAgendaReminders(input(agenda({ reminders: [record('approval_pending')] }), now))
    ).toHaveLength(1);
    // Records stay outside the content hash.
    expect(agendaContentHash(agenda({ reminders: [record('sent')] }))).toBe(
      agendaContentHash(agenda())
    );
  });
});

describe('scheduleAgendaReminders / upcomingAgendaReminders', () => {
  it('lists what is still to come, earliest first', () => {
    const a = agenda();
    const upcoming = upcomingAgendaReminders(input(a, '2026-10-25T00:00:00.000Z'));
    expect(upcoming.map((item) => [item.kind, item.send_on])).toEqual([
      ['before_due', '2026-10-29'],
      ['due', '2026-10-30'],
      ['override_closing', '2026-11-03'],
    ]);
    expect(scheduleAgendaReminders(input(a, '2026-10-25T00:00:00.000Z'))).toHaveLength(3);
    expect(
      upcomingAgendaReminders(input(a, '2026-10-30T00:00:00.000Z')).map((r) => r.kind)
    ).toEqual(['override_closing']);
  });
});

describe('respond_by in the content hash', () => {
  it('binds respond_by only when set', () => {
    const a = agenda();
    const { respond_by: _date, ...without } = a;
    void _date;
    expect(agendaContentHash(without)).not.toBe(agendaContentHash(a));
    expect(agendaContentHash({ ...a, respond_by: '2026-10-31' })).not.toBe(agendaContentHash(a));
  });
});

describe('handoffTargets', () => {
  const a = agenda({
    entries: [
      ...agenda().entries,
      {
        entry_id: 'goal',
        item: 'INTENT',
        key: 'goal',
        kind: 'hearing',
        question: 'Goal?',
        requires_customer: false,
      },
      {
        entry_id: 'ok',
        item: 'REL',
        key: 'go',
        kind: 'approval',
        question: 'OK?',
        our_decision: { value: { approved: true } },
        requires_customer: false,
      },
    ],
  });

  it('counts off-option answers, comments and a general question per receipt', () => {
    const r1 = receipt(a, ACTOR, {
      answers: [
        { entry_id: 'auth', choice: 'free_text', comment: 'we want passkeys', outcome: 'opinion' },
        { entry_id: 'goal', choice: 'free_text', value: 'faster', outcome: 'decided' },
        {
          entry_id: 'ok',
          choice: 'request_changes',
          value: { approved: false },
          comment: 'fix',
          outcome: 'decided',
        },
      ],
    });
    const r2 = receipt(a, ACTOR, {
      receipt_id: 'rcp-0000000000000002',
      answers: [],
      general_question: 'Can we also talk about hosting?',
    });
    const r3 = receipt(a, ACTOR, { receipt_id: 'rcp-0000000000000003' });
    expect(handoffTargets(a, [r1, r2, r3])).toEqual([
      { receipt_id: r1.receipt_id, off_option: 1, comments: 1, general_question: 0 },
      { receipt_id: r2.receipt_id, off_option: 0, comments: 0, general_question: 1 },
    ]);
    // On a bolt review, request_changes / reject go through bolt_routing (CD-10), not here.
    expect(handoffTargets({ ...a, bolt_mission_id: 'MSN-X' }, [r1])).toEqual([
      { receipt_id: r1.receipt_id, off_option: 1, comments: 0, general_question: 0 },
    ]);
  });

  it('keys the inbox entry by agenda × receipt and treats a notified record as done', () => {
    const id = handoffInboxEntryId(a.agenda_id, 'rcp-0000000000000001');
    expect(id).toMatch(/^INBOX-CDH-[0-9A-F]{16}$/u);
    expect(handoffInboxEntryId(a.agenda_id, 'rcp-0000000000000002')).not.toBe(id);
    const record = {
      receipt_id: 'rcp-0000000000000001',
      off_option: 1,
      comments: 0,
      general_question: 0,
      inbox_entry_id: id,
      at: CREATED,
    };
    expect(isHandoffDone({ receipt_id: record.receipt_id }, [record])).toBe(false);
    expect(
      isHandoffDone({ receipt_id: record.receipt_id }, [{ ...record, notified_at: CREATED }])
    ).toBe(true);
  });
});
