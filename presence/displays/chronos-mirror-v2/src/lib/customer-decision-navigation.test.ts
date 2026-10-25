import { describe, expect, it, vi } from 'vitest';
import {
  clearCustomerDecisionSelection,
  customerDecisionHrefs,
  readCustomerDecisionSelection,
} from './customer-decision-navigation';
import {
  createLatestRequestGuard,
  customerDecisionViewUrl,
  fetchCustomerDecisionView,
} from './customer-decision-view-client';
import { buildCustomerDecisionCaseDetail, emptyLearningView } from '@agent/core/customer-decision';

const q = (query: string) => new URLSearchParams(query);

describe('customer-decision drill-down navigation (CD-12)', () => {
  it('reads the selection from the address and falls back to the overview', () => {
    expect(readCustomerDecisionSelection(q(''))).toEqual({ view: 'overview' });
    expect(readCustomerDecisionSelection(q('cd_view=case&cd_case=case-a'))).toEqual({
      view: 'case',
      caseId: 'case-a',
    });
    expect(
      readCustomerDecisionSelection(q('cd_view=case&cd_case=case-a&cd_agenda=agd-0123'))
    ).toEqual({ view: 'case', caseId: 'case-a', agendaId: 'agd-0123' });
    expect(readCustomerDecisionSelection(q('cd_view=learning&cd_date=2026-10-24'))).toEqual({
      view: 'learning',
      date: '2026-10-24',
    });
    // Malformed values never reach a request.
    expect(readCustomerDecisionSelection(q('cd_view=case&cd_case=../x'))).toEqual({
      view: 'overview',
    });
    expect(readCustomerDecisionSelection(q('cd_view=case&cd_case=case-a&cd_agenda=a/b'))).toEqual({
      view: 'case',
      caseId: 'case-a',
    });
    expect(readCustomerDecisionSelection(q('cd_view=learning&cd_date=latest'))).toEqual({
      view: 'learning',
    });
    expect(readCustomerDecisionSelection(q('cd_view=other'))).toEqual({ view: 'overview' });
  });

  it('builds encoded hrefs that keep the other parameters', () => {
    const hrefs = customerDecisionHrefs('/', q('tenant=acme&section=organization&cd_date=x'));
    expect(hrefs.overview).toBe('/?tenant=acme&section=organization');
    expect(hrefs.caseOf('case-a')).toBe(
      '/?tenant=acme&section=organization&cd_view=case&cd_case=case-a'
    );
    expect(hrefs.agendaOf('case-a', 'agd-1')).toBe(
      '/?tenant=acme&section=organization&cd_view=case&cd_case=case-a&cd_agenda=agd-1'
    );
    expect(hrefs.learningOf('2026-10-24')).toBe(
      '/?tenant=acme&section=organization&cd_view=learning&cd_date=2026-10-24'
    );
    // Mission ids are encoded; the drill-down parameters are dropped.
    expect(
      customerDecisionHrefs('/', q('tenant=acme&cd_view=case&cd_case=c')).missionOf('MSN 1&x=y')
    ).toBe('/?tenant=acme&section=missions&mission=MSN+1%26x%3Dy');
  });

  it('clears every cd_* parameter (tenant switch)', () => {
    expect(
      clearCustomerDecisionSelection(
        q('tenant=acme&cd_view=case&cd_case=c&cd_agenda=a&cd_date=2026-10-24')
      ).toString()
    ).toBe('tenant=acme');
  });
});

describe('customer-decision view client (CD-12)', () => {
  const NOW = '2026-10-26T00:00:00.000Z';
  const detail = buildCustomerDecisionCaseDetail({
    tenant_slug: 'acme',
    case_id: 'case-a',
    agendas: [],
    ledger: [],
    receipts: [],
    invites: [],
    consumers: [],
    now: NOW,
  });
  const respond = (body: unknown, status = 200) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('asks the viewer-scoped route with encoded parameters', () => {
    expect(customerDecisionViewUrl('case', 'acme', 'case-a')).toBe(
      '/api/customer-decisions/case?tenant=acme&case=case-a'
    );
    expect(customerDecisionViewUrl('learning', 'acme')).toBe(
      '/api/customer-decisions/learning?tenant=acme'
    );
    expect(customerDecisionViewUrl('learning', 'a&b', '2026-10-24')).toBe(
      '/api/customer-decisions/learning?tenant=a%26b&date=2026-10-24'
    );
  });

  it('maps a ready answer and refuses a foreign one', async () => {
    expect(
      await fetchCustomerDecisionView('case', 'acme', 'case-a', {
        fetch: respond({ case: detail }),
      })
    ).toMatchObject({ kind: 'ready', value: { case_id: 'case-a' } });
    expect(
      await fetchCustomerDecisionView('case', 'acme', 'case-b', {
        fetch: respond({ case: detail }),
      })
    ).toEqual({ kind: 'error', message: 'customer decisions 200' });
    expect(
      await fetchCustomerDecisionView('learning', 'acme', undefined, {
        fetch: respond({ learning: emptyLearningView('acme') }),
      })
    ).toMatchObject({ kind: 'ready', value: { report_date: null } });
  });

  it.each([
    [401, 'forbidden'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [503, 'not_built'],
    [504, 'error'],
    [502, 'error'],
  ] as const)('maps HTTP %i to %s', async (status, kind) => {
    expect(
      await fetchCustomerDecisionView('case', 'acme', 'case-a', {
        fetch: respond({ error: 'fixed message' }, status),
      })
    ).toEqual({ kind, message: 'fixed message' });
  });

  it('resolves an aborted (stale) request to null, and only the latest request is current', async () => {
    const guard = createLatestRequestGuard();
    const first = guard.begin();
    const second = guard.begin();
    expect(first.signal.aborted).toBe(true);
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);
    const pending = fetchCustomerDecisionView('case', 'acme', 'case-a', {
      fetch: vi.fn(async () => {
        guard.begin();
        return new Response(JSON.stringify({ case: detail }));
      }) as unknown as typeof fetch,
      signal: second.signal,
    });
    expect(await pending).toBeNull();
    expect(second.isCurrent()).toBe(false);
  });
});
