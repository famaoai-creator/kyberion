import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CustomerDecisionCasePanel, customerDecisionTaskState } from './CustomerDecisionCaseDetail';
import {
  CustomerDecisionAgendaPanel,
  customerDecisionAgendaCommands,
} from './CustomerDecisionAgendaDetail';
import { customerDecisionHrefs } from '../lib/customer-decision-navigation';
import type {
  CaseAgendaView,
  CustomerDecisionCaseDetailView,
} from '../lib/customer-decision-case-response';
import type { CustomerDecisionViewState } from '../lib/customer-decision-view-client';

const SECRET = 'zzsecret';
const AGENDA = 'agd-0123456789abcdef';
const hrefs = customerDecisionHrefs('/', new URLSearchParams('tenant=acme&section=organization'));

const counts = {
  confirmed: 1,
  provisional: 0,
  awaiting_customer: 0,
  awaiting_operator_confirmation: 1,
  undecided: 0,
};

const agenda: CaseAgendaView = {
  agenda_id: AGENDA,
  title: 'Inception decisions',
  customer: 'globex',
  phase: 'inception',
  revision: 2,
  status: 'sent',
  locale: 'en',
  answerable: true,
  active_invites: 1,
  counts,
  unanswered_deciders: 1,
  respond_by: '2026-10-27',
  respond_by_days: 1,
  next_override_deadline: null,
  open_change_requests: 1,
  pending_handoffs: 1,
  entries: [
    {
      entry_id: 'auth',
      item: 'NFR',
      key: 'auth.method',
      kind: 'choice',
      question: 'Which sign-in method?',
      status: 'confirmed',
      layer: 'customer',
      requires_customer: false,
      overridable: false,
      decision_id: 'D-0001',
      operator_confirmed: false,
      attachment_count: 1,
      link_count: 2,
    },
    {
      entry_id: 'price',
      item: 'DEAL',
      key: 'price.plan',
      kind: 'approval',
      question: 'Approve the price?',
      status: 'awaiting_operator_confirmation',
      layer: 'customer',
      requires_customer: true,
      overridable: false,
      operator_confirmed: false,
      attachment_count: 0,
      link_count: 0,
    },
  ],
  entries_total: 2,
  change_requests: [
    { receipt_id: 'rcp-000000000001', entry_id: 'auth', at: '2026-10-25T00:00:00.000Z' },
  ],
  change_requests_total: 1,
  handoffs: [
    {
      receipt_id: 'rcp-000000000001',
      off_option: 1,
      comments: 2,
      general_question: true,
      inbox_entry_id: 'INBOX-CDH-1',
      notified: true,
      done: false,
      at: '2026-10-25T01:00:00.000Z',
    },
  ],
  handoffs_total: 1,
  reminders: {
    due: 0,
    next_send_on: '2026-10-26',
    pending_approval: 0,
    manual: 1,
    records: [
      {
        reminder_id: 'rmd-0000000000000001',
        kind: 'due',
        target_date: '2026-10-27',
        status: 'manual',
        reason: 'no_channel',
        at: '2026-10-20T00:00:00.000Z',
      },
    ],
    records_total: 1,
    upcoming: [{ kind: 'before_due', send_on: '2026-10-26', target_date: '2026-10-27' }],
    upcoming_total: 1,
  },
  invites: { active: 2, expired: 1, revoked: 0, deciders: 1, contributors: 1 },
  bolt_routing: [
    {
      entry_id: 'auth',
      outcome: 'request_changes',
      work_item_id: 'WI-1',
      notified: false,
      at: '2026-10-21T00:00:00.000Z',
    },
  ],
  bolt_routing_total: 1,
  approval: { approved_at: '2026-10-20T00:00:00.000Z', approved_by_type: 'human' },
};

function detail(
  over: Partial<CustomerDecisionCaseDetailView> = {}
): CustomerDecisionCaseDetailView {
  return {
    version: '1.0.0',
    tenant_slug: 'acme',
    case_id: 'case-a',
    generated_at: '2026-10-26T00:00:00.000Z',
    today: '2026-10-26',
    draft_only: false,
    task_counts: { pending_proposals: 0, held: 1, ready_to_resume: 0 },
    attention: [
      {
        reason: 'awaiting_operator_confirmation',
        case_id: 'case-a',
        agenda_id: AGENDA,
        title: 'Inception decisions',
        count: 1,
      },
    ],
    agendas: [agenda],
    agendas_total: 1,
    tasks: [
      {
        consumer: 'mission-MSN-1.task-a',
        mission_id: 'MSN-1',
        task_id: 'task-a',
        status: 'in_progress',
        hold: { work_item_id: 'WI-HOLD', at: '2026-10-21T00:00:00.000Z' },
        proposals: [
          {
            proposal_id: 'tp-1',
            requires_customer: true,
            collected: true,
            agenda_id: AGENDA,
            entry_id: 'price',
          },
        ],
        proposals_total: 1,
        rework: { count: 0, work_item_ids: [] },
      },
    ],
    tasks_total: 1,
    ...over,
  };
}

/** A view object a misbehaving source padded with values the UI must never print. */
function padded(): CustomerDecisionCaseDetailView {
  const value = detail();
  const entry = { ...value.agendas[0].entries[0], value: `${SECRET}-value`, rationale: SECRET };
  return {
    ...value,
    agendas: [
      {
        ...value.agendas[0],
        entries: [entry, value.agendas[0].entries[1]],
        from: SECRET,
      } as CaseAgendaView,
    ],
  };
}

const ready = (value = detail()): CustomerDecisionViewState<CustomerDecisionCaseDetailView> => ({
  kind: 'ready',
  value,
});

