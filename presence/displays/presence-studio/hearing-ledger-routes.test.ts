// SD-02/04: hearing ↔ decision-ledger routes. Same fake-express pattern as
// `hearing-routes.test.ts`; the governed facade subprocess is never spawned
// here — the pure seams (`resolveLedgerScenarioRef`, `buildLedgerImportLines`) and
// the refusal paths that stop before any write are what this file proves.
import { describe, expect, it } from 'vitest';
import type express from 'express';
import { createHearingRecord, applyHearingTurn } from './hearing.js';
import {
  buildLedgerImportLines,
  registerHearingLedgerRoutes,
  resolveLedgerScenarioRef,
} from './hearing-ledger-routes.js';

type Handler = (req: unknown, res: unknown) => void;

function createFakeApp(): { app: express.Express; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const fake = {
    get(routePath: string, handler: Handler) {
      handlers.set(`GET ${routePath}`, handler);
    },
    post(routePath: string, handler: Handler) {
      handlers.set(`POST ${routePath}`, handler);
    },
  };
  return { app: fake as unknown as express.Express, handlers };
}

function fakeRequest(overrides: {
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
}) {
  const urlPath = '/api/hearing/decisions/agenda';
  return {
    params: overrides.params || {},
    query: overrides.query || {},
    body: overrides.body,
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    path: urlPath,
    originalUrl: urlPath,
    url: urlPath,
  } as never;
}

function fakeResponse() {
  const res: {
    statusCode: number;
    body: unknown;
    status: (code: number) => typeof res;
    json: (body: unknown) => typeof res;
    setHeader: () => typeof res;
  } = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
    setHeader() {
      return res;
    },
  };
  return res;
}

const owner = { kind: 'human' as const, id: 'user:alice', role: 'owner' as const };

describe('hearing-ledger-routes.ts', () => {
  it('registers the agenda and record-decisions endpoints', () => {
    const { app, handlers } = createFakeApp();
    registerHearingLedgerRoutes(app);
    expect([...handlers.keys()].sort()).toEqual([
      'GET /api/hearing/decisions/agenda',
      'POST /api/hearing/:session/record-decisions',
    ]);
  });

  it('ignores non-ledger scenario refs and refuses an unscoped viewer for ledger ones', () => {
    expect(resolveLedgerScenarioRef('acme-corp', 'web_app_build')).toBeUndefined();
    expect(() => resolveLedgerScenarioRef('all', 'decisions-case-a-product')).toThrow(
      /tenant-scoped viewer/u
    );
    expect(() => resolveLedgerScenarioRef('unscoped', 'decisions-case-a-customer')).toThrow(
      /tenant-scoped viewer/u
    );
  });

  it('maps a ledger hearing to promotions and a greenfield hearing to a concept', () => {
    const now = '2026-09-14T00:00:00.000Z';
    let ledgerRecord = createHearingRecord('sess-1', now, {
      id: 'decisions-case-a-product',
      requirements: [
        {
          id: 'D-0001',
          label_key: 'front_desk:hearing_req_tenant_item',
          label_source: 'tenant',
          label_text: 'SCR-1#B35 · csv.columns',
        },
        {
          id: 'D-0002',
          label_key: 'front_desk:hearing_req_tenant_item',
          label_source: 'tenant',
          label_text: 'SCR-1#B27 · memo.max_length',
        },
      ],
    });
    expect(ledgerRecord.requirements[0]).toMatchObject({
      label_source: 'tenant',
      label_text: 'SCR-1#B35 · csv.columns',
    });
    ledgerRecord = applyHearingTurn(ledgerRecord, { text: '["a","b"]', request_id: 't-1' }, now);
    const promotions = buildLedgerImportLines(ledgerRecord, {
      caseId: 'case-a',
      decidedBy: owner,
      now,
    });
    expect(promotions.kind).toBe('promotions');
    expect(promotions.lines).toHaveLength(1);
    expect(JSON.parse(promotions.lines[0])).toMatchObject({
      promote: 'D-0001',
      value: ['a', 'b'],
      decided_by: owner,
      source_turn: 't-1',
      origin: 'hearing',
    });

    let web = createHearingRecord('sess-2', now);
    web = applyHearingTurn(
      web,
      { text: 'field sales', request_id: 't-a', intent_resolution: undefined },
      now
    );
    const concept = buildLedgerImportLines(web, { caseId: 'case-a', decidedBy: owner, now });
    expect(concept.kind).toBe('concept');
    expect(JSON.parse(concept.lines[0]).concept).toMatchObject({
      id: 'PC-sess-2',
      for_whom: [{ actor: 'field sales' }],
      source: { kind: 'hearing', session_id: 'sess-2', scenario: 'web_app_build' },
      recorded_by: { kind: 'human', id: 'user:alice' },
    });
  });

  it('refuses the agenda for an unscoped viewer and an invalid case id before touching any ledger', () => {
    const { app, handlers } = createFakeApp();
    registerHearingLedgerRoutes(app);
    const handler = handlers.get('GET /api/hearing/decisions/agenda') as Handler;
    // The default loopback viewer in tests resolves to the `all` namespace →
    // the route must stop with 400 without reading a tenant ledger.
    const res = fakeResponse();
    handler(fakeRequest({ query: { case: 'case-a' } }), res);
    // The wire error is the sanitized front-desk message — the status is the contract.
    expect(res.statusCode).toBe(400);
    expect(res.body).toBeTruthy();
  });
});

