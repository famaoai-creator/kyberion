import { describe, expect, it } from 'vitest';
import type { DecisionRecord } from '../decision-ledger/model.js';
import { renderCustomerRoutineTemplate } from '../customer-outbound-templates.js';
import { resolveAgendaEffective } from './effective.js';
import { agendaContentHash } from './hash.js';
import type { CustomerDecisionInvite } from './invite.js';
import type { AgendaReminderRecord, DecisionAgenda, DecisionReceipt } from './model.js';
import {
  addUtcDays,
  displayClosingMoment,
  dueAgendaReminders,
  hasAnsweredAll,
  handoffInboxEntryId,
  handoffTargets,
  isCalendarDate,
  isCoveredByEarlierReminder,
  isHandoffDone,
  lapsedAgendaReminders,
  REMINDER_CARRY_OVER_DAYS,
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
    // Re-approved after an edit (status `approved`, invites still out): reminded.
    expect(dueAgendaReminders(input(agenda({ status: 'approved' }), now))).toHaveLength(1);
    // Approved but never sent: no invites, nobody to remind.
    expect(dueAgendaReminders(input(agenda({ status: 'approved' }), now, { invites: [] }))).toEqual(
      []
    );
    for (const status of ['closed', 'withdrawn', 'draft'] as const) {
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

describe('hasAnsweredAll (CD-11 review)', () => {
  const two = agenda({
    entries: [
      ...agenda().entries,
      {
        entry_id: 'locale',
        item: 'NFR',
        key: 'ui.locale',
        kind: 'choice',
        question: 'Languages?',
        options: [{ value: ['ja'], label: 'ja' }],
        requires_customer: false,
      },
      {
        entry_id: 'closed',
        item: 'DATA',
        key: 'retention',
        kind: 'choice',
        question: 'Retention?',
        options: [{ value: 30, label: '30' }],
        requires_customer: false,
        override_until: { kind: 'date', at: '2026-10-01T00:00:00.000Z' },
      },
    ],
  });
  const hash = agendaContentHash(two);
  const now = '2026-10-30T09:00:00.000Z';
  const r = (
    id: string,
    answers: DecisionReceipt['answers'],
    over: Partial<DecisionReceipt> = {}
  ) => receipt(two, ACTOR, { receipt_id: id, answers, ...over });

  it('needs every open entry answered with a decision; closed entries do not count', () => {
    const auth = {
      entry_id: 'auth',
      choice: 'option' as const,
      value: 'sso',
      outcome: 'decided' as const,
    };
    const locale = {
      entry_id: 'locale',
      choice: 'option' as const,
      value: ['ja'],
      outcome: 'unchanged' as const,
    };
    // Partial: one of two open entries.
    expect(hasAnsweredAll(two, [r('rcp-0000000000000011', [auth])], ACTOR, hash, now)).toBe(false);
    // Spread over two receipts of the same actor: answered ('closed' is past its window).
    expect(
      hasAnsweredAll(
        two,
        [r('rcp-0000000000000011', [auth]), r('rcp-0000000000000012', [locale])],
        ACTOR,
        hash,
        now
      )
    ).toBe(true);
    // A general question alone, or comment-only opinions, are not answers.
    expect(
      hasAnsweredAll(
        two,
        [r('rcp-0000000000000013', [], { general_question: 'Hosting?' })],
        ACTOR,
        hash,
        now
      )
    ).toBe(false);
    const opinion = {
      entry_id: 'locale',
      choice: 'free_text' as const,
      comment: 'hmm',
      outcome: 'opinion' as const,
    };
    expect(
      hasAnsweredAll(two, [r('rcp-0000000000000014', [auth, opinion])], ACTOR, hash, now)
    ).toBe(false);
    // Another actor's or an older revision's receipts do not count.
    expect(
      hasAnsweredAll(
        two,
        [r('rcp-0000000000000015', [auth, locale], { content_hash: 'c'.repeat(64) })],
        ACTOR,
        hash,
        now
      )
    ).toBe(false);
    expect(
      hasAnsweredAll(two, [receipt(two, OTHER, { answers: [auth, locale] })], ACTOR, hash, now)
    ).toBe(false);
  });

  it('keeps reminding a decider who answered only part of the agenda', () => {
    const partial = r('rcp-0000000000000016', [
      { entry_id: 'auth', choice: 'option', value: 'sso', outcome: 'decided' },
    ]);
    expect(kinds(dueAgendaReminders(input(two, now, { receipts: [partial] })))).toEqual(['due']);
  });
});

describe('override_closing closing moment (CD-11 review)', () => {
  it('shows the closing moment in the agenda display zone, not the UTC date', () => {
    // A 00:00Z close is 09:00 on the same day in Japan, and the end of the
    // previous day in UTC is the last full day open.
    expect(displayClosingMoment('2026-11-05T00:00:00.000Z', 'ja')).toEqual({
      date: '2026-11-05',
      time: '09:00',
      zone: 'JST',
    });
    expect(displayClosingMoment('2026-11-05T00:00:00.000Z', 'en')).toEqual({
      date: '2026-11-05',
      time: '00:00',
      zone: 'UTC',
    });
    // 20:00Z on the 4th is already the 5th in Japan.
    expect(displayClosingMoment('2026-11-04T20:00:00.000Z', 'ja')).toEqual({
      date: '2026-11-05',
      time: '05:00',
      zone: 'JST',
    });
  });

  it('puts the closing moment into the override notice template', () => {
    const a = agenda({ respond_by: undefined, locale: 'ja' });
    const [notice] = dueAgendaReminders(input(a, '2026-11-03T00:00:00.000Z'));
    expect(notice.template).toEqual({
      id: 'customer_decision.reminder.override_closing',
      params: { title: 'Inception decisions', date: '2026-11-05', time: '18:00', zone: 'JST' },
      locale: 'ja',
    });
    expect(renderCustomerRoutineTemplate(notice.template)).toEqual(expect.any(String));
  });
});

describe('held reminders after their day (CD-11 follow-up: approval after the sweep)', () => {
  const D_MINUS_1 = '2026-10-29T10:00:00.000Z';
  const D0 = '2026-10-30T01:00:00.000Z';
  const D_PLUS_1 = '2026-10-31T01:00:00.000Z';
  const held = (
    kind: 'before_due' | 'due',
    status: AgendaReminderRecord['status'] = 'approval_pending',
    at = D_MINUS_1
  ): AgendaReminderRecord => ({
    reminder_id: reminderId('agd-0123456789abcdef', ACTOR, kind, '2026-10-30'),
    kind,
    actor_id: ACTOR,
    target_date: '2026-10-30',
    status,
    approval_request_id: 'apr-1',
    at,
  });

  it('carries a held before_due to the due day under its original key, and no further', () => {
    expect(REMINDER_CARRY_OVER_DAYS).toBe(1);
    const a = agenda({ reminders: [held('before_due')] });
    const due = dueAgendaReminders(input(a, D0));
    expect(due.map((item) => [item.kind, item.carried_over ?? false]).sort()).toEqual([
      ['before_due', true],
      ['due', false],
    ]);
    // The original key and text: an approval of that exact text still matches.
    const carried = due.find((item) => item.kind === 'before_due')!;
    expect(carried.reminder_id).toBe(held('before_due').reminder_id);
    expect(carried.template.params).toEqual({ title: 'Inception decisions', date: '2026-10-30' });
    expect(lapsedAgendaReminders(input(a, D0))).toEqual([]);
    // Without a hold nothing is carried: a before_due never asked is not sent late.
    expect(kinds(dueAgendaReminders(input(agenda(), D0)))).toEqual(['due']);
    // The day after the date it is about: dropped, not sent.
    expect(dueAgendaReminders(input(a, D_PLUS_1))).toEqual([]);
    expect(lapsedAgendaReminders(input(a, D_PLUS_1))).toEqual([held('before_due')]);
  });

  it('never carries a due reminder (its text says today): a held due lapses the next day', () => {
    const a = agenda({ reminders: [held('due', 'approval_pending', D0)] });
    expect(kinds(dueAgendaReminders(input(a, D0)))).toEqual(['due']);
    expect(dueAgendaReminders(input(a, D_PLUS_1))).toEqual([]);
    expect(lapsedAgendaReminders(input(a, D_PLUS_1)).map((item) => item.kind)).toEqual(['due']);
  });

  it("a carried-over before_due sent on the due day covers that decider's due", () => {
    const sentOnTheDay = agenda({ reminders: [held('before_due', 'sent', D0)] });
    expect(dueAgendaReminders(input(sentOnTheDay, D0))).toEqual([]);
    // A held due of the same day is lapsed instead of being asked again.
    const both = agenda({
      reminders: [held('before_due', 'sent', D0), held('due', 'approval_pending', D0)],
    });
    expect(lapsedAgendaReminders(input(both, D0)).map((item) => item.kind)).toEqual(['due']);
    // A before_due sent on its own day does not cover the due.
    const onTime = agenda({ reminders: [held('before_due', 'sent', D_MINUS_1)] });
    expect(kinds(dueAgendaReminders(input(onTime, D0)))).toEqual(['due']);
  });

  it('a due sent first covers the carried-over before_due (either approval order)', () => {
    const dueSent = agenda({
      reminders: [held('before_due'), held('due', 'sent', D0)],
    });
    expect(dueAgendaReminders(input(dueSent, D0))).toEqual([]);
    expect(lapsedAgendaReminders(input(dueSent, D0)).map((item) => item.kind)).toEqual([
      'before_due',
    ]);
    expect(isCoveredByEarlierReminder(held('before_due'), [held('due', 'sent', D0)])).toBe(true);
    expect(isCoveredByEarlierReminder(held('before_due'), [held('due')])).toBe(false);
  });

  it('a held reminder no longer due (the decider answered, the agenda closed) lapses', () => {
    const a = agenda({ reminders: [held('before_due')] });
    expect(lapsedAgendaReminders(input(a, D_MINUS_1))).toEqual([]);
    expect(lapsedAgendaReminders(input(a, D_MINUS_1, { receipts: [receipt(a, ACTOR)] }))).toEqual([
      held('before_due'),
    ]);
    const closed = agenda({ status: 'closed', reminders: [held('before_due')] });
    expect(lapsedAgendaReminders(input(closed, D_MINUS_1))).toEqual([held('before_due')]);
  });

  it('lapsed is not final: due again on its day, planned again (with a new request)', () => {
    const a = agenda({ reminders: [held('before_due', 'lapsed')] });
    expect(kinds(dueAgendaReminders(input(a, D_MINUS_1)))).toEqual(['before_due']);
    // But never carried over: only an approval_pending record carries.
    expect(kinds(dueAgendaReminders(input(a, D0)))).toEqual(['due']);
    expect(lapsedAgendaReminders(input(a, D_PLUS_1))).toEqual([]);
  });
});

describe('hourly sweeps (CD-11 lifecycle: 30 9-18 * * * Asia/Tokyo)', () => {
  /** The UTC instant of a JST wall-clock time on 2026-10-30 (JST = UTC+9). */
  const jst = (hour: number) =>
    new Date(
      Date.parse(`2026-10-30T${String(hour).padStart(2, '0')}:30:00.000+09:00`)
    ).toISOString();
  const SWEEPS = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18].map(jst);
  const id = reminderId('agd-0123456789abcdef', ACTOR, 'due', '2026-10-30');
  const record = (status: AgendaReminderRecord['status'], at: string): AgendaReminderRecord => ({
    reminder_id: id,
    kind: 'due',
    actor_id: ACTOR,
    target_date: '2026-10-30',
    status,
    approval_request_id: 'apr-1',
    at,
  });

  it('every sweep of a day falls on the same UTC date', () => {
    expect(new Set(SWEEPS.map(utcDate))).toEqual(new Set(['2026-10-30']));
  });

  it('a held due is asked again by each later sweep that day and sent once', () => {
    const [first, second, third, ...rest] = SWEEPS;
    // 09:30: due; the gate holds it.
    expect(kinds(dueAgendaReminders(input(agenda(), first)))).toEqual(['due']);
    const held = agenda({ reminders: [record('approval_pending', first)] });
    // 10:30, not approved yet: planned again (same key, same request), never lapsed.
    expect(dueAgendaReminders(input(held, second)).map((item) => item.reminder_id)).toEqual([id]);
    expect(lapsedAgendaReminders(input(held, second))).toEqual([]);
    // 11:30, approved since: sent; every later sweep that day plans nothing.
    const sent = agenda({ reminders: [record('sent', third)] });
    for (const at of rest) {
      expect(dueAgendaReminders(input(sent, at))).toEqual([]);
      expect(lapsedAgendaReminders(input(sent, at))).toEqual([]);
    }
  });
});
