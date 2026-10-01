import { beforeEach, describe, expect, it, vi } from 'vitest';

const deals = vi.hoisted(() => ({
  generateQuoteForDeal: vi.fn(),
  draftContractForDeal: vi.fn(),
  recordContractReview: vi.fn(),
  handoffWonDealToSdlc: vi.fn(),
}));

vi.mock('@agent/core/deal-documents', () => deals);
vi.mock('@agent/core/customer-channel-binding', () => ({
  listCustomerChannelBindings: () => [{ tenantSlug: 'acme' }, { tenantSlug: 'beta' }],
}));
vi.mock('@agent/core/deal-store', () => ({
  listDeals: (tenant: string) =>
    tenant === 'acme'
      ? [
          { deal_id: 'DEAL-001', stage: 'discovery', summary: 'site' },
          { deal_id: 'DEAL-SHARED', stage: 'discovery', summary: 'a' },
        ]
      : tenant === 'beta'
        ? [{ deal_id: 'DEAL-SHARED', stage: 'discovery', summary: 'b' }]
        : [],
}));

import {
  handleDealDocumentAction,
  isDealDocumentAction,
} from './operator-home-secondary-actions.js';

const ui = (key: string, params?: Record<string, string | number>) =>
  params ? `${key} ${JSON.stringify(params)}` : key;

function run(argv: Parameters<typeof handleDealDocumentAction>[1]) {
  const output: unknown[] = [];
  let error: unknown;
  try {
    handleDealDocumentAction(ui as never, argv, (value) => output.push(value));
  } catch (caught) {
    error = caught;
  }
  return { output, error };
}

describe('pnpm kyberion deals document actions (E2E-06)', () => {
  beforeEach(() => {
    for (const fn of Object.values(deals)) fn.mockReset();
  });

  it('only claims argv that asks for a document action', () => {
    expect(isDealDocumentAction({})).toBe(false);
    expect(isDealDocumentAction({ quote: 'DEAL-001' })).toBe(true);
    expect(isDealDocumentAction({ handoff: 'DEAL-001' })).toBe(true);
  });

  it('builds a quote from the price book for the deal tenant', () => {
    deals.generateQuoteForDeal.mockReturnValue({ ok: true, version: 1, quote_ref: 'q.md' });
    const { output, error } = run({
      quote: 'DEAL-001',
      lines: '[{"task_kind":"web","size":"s"}]',
    });
    expect(error).toBeUndefined();
    expect(deals.generateQuoteForDeal).toHaveBeenCalledWith({
      tenantSlug: 'acme',
      dealId: 'DEAL-001',
      requests: [{ task_kind: 'web', size: 's' }],
    });
    expect(String(output[0])).toContain('recorder:recorder_deal_quote_created');
  });

  it('rejects malformed quote lines without touching the deal', () => {
    const { output, error } = run({ quote: 'DEAL-001', lines: '[{"size":"s"}]' });
    expect(error).toBeDefined();
    expect(deals.generateQuoteForDeal).not.toHaveBeenCalled();
    expect(output).toEqual(['recorder:recorder_deal_quote_usage']);
  });

  it('fails closed with the operator hand-off when work is unquotable', () => {
    deals.generateQuoteForDeal.mockReturnValue({
      ok: false,
      unquotable: [{ task_kind: 'ml', reason: 'unknown' }],
    });
    const { output, error } = run({ quote: 'DEAL-001', lines: '[{"task_kind":"ml"}]' });
    expect(error).toBeDefined();
    expect(String(output[0])).toContain('recorder_deal_quote_unquotable');
  });

  it('records a contract review only with a complete verdict', () => {
    expect(
      run({ reviewContract: 'DEAL-001', contractVersion: 1, verdict: 'maybe' }).error
    ).toBeDefined();
    expect(deals.recordContractReview).not.toHaveBeenCalled();
    deals.recordContractReview.mockReturnValue('customer/acme/deals/DEAL-001/r.json');
    const { error } = run({
      reviewContract: 'DEAL-001',
      contractVersion: 2,
      verdict: 'approve',
      reviewer: 'legal',
      note: 'ok',
    });
    expect(error).toBeUndefined();
    expect(deals.recordContractReview).toHaveBeenCalledWith({
      tenantSlug: 'acme',
      dealId: 'DEAL-001',
      version: 2,
      verdict: 'approve',
      reviewer: 'legal',
      notes: 'ok',
    });
  });

  it('requires --tenant when the deal id exists in several tenants', () => {
    const ambiguous = run({ draftContract: 'DEAL-SHARED' });
    expect(ambiguous.error).toBeDefined();
    expect(String(ambiguous.output[0])).toContain('recorder:recorder_deal_tenant_ambiguous');
    expect(deals.draftContractForDeal).not.toHaveBeenCalled();

    deals.draftContractForDeal.mockReturnValue({ version: 1, contract_ref: 'c.md' });
    expect(run({ draftContract: 'DEAL-SHARED', tenant: 'beta' }).error).toBeUndefined();
    expect(deals.draftContractForDeal).toHaveBeenCalledWith({
      tenantSlug: 'beta',
      dealId: 'DEAL-SHARED',
    });
  });

  it('drafts a contract and hands a won deal to its mission', () => {
    deals.draftContractForDeal.mockReturnValue({ version: 1, contract_ref: 'c.md' });
    expect(run({ draftContract: 'DEAL-001' }).error).toBeUndefined();
    expect(run({ handoff: 'DEAL-001' }).output).toEqual(['recorder:recorder_deal_handoff_usage']);
    deals.handoffWonDealToSdlc.mockReturnValue({
      handoff_path: 'h.json',
      sdlc_pipeline: 'pipelines/sdlc-cycle.json',
    });
    const { error } = run({ handoff: 'DEAL-001', missionId: 'MSN-X', json: true });
    expect(error).toBeUndefined();
    expect(deals.handoffWonDealToSdlc).toHaveBeenCalledWith({
      tenantSlug: 'acme',
      dealId: 'DEAL-001',
      missionId: 'MSN-X',
    });
  });

  it('reports an unknown deal before any document action', () => {
    const { output, error } = run({ draftContract: 'DEAL-404' });
    expect(error).toBeDefined();
    expect(deals.draftContractForDeal).not.toHaveBeenCalled();
    expect(String(output[0])).toContain('recorder_deal_not_found');
  });
});