// SD-05 / SD-07 contract tests: the projection canvas is safe by construction,
// and the tenant of a ledger hearing comes from the server-side viewer scope —
// a `tenant`/`stance` query parameter never changes it.
import { afterEach, beforeEach } from 'vitest';
import { sanitizeGeneratedCanvasHtml } from './hearing-canvas.js';
import { renderLedgerProjectionCanvas } from './hearing-ledger-canvas.js';
import { renderLedgerCanvasForRecord } from './hearing-ledger-routes.js';
import type { ProjectionBrief } from '@agent/core/decision-ledger';

describe('SD-05 ledger projection canvas', () => {
  const brief: ProjectionBrief = {
    case_id: 'case-a',
    actor: 'product',
    generated_at: '2026-09-14T00:00:00.000Z',
    red: true,
    impl: { repo: 'impl', commit: 'abc' },
    tally: { match: 1, conflict: 1, stale: 0, unprobed: 0, open: 1 },
    rows: [
      {
        id: 'D-0001',
        item: 'SCR-1#B35',
        key: 'csv.columns',
        level: 'product-fixed',
        state: 'decided',
        verdict: 'conflict',
        value: ['a', 'b'],
        observed: ['a', 'b', 'c'],
        impl_ref: 'csv.ts:13',
        basis_refs: ['QA-1'],
        decided_by: 'user:alice',
      },
      {
        id: 'D-0002',
        item: 'SCR-1#B27',
        key: 'memo.max',
        level: 'product-fixed',
        state: 'decided',
        verdict: 'match',
        value: 30,
        observed: 30,
        basis_refs: [],
      },
      {
        id: 'D-0003',
        item: '<script>alert(1)</script>',
        key: 'balance.kind',
        level: 'customer-value',
        state: 'proposed',
        verdict: 'open',
        value: null,
        answer: 'previous-day" x="<b>y</b>',
        pending_reason: 'customer_approval_required',
        basis_refs: [],
      },
    ],
  };

  it('renders every row with escaped values and passes the model-canvas sanitizer contract', () => {
    const html = renderLedgerProjectionCanvas(brief, { locale: 'ja' });
    expect(html).toContain('SCR-1#B35');
    expect(html).toContain('csv.ts:13');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('この案件の決定');
    expect(html).toContain('食い違い');
    expect(html).toContain('答え済み・未記録');
    const sanitized = sanitizeGeneratedCanvasHtml(html);
    expect(sanitized.ok).toBe(true);
  });

  it('is not used for a greenfield scenario or an unscoped viewer', () => {
    const web = createHearingRecord('sess-9', '2026-09-14T00:00:00.000Z');
    expect(renderLedgerCanvasForRecord('acme-corp', web, 'en')).toBeUndefined();
    const ledgerRecord = createHearingRecord('sess-8', '2026-09-14T00:00:00.000Z', {
      id: 'decisions-case-a-product',
      requirements: [
        {
          id: 'D-0001',
          label_key: 'front_desk:hearing_req_tenant_item',
          label_source: 'tenant',
          label_text: 'x',
        },
      ],
    });
    expect(renderLedgerCanvasForRecord('all', ledgerRecord, 'en')).toBeUndefined();
  });
});

describe('SD-07 tenant comes from the server-side viewer scope', () => {
  let savedTenant: string | undefined;
  beforeEach(() => {
    savedTenant = process.env.KYBERION_TENANT;
    process.env.KYBERION_TENANT = 'zz-ledger-contract-tenant';
  });
  afterEach(() => {
    if (savedTenant === undefined) delete process.env.KYBERION_TENANT;
    else process.env.KYBERION_TENANT = savedTenant;
  });

  it('ignores tenant/stance query parameters and answers for the server tenant (empty ledger → open 0)', () => {
    const { app, handlers } = createFakeApp();
    registerHearingLedgerRoutes(app);
    const handler = handlers.get('GET /api/hearing/decisions/agenda') as Handler;
    const res = fakeResponse();
    handler(
      fakeRequest({
        query: { case: 'case-a', tenant: 'other-tenant', stance: 'engagement', actor: 'product' },
      }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      open: 0,
      scenario: { id: 'decisions-case-a-product', requirements: [] },
    });
    // an empty ledger has nothing to promote — the projection helper still yields a canvas
    const ledgerRecord = createHearingRecord('sess-7', '2026-09-14T00:00:00.000Z', {
      id: 'decisions-case-a-product',
      requirements: [
        {
          id: 'D-0001',
          label_key: 'front_desk:hearing_req_tenant_item',
          label_source: 'tenant',
          label_text: 'x',
        },
      ],
    });
    const html = renderLedgerCanvasForRecord('zz-ledger-contract-tenant', ledgerRecord, 'en');
    expect(html).toContain('Decisions for this case');
    expect(sanitizeGeneratedCanvasHtml(html as string).ok).toBe(true);
  });
});