const renderCase = (
  state: CustomerDecisionViewState<CustomerDecisionCaseDetailView>,
  locale: 'en' | 'ja' = 'en'
) =>
  renderToStaticMarkup(
    createElement(CustomerDecisionCasePanel, {
      state,
      tenant: 'acme',
      caseId: 'case-a',
      locale,
      hrefs,
      onRetry: () => undefined,
    })
  );

const renderAgenda = (
  state: CustomerDecisionViewState<CustomerDecisionCaseDetailView>,
  locale: 'en' | 'ja' = 'en',
  agendaId = AGENDA
) =>
  renderToStaticMarkup(
    createElement(CustomerDecisionAgendaPanel, {
      state,
      tenant: 'acme',
      caseId: 'case-a',
      agendaId,
      locale,
      hrefs,
    })
  );

describe('CustomerDecisionCaseDetail (CD-12 drill-down)', () => {
  it('shows the breadcrumb, agenda sets and mission tasks with drill-down links', () => {
    const html = renderCase(ready());
    expect(html).toContain(
      '<nav class="chronos-cd-breadcrumb" aria-label="Customer decisions location">'
    );
    expect(html).toContain('<span aria-current="page">case-a</span>');
    expect(html).toContain('href="/?tenant=acme&amp;section=organization"');
    expect(html).toContain('Case case-a');
    expect(html).toContain('tabindex="-1"');
    // The agenda row (and its title) opens the agenda set.
    expect(html).toContain(
      `data-href="/?tenant=acme&amp;section=organization&amp;cd_view=case&amp;cd_case=case-a&amp;cd_agenda=${AGENDA}"`
    );
    // Held tasks link to the missions section.
    expect(html).toContain('href="/?tenant=acme&amp;section=missions&amp;mission=MSN-1"');
    expect(html).toContain('Held');
    expect(html).toContain('<caption>Mission tasks</caption>');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('pnpm kyberion customer-decision status --tenant acme --case case-a');
  });

  it('renders Japanese labels', () => {
    const html = renderCase(ready(), 'ja');
    expect(html).toContain('案件 case-a');
    expect(html).toContain('ミッションのタスク');
    expect(html).toContain('保留中');
    expect(html).toContain('顧客の決定内の現在地');
  });

  it.each([
    [{ kind: 'loading' }, 'Loading the details', 'ja', '詳細を読み込んでいます'],
    [{ kind: 'error', message: 'took too long' }, 'Try again', 'ja', '再試行'],
    [
      { kind: 'forbidden', message: 'denied' },
      'You cannot see these customer decisions',
      'ja',
      '権限がありません',
    ],
    [
      { kind: 'not_found', message: 'This case has no customer decisions' },
      'Back to customer decisions',
      'ja',
      '顧客の決定に戻る',
    ],
    [{ kind: 'not_built', message: 'x' }, 'pnpm build', 'ja', 'pnpm build'],
  ] as const)('renders the %o state in both locales', (state, en, ja, jaText) => {
    expect(renderCase(state)).toContain(en);
    expect(renderCase(state, ja)).toContain(jaText);
  });

  it('offers no retry when the viewer is forbidden', () => {
    const html = renderCase({ kind: 'forbidden', message: 'denied' });
    expect(html).not.toContain('Try again');
    expect(html).toContain('data-tone="warning"');
  });

  it('labels a held task ready once every customer answer is in', () => {
    const [task] = detail().tasks;
    expect(customerDecisionTaskState(task)).toBe('held');
    expect(
      customerDecisionTaskState({
        ...task,
        proposals: [{ ...task.proposals[0], resolved_decision_id: 'D-9' }],
      })
    ).toBe('ready');
    expect(customerDecisionTaskState({ ...task, status: 'completed' })).toBe('completed');
  });
});

describe('CustomerDecisionAgendaDetail (CD-12 drill-down)', () => {
  it('shows entries and the open items around the agenda set', () => {
    const html = renderAgenda(ready());
    for (const text of [
      'Which sign-in method?',
      'Awaiting your confirmation',
      'auth · NFR / auth.method',
      '1 files · 2 links',
      '1 open change request',
      '1 hand-off',
      'INBOX-CDH-1',
      '2 reminders',
      'No channel for the decider',
      '2 active invites',
      '1 routed review answer',
      'WI-1',
      'Changes requested',
    ])
      expect(html).toContain(text);
    // Breadcrumb: overview › case › agenda set (current).
    expect(html).toContain(
      'href="/?tenant=acme&amp;section=organization&amp;cd_view=case&amp;cd_case=case-a"'
    );
    expect(html).toContain('<span aria-current="page">Inception decisions</span>');
  });

  it('fills the commands with the real ids', () => {
    expect(customerDecisionAgendaCommands('acme', 'case-a', agenda)).toEqual([
      `pnpm kyberion customer-decision status --tenant acme --case case-a --agenda ${AGENDA}`,
      `pnpm kyberion customer-decision confirm --tenant acme --case case-a --agenda ${AGENDA} --entry price --by user:<member>`,
      'pnpm kyberion customer-decision remind --tenant acme --case case-a --dry-run',
    ]);
  });

  it('renders Japanese labels', () => {
    const html = renderAgenda(ready(), 'ja');
    expect(html).toContain('担当者の確認待ち');
    expect(html).toContain('未対応の変更要求 1 件');
    expect(html).toContain('有効な招待 2 件');
  });

  it('never prints a value, rationale or sender, even when the view carries one', () => {
    for (const html of [renderAgenda(ready(padded())), renderCase(ready(padded()))])
      expect(html).not.toContain(SECRET);
  });

  it('says when the agenda set is not in the case, with a way back', () => {
    const html = renderAgenda(ready(), 'en', 'agd-missing');
    expect(html).toContain('This agenda set is not in the case');
    expect(html).toContain('Back to the case');
  });
});
