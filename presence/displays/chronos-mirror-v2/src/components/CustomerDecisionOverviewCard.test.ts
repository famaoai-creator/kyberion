import { createElement } from 'react';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  CUSTOMER_DECISION_ATTENTION_LIMIT,
  CustomerDecisionOverviewPanel,
  customerDecisionAttentionRows,
  customerDecisionCaseSummary,
  customerDecisionHiddenAttention,
  createLatestRequestGuard,
  fetchCustomerDecisionOverview,
  customerDecisionCommands,
  customerDecisionDaysLabel,
  type CustomerDecisionOverviewState,
} from './CustomerDecisionOverviewCard';
import type {
  AgendaOverviewView,
  CustomerDecisionOverviewView,
} from '../lib/customer-decision-overview-response';

const counts = (over: Partial<AgendaOverviewView['counts']> = {}) => ({
  confirmed: 0,
  provisional: 0,
  awaiting_customer: 0,
  awaiting_operator_confirmation: 0,
  undecided: 0,
  ...over,
});

const agenda: AgendaOverviewView = {
  agenda_id: 'agd-0123456789abcdef',
  title: 'Inception decisions',
  customer: 'globex',
  phase: 'inception',
  revision: 2,
  status: 'sent',
  locale: 'en',
  answerable: true,
  active_invites: 1,
  counts: counts({ confirmed: 1, provisional: 2, awaiting_customer: 1 }),
  unanswered_deciders: 1,
  respond_by: '2026-10-27',
  respond_by_days: 2,
  next_override_deadline: { at: '2026-10-30T09:00:00.000Z', days: 5, entries: 1 },
  open_change_requests: 1,
  pending_handoffs: 0,
  reminders: { due: 0, upcoming: 1, next_send_on: '2026-10-26', pending_approval: 0, manual: 0 },
};

function overview(over: Partial<CustomerDecisionOverviewView> = {}): CustomerDecisionOverviewView {
  return {
    version: '1.0.0',
    tenant_slug: 'acme',
    generated_at: '2026-10-25T00:00:00.000Z',
    today: '2026-10-25',
    totals: {
      cases: 1,
      agendas: 1,
      open_agendas: 1,
      entries: 4,
      counts: counts({ confirmed: 1, provisional: 2, awaiting_customer: 1 }),
      open_change_requests: 1,
      pending_handoffs: 0,
      reminders_due: 0,
      held_tasks: 3,
      pending_task_proposals: 0,
      attention_total: 2,
    },
    attention: [
      {
        reason: 'respond_by_overdue',
        case_id: 'case-a',
        agenda_id: agenda.agenda_id,
        title: 'Overdue set',
        count: 2,
        due: '2026-10-23',
        days: -2,
      },
      { reason: 'held_tasks', case_id: 'case-a', count: 3 },
    ],
    cases: [
      {
        case_id: 'case-a',
        draft_only: false,
        tasks: { pending_proposals: 0, held: 3, ready_to_resume: 0 },
        agendas: [agenda],
        agendas_total: 1,
      },
    ],
    case_failures: [],
    ...over,
  };
}

const render = (state: CustomerDecisionOverviewState, locale: 'en' | 'ja' = 'en') =>
  renderToStaticMarkup(
    createElement(CustomerDecisionOverviewPanel, { state, tenant: 'acme', locale })
  );

