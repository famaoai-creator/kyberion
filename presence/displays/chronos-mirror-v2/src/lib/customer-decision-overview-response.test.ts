import { describe, expect, it } from 'vitest';
import {
  agendaContentHash,
  buildCaseOverview,
  buildCustomerDecisionOverview,
  CUSTOMER_DECISION_OVERVIEW_VERSION,
  OVERVIEW_ATTENTION_ORDER,
  type DecisionAgenda,
} from '@agent/core/customer-decision';
import {
  OVERVIEW_ATTENTION_REASONS,
  OVERVIEW_LIMITS,
  parseCustomerDecisionOverview,
  parseCustomerDecisionOverviewResponse,
  SUPPORTED_CUSTOMER_DECISION_OVERVIEW_VERSION,
} from './customer-decision-overview-response';

const NOW = '2026-10-25T00:00:00.000Z';

function sentAgenda(): DecisionAgenda {
  const agenda: DecisionAgenda = {
    version: '1.0.0',
    agenda_id: 'agd-0123456789abcdef',
    tenant_slug: 'acme',
    case_id: 'case-a',
    customer: 'globex',
    title: 'Inception decisions',
    phase: 'inception',
    revision: 1,
    locale: 'en',
    respond_by: '2026-10-26',
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
        our_decision: { value: 'sso' },
        requires_customer: false,
      },
      {
        entry_id: 'release',
        item: 'RELEASE',
        key: 'release.go',
        kind: 'approval',
        question: 'Release to production?',
        requires_customer: true,
      },
    ],
    status: 'sent',
    created_at: NOW,
    updated_at: NOW,
  };
  agenda.approval = {
    content_hash: agendaContentHash(agenda),
    approved_at: NOW,
    approved_by: 'user:alice',
  };
  return agenda;
}

function realOverview(tenant = 'acme') {
  return buildCustomerDecisionOverview({
    tenant_slug: tenant,
    cases: [
      buildCaseOverview({
        case_id: 'case-a',
        agendas: [sentAgenda()],
        ledger: [],
        receipts: [],
        invites: [],
        consumers: [],
        now: NOW,
      }),
    ],
    case_failures: [{ case_id: 'case-broken', diagnostic_code: 'CUSTOMER_DECISION_X' }],
    now: NOW,
  });
}

describe('customer-decision overview projection (CD-12)', () => {
  it('tracks the contract version and attention order of the core builder', () => {
    expect(SUPPORTED_CUSTOMER_DECISION_OVERVIEW_VERSION).toBe(CUSTOMER_DECISION_OVERVIEW_VERSION);
    expect([...OVERVIEW_ATTENTION_REASONS]).toEqual([...OVERVIEW_ATTENTION_ORDER]);
  });

  it('accepts a real overview and keeps counts, dates and names but no entry rows', () => {
    const source = realOverview();
    const parsed = parseCustomerDecisionOverview(JSON.parse(JSON.stringify(source)), 'acme');
    expect(parsed).toBeDefined();
    expect(parsed?.totals).toEqual({ ...source.totals, attention_total: source.attention.length });
    expect(parsed?.attention).toEqual(source.attention);
    expect(parsed?.case_failures).toEqual(source.case_failures);
    const [agenda] = parsed!.cases[0].agendas;
    expect(agenda).toMatchObject({
      agenda_id: 'agd-0123456789abcdef',
      title: 'Inception decisions',
      respond_by: '2026-10-26',
      respond_by_days: 1,
      counts: { awaiting_customer: 1 },
    });
    expect(agenda).not.toHaveProperty('entries');
    expect(JSON.stringify(parsed)).not.toContain('Which sign-in method?');
  });

  it('drops fields outside the contract', () => {
    const value = JSON.parse(JSON.stringify(realOverview())) as Record<string, unknown>;
    value.extra = 'leak';
    (value.totals as Record<string, unknown>).extra = 'leak';
    expect(JSON.stringify(parseCustomerDecisionOverview(value))).not.toContain('leak');
  });

  it.each([
    ['another version', (v: Record<string, unknown>) => ({ ...v, version: '2.0.0' })],
    ['a missing total', (v: Record<string, unknown>) => ({ ...v, totals: {} })],
    [
      'an unknown attention reason',
      (v: Record<string, unknown>) => ({
        ...v,
        attention: [{ reason: 'x', case_id: 'c', count: 1 }],
      }),
    ],
    [
      'a negative count',
      (v: Record<string, unknown>) => ({ ...v, totals: { ...(v.totals as object), cases: -1 } }),
    ],
    [
      'a prototype key',
      (v: Record<string, unknown>) =>
        JSON.parse(JSON.stringify(v).replace('"today"', '"__proto__":{},"today"')),
    ],
    ['not an object', () => 'overview'],
  ])('rejects %s', (_label, mutate) => {
    const value = JSON.parse(JSON.stringify(realOverview())) as Record<string, unknown>;
    expect(parseCustomerDecisionOverview(mutate(value))).toBeUndefined();
  });

  it('rejects an overview of another tenant', () => {
    expect(parseCustomerDecisionOverview(realOverview('globex'), 'acme')).toBeUndefined();
    expect(
      parseCustomerDecisionOverviewResponse({ overview: realOverview('acme') }, 'acme')
    ).toBeDefined();
    expect(parseCustomerDecisionOverviewResponse({ error: 'x' })).toBeUndefined();
  });

  it('truncates oversized lists instead of rejecting the overview', () => {
    const value = structuredClone(realOverview());
    const item = value.attention[0];
    value.attention = Array.from({ length: 600 }, () => item);
    value.cases = Array.from({ length: 700 }, (_, index) => ({
      ...value.cases[0],
      case_id: `case-${index}`,
      agendas: Array.from({ length: 300 }, () => value.cases[0].agendas[0]),
    }));
    const parsed = parseCustomerDecisionOverview(value, 'acme');
    expect(parsed).toBeDefined();
    expect(parsed!.attention).toHaveLength(OVERVIEW_LIMITS.attention);
    expect(parsed!.totals.attention_total).toBe(600);
    expect(parsed!.cases).toHaveLength(OVERVIEW_LIMITS.cases);
    expect(parsed!.cases[0].agendas).toHaveLength(OVERVIEW_LIMITS.agendas_per_case);
    expect(parsed!.cases[0].agendas_total).toBe(300);
  });

  it('reads attention_total from the summary form', () => {
    const source = structuredClone(realOverview());
    const value = {
      ...source,
      totals: { ...source.totals, attention_total: 75 },
      cases: source.cases.map((item) => ({
        ...item,
        agendas: item.agendas.map(({ entries: _entries, ...agenda }) => agenda),
      })),
    };
    expect(parseCustomerDecisionOverview(value, 'acme')?.totals.attention_total).toBe(75);
    value.totals.attention_total = -1;
    expect(parseCustomerDecisionOverview(value, 'acme')).toBeUndefined();
  });
});