describe('CustomerDecisionOverviewCard (CD-12)', () => {
  it('labels day offsets in both locales', () => {
    expect(customerDecisionDaysLabel(0, 'en')).toBe('today');
    expect(customerDecisionDaysLabel(1, 'en')).toBe('in 1 day');
    expect(customerDecisionDaysLabel(3, 'en')).toBe('in 3 days');
    expect(customerDecisionDaysLabel(-2, 'en')).toBe('2 days overdue');
    expect(customerDecisionDaysLabel(3, 'ja')).toBe('あと 3 日');
    expect(customerDecisionDaysLabel(-1, 'ja')).toBe('1 日超過');
  });

  it('shows the totals strip, the attention list and the case rows', () => {
    const html = render({ kind: 'ready', overview: overview() });
    for (const text of [
      'Customer decisions',
      'Provisional',
      'Awaiting customer',
      'Awaiting your confirmation',
      'Change requests',
      'Hand-offs',
      'Held tasks',
      'Needs attention',
      'Answer date passed',
      'Overdue set',
      '2026-10-23 (2 days overdue)',
      'case-a · 1 agenda set · 1 sent',
      'Inception decisions',
      '1 confirmed · 2 provisional · 1 awaiting customer',
      '2026-10-27 (in 2 days)',
      '2026-10-30 (in 5 days)',
      '3 held tasks',
      'pnpm kyberion customer-decision status --tenant acme',
      'draft --tenant acme --case &lt;case&gt; --from-tasks',
    ])
      expect(html).toContain(text);
  });

  it('renders Japanese labels', () => {
    const html = render({ kind: 'ready', overview: overview() }, 'ja');
    expect(html).toContain('顧客の決定');
    expect(html).toContain('担当者の確認待ち');
    expect(html).toContain('回答の目安日を過ぎた');
    expect(html).toContain('2026-10-27 (あと 2 日)');
    expect(html).toContain('確定 1 · 暫定 2');
  });

  it('caps the attention list and says how many more there are', () => {
    const many = Array.from({ length: CUSTOMER_DECISION_ATTENTION_LIMIT + 3 }, (_, index) => ({
      reason: 'awaiting_customer' as const,
      case_id: `case-${index}`,
      count: 1,
    }));
    const value = overview({ attention: many });
    expect(customerDecisionAttentionRows(value, 'en')).toHaveLength(
      CUSTOMER_DECISION_ATTENTION_LIMIT
    );
    expect(render({ kind: 'ready', overview: value })).toContain('3 more in the CLI');
  });

  it('shows the empty, loading and error states', () => {
    const empty = overview({
      totals: { ...overview().totals, cases: 0, agendas: 0, open_agendas: 0, entries: 0 },
      attention: [],
      cases: [],
    });
    expect(render({ kind: 'ready', overview: empty })).toContain('No customer decisions yet');
    expect(render({ kind: 'loading' })).toContain('Loading customer decisions');
    const error = render({ kind: 'error', message: 'took too long' });
    expect(error).toContain('Customer decisions could not be loaded');
    expect(error).toContain('took too long');
  });

  it('names unreadable cases and says nothing needs attention when the list is empty', () => {
    const html = render({
      kind: 'ready',
      overview: overview({
        attention: [],
        case_failures: [{ case_id: 'case-broken', diagnostic_code: 'X' }],
      }),
    });
    expect(html).toContain('1 case could not be read');
    expect(html).toContain('case-broken');
    expect(html).toContain('Nothing needs attention');
  });

  it('points to the CLI for acting', () => {
    expect(customerDecisionCommands('acme').map((line) => line.split(' ')[3])).toEqual([
      'status',
      'confirm',
      'draft',
    ]);
  });

  it('summarizes a case by the status of its agenda sets', () => {
    const mixed = {
      case_id: 'case-a',
      agendas: [agenda, { ...agenda, status: 'approved' as const }],
    };
    expect(customerDecisionCaseSummary(mixed, 'en')).toBe(
      'case-a · 2 agenda sets · 1 sent · 1 approved'
    );
    expect(customerDecisionCaseSummary(mixed, 'ja')).toBe(
      'case-a · 調整セット 2 件 · 送付済み 1 · 承認済み 1'
    );
    const drafts = { case_id: 'case-b', agendas: [{ ...agenda, status: 'draft' as const }] };
    expect(customerDecisionCaseSummary(drafts, 'en')).toBe(
      'case-b · 1 agenda set · 1 draft · not sent yet'
    );
    expect(customerDecisionCaseSummary(drafts, 'ja')).toBe(
      'case-b · 調整セット 1 件 · 下書き 1 · 未送付'
    );
  });

  it('also renders every row as a stacked label/value card for a narrow card', () => {
    const html = render({ kind: 'ready', overview: overview() });
    expect(html).toContain('class="chronos-cd"');
    // Both tables (attention + agenda sets) have a wide and a stacked variant.
    expect(html.match(/class="chronos-cd-rows__wide"/g)).toHaveLength(2);
    expect(html.match(/class="chronos-cd-rows__stacked"/g)).toHaveLength(2);
    const stacked = html.slice(html.lastIndexOf('class="chronos-cd-rows__stacked"'));
    expect(stacked).toContain('<dl class="chronos-cd-card__fields">');
    expect(stacked).toMatch(
      /<dt>Items<\/dt><dd>1 confirmed · 2 provisional · 1 awaiting customer · 0 awaiting you · 0 undecided<\/dd>/u
    );
    expect(stacked).toMatch(/<dt>Answer by<\/dt><dd>2026-10-27 \(in 2 days\)<\/dd>/u);
    // The attention card drops an empty due field instead of printing a blank pair.
    const attention = html.slice(
      html.indexOf('class="chronos-cd-rows__stacked"'),
      html.indexOf('</ul>', html.indexOf('class="chronos-cd-rows__stacked"'))
    );
    expect(attention.match(/<dt>Due<\/dt>/g)).toHaveLength(1);
  });

  it('switches to the stacked cards with a container query on the card', () => {
    const css = String(
      safeReadFile(
        pathResolver.rootResolve('presence/displays/chronos-mirror-v2/src/app/globals.css'),
        {
          encoding: 'utf8',
        }
      )
    );
    expect(css).toMatch(/\.chronos-cd \{\s*container-type: inline-size;/u);
    const rule = css.slice(css.indexOf('@container (max-width: 720px)'));
    expect(rule).toMatch(/\.chronos-cd-rows__wide \{\s*display: none;/u);
    expect(rule).toMatch(/\.chronos-cd-rows__stacked \{\s*display: grid;/u);
  });

  it('counts hidden attention items from attention_total past the facade cap', () => {
    const shown = Array.from({ length: 50 }, (_, index) => ({
      reason: 'awaiting_customer' as const,
      case_id: `case-${index}`,
      count: 1,
    }));
    const value = overview({
      attention: shown,
      totals: { ...overview().totals, attention_total: 120 },
    });
    expect(customerDecisionHiddenAttention(value)).toBe(120 - CUSTOMER_DECISION_ATTENTION_LIMIT);
    expect(render({ kind: 'ready', overview: value })).toContain(
      `${120 - CUSTOMER_DECISION_ATTENTION_LIMIT} more in the CLI`
    );
  });

  it('says how many cases and agenda sets were cut off', () => {
    const value = overview({
      totals: { ...overview().totals, cases: 205 },
      cases: [{ ...overview().cases[0], agendas_total: 130 }],
    });
    const html = render({ kind: 'ready', overview: value });
    expect(html).toContain('204 more in the CLI');
    expect(html).toContain('case-a · 130 agenda sets · 1 sent');
  });

  it('drops a response that lands after a newer request (tenant switch)', async () => {
    const guard = createLatestRequestGuard();
    const first = guard.begin();
    const second = guard.begin();
    expect(first.signal.aborted).toBe(true);
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);
    guard.cancel();
    expect(second.signal.aborted).toBe(true);
    expect(second.isCurrent()).toBe(false);
  });

  it('fetches one tenant and ignores a stale or foreign response', async () => {
    const respond = (body: unknown, status = 200) =>
      vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const ok = await fetchCustomerDecisionOverview('acme', {
      fetch: respond({ overview: overview() }),
    });
    expect(ok).toMatchObject({ kind: 'ready', overview: { tenant_slug: 'acme' } });
    // An overview of another tenant is never shown for this one.
    const foreign = await fetchCustomerDecisionOverview('globex', {
      fetch: respond({ overview: overview() }),
    });
    expect(foreign).toEqual({ kind: 'error', message: 'customer decisions 200' });
    const failed = await fetchCustomerDecisionOverview('acme', {
      fetch: respond({ error: 'took too long' }, 504),
    });
    expect(failed).toEqual({ kind: 'error', message: 'took too long' });
    // A request aborted by a tenant switch resolves to null (no state update).
    const controller = new AbortController();
    const pending = fetchCustomerDecisionOverview('acme', {
      fetch: vi.fn(async () => {
        controller.abort();
        return new Response(JSON.stringify({ overview: overview() }));
      }) as unknown as typeof fetch,
      signal: controller.signal,
    });
    expect(await pending).toBeNull();
  });
});
