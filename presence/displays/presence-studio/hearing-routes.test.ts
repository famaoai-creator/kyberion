// HT-01/03: hearing session routes, split out of `server.ts` — see
// `hearing-routes.ts`'s module doc and `front-desk-routes.test.ts` for the
// established pattern this file follows:
//   1. wire the real `registerHearingRoutes` onto a tiny fake `express.Express`
//      that only records handlers by `METHOD path` (no HTTP server, no real
//      Express routing needed to prove the registration or exercise a
//      handler directly with a fabricated req/res); and
//   2. exercise the actual route behavior — `resolvePresenceStudioViewerContext`,
//      `resolveMemberByPrincipal` (mocked so the human-only decision path is
//      hermetic and never depends on a real `knowledge/personal/members/`
//      profile), and the already-tested pure `hearing.ts` /
//      `hearing-runtime.ts` helpers used to seed fixtures.
// `hearing-runtime.ts` persists under `pathResolver.sharedTmp('hearing')`
// (no fixture-rootDir seam), so this file uses a dedicated fictitious tenant
// slug as the hearing namespace and removes it in `afterEach`.
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver, safeReadFile, safeRmSync } from '@agent/core';
import { logger } from '@agent/core/core';
import { t as catalogT } from '@agent/core/t';
import { withExecutionContext } from '@agent/core/authority';
import type express from 'express';

vi.mock('@agent/core/member-registry', async () => {
  const actual = await vi.importActual<typeof import('@agent/core/member-registry')>(
    '@agent/core/member-registry'
  );
  return { ...actual, resolveMemberByPrincipal: vi.fn() };
});

// HT-02: `/answer` fires `generateHearingCanvas` off the request thread —
// mock it so this file can drive its pending -> generated / pending ->
// template transitions deterministically, without depending on a reasoning
// backend or a real 20s timeout.
vi.mock('./hearing-canvas.js', async () => {
  const actual = await vi.importActual<typeof import('./hearing-canvas.js')>('./hearing-canvas.js');
  return { ...actual, generateHearingCanvas: vi.fn() };
});

import { resolveMemberByPrincipal } from '@agent/core/member-registry';
import {
  createWorkInventoryEntry,
  loadWorkInventoryEntry,
  saveWorkInventoryEntry,
} from '@agent/core/work-inventory';
import { applyHearingTurn, createHearingRecord, type HearingRecord } from './hearing.js';
import { hearingNamespace, loadHearingRecord, saveHearingRecord } from './hearing-runtime.js';
import { generateHearingCanvas } from './hearing-canvas.js';
import { registerHearingRoutes, type HearingRecordWithInventoryFields } from './hearing-routes.js';

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function readRepoFile(relativePath: string): string {
  return String(safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }));
}

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
  const urlPath = '/api/hearing/test';
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
    setHeader: (name: string, value: string) => typeof res;
    type: (value: string) => typeof res;
    send: (body: unknown) => typeof res;
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
    type() {
      return res;
    },
    send(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}

const TEST_TENANT = 'zz-hearing-route-test';
const TEST_MEMBER_ID = 'zz-hearing-route-member';

function fixtureMember(role: 'owner' | 'approver' | 'viewer') {
  return {
    member_id: TEST_MEMBER_ID,
    display_name: 'ZZ Hearing Tester',
    status: 'active' as const,
    memberships: [{ tenant_slug: TEST_TENANT, role }],
    access_registrations: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function fullyAnsweredRecord(sessionId: string): HearingRecord {
  let record = createHearingRecord(sessionId, '2026-09-14T00:00:00.000Z');
  for (let index = 0; index < record.requirements.length; index += 1) {
    record = applyHearingTurn(
      record,
      { text: `answer ${index}`, request_id: `turn-${index}` },
      '2026-09-14T00:01:00.000Z'
    );
  }
  return record;
}

describe('hearing-routes.ts route wiring', () => {
  it('registers the four HT-01/03 hearing endpoints, plus the WI-08 work-inventory hand-off', () => {
    const { app, handlers } = createFakeApp();
    registerHearingRoutes(app);
    expect(handlers.has('GET /api/hearing/:session/canvas')).toBe(true);
    expect(handlers.has('GET /api/hearing/:session')).toBe(true);
    expect(handlers.has('POST /api/hearing/:session/answer')).toBe(true);
    expect(handlers.has('POST /api/hearing/:session/decide')).toBe(true);
    expect(handlers.has('POST /api/hearing/:session/inventory')).toBe(true);
  });

  it('server.ts registers hearing routes at the same guard position as front-desk routes', () => {
    const source = readRepoFile('presence/displays/presence-studio/server.ts');
    const frontDeskCall = source.indexOf('registerFrontDeskRoutes(presenceStudioData.app)');
    const hearingCall = source.indexOf('registerHearingRoutes(presenceStudioData.app)');
    const trainingCall = source.indexOf('registerTrainingRoutes(presenceStudioData.app)');
    expect(frontDeskCall).toBeGreaterThan(-1);
    expect(hearingCall).toBeGreaterThan(frontDeskCall);
    expect(trainingCall).toBeGreaterThan(hearingCall);
  });
});

describe('POST /api/hearing/:session/decide', () => {
  let savedTenant: string | undefined;
  const { app, handlers } = createFakeApp();
  registerHearingRoutes(app);
  const decide = handlers.get('POST /api/hearing/:session/decide')!;

  beforeEach(() => {
    savedTenant = process.env.KYBERION_TENANT;
    process.env.KYBERION_TENANT = TEST_TENANT;
    vi.mocked(resolveMemberByPrincipal).mockReset();
  });

  afterEach(() => {
    if (savedTenant === undefined) delete process.env.KYBERION_TENANT;
    else process.env.KYBERION_TENANT = savedTenant;
    safeRmSync(pathResolver.sharedTmp(`hearing/${TEST_TENANT}`), {
      recursive: true,
      force: true,
    });
  });

  it('refuses with 403 when no member resolves for the viewer', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.mocked(resolveMemberByPrincipal).mockReturnValue(null);
    const sessionId = `sess-${randomUUID()}`;
    saveHearingRecord(hearingNamespace([TEST_TENANT]), fullyAnsweredRecord(sessionId));

    const res = fakeResponse();
    decide(fakeRequest({ params: { session: sessionId } }), res);

    expect(res.statusCode).toBe(403);
    expect((res.body as { ok: boolean }).ok).toBe(false);
    // The wire-error boundary sanitizes the 4xx response body — the raw
    // reason is only proven via the audit log line hearingResponseError emits.
    expect(warnSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
      'decisions are recorded for registered members only'
    );
    warnSpy.mockRestore();
  });

  it('refuses while requirements are still unanswered, before ever resolving a member', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.mocked(resolveMemberByPrincipal).mockReturnValue(fixtureMember('owner'));
    const sessionId = `sess-${randomUUID()}`;
    const namespace = hearingNamespace([TEST_TENANT]);
    saveHearingRecord(namespace, createHearingRecord(sessionId, '2026-09-14T00:00:00.000Z'));

    const res = fakeResponse();
    decide(fakeRequest({ params: { session: sessionId } }), res);

    expect(res.statusCode).toBe(400);
    expect(warnSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
      'unanswered requirement'
    );
    expect(resolveMemberByPrincipal).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('persists decided_by as a human actor + the deciding member role, and returns the vocabulary next_action', () => {
    vi.mocked(resolveMemberByPrincipal).mockReturnValue(fixtureMember('approver'));
    const sessionId = `sess-${randomUUID()}`;
    const namespace = hearingNamespace([TEST_TENANT]);
    saveHearingRecord(namespace, fullyAnsweredRecord(sessionId));

    const res = fakeResponse();
    decide(fakeRequest({ params: { session: sessionId } }), res);

    expect(res.statusCode).toBe(200);
    const body = res.body as { ok: boolean; record: HearingRecord; next_action: unknown };
    expect(body.ok).toBe(true);
    expect(body.record.decided_by).toEqual({
      kind: 'human',
      id: 'user:zz-hearing-route-member',
      display_name: 'ZZ Hearing Tester',
      role: 'approver',
    });
    // Never the synthetic loopback/token principal id.
    expect(JSON.stringify(body.record.decided_by)).not.toContain('presence-studio-localadmin');
    expect(body.next_action).toEqual({
      kind: 'alignment_review',
      label_key: 'front_desk:hearing_next_alignment',
      label: catalogT('front_desk:hearing_next_alignment', undefined, 'en'),
    });

    const persisted = loadHearingRecord(namespace, sessionId);
    expect(persisted?.decided_by).toEqual({
      kind: 'human',
      id: 'user:zz-hearing-route-member',
      display_name: 'ZZ Hearing Tester',
      role: 'approver',
    });
  });
});

describe('POST /api/hearing/:session/answer canvas generation (HT-02)', () => {
  let savedTenant: string | undefined;
  const { app, handlers } = createFakeApp();
  registerHearingRoutes(app);
  const answer = handlers.get('POST /api/hearing/:session/answer')!;

  beforeEach(() => {
    savedTenant = process.env.KYBERION_TENANT;
    process.env.KYBERION_TENANT = TEST_TENANT;
    vi.mocked(generateHearingCanvas).mockReset();
  });

  afterEach(() => {
    if (savedTenant === undefined) delete process.env.KYBERION_TENANT;
    else process.env.KYBERION_TENANT = savedTenant;
    safeRmSync(pathResolver.sharedTmp(`hearing/${TEST_TENANT}`), {
      recursive: true,
      force: true,
    });
  });

  it('responds with the template canvas immediately, marked pending, without waiting for generation', () => {
    let releaseGeneration: (value: { source: 'generated'; html: string }) => void = () => {};
    vi.mocked(generateHearingCanvas).mockReturnValue(
      new Promise((resolve) => {
        releaseGeneration = resolve;
      })
    );

    const sessionId = `sess-${randomUUID()}`;
    const res = fakeResponse();
    answer(fakeRequest({ params: { session: sessionId }, body: { text: 'Freelancers.' } }), res);

    expect(res.statusCode).toBe(200);
    const body = res.body as { ok: boolean; record: HearingRecord; canvas_url: string };
    expect(body.ok).toBe(true);
    expect(body.record.canvas_generation).toBe('pending');
    expect(body.record.canvas_versions).toEqual(['v1']);
    expect(body.canvas_url).toContain(sessionId);

    // Release the never-settled promise so this test does not leak a
    // dangling handler into the next one.
    releaseGeneration({ source: 'generated', html: '<html><head></head><body>ok</body></html>' });
  });

  it('persists a new canvas version and flips canvas_generation to "generated" once the async generation resolves', async () => {
    vi.mocked(generateHearingCanvas).mockResolvedValue({
      source: 'generated',
      html: '<html><head></head><body>model drawn</body></html>',
    });

    const sessionId = `sess-${randomUUID()}`;
    const namespace = hearingNamespace([TEST_TENANT]);
    const res = fakeResponse();
    answer(fakeRequest({ params: { session: sessionId }, body: { text: 'Freelancers.' } }), res);

    expect((res.body as { record: HearingRecord }).record.canvas_generation).toBe('pending');
    await flushMicrotasks();

    const persisted = loadHearingRecord(namespace, sessionId);
    expect(persisted?.canvas_generation).toBe('generated');
    expect(persisted?.canvas_versions).toEqual(['v1', 'v2']);
    expect(persisted?.canvas_version_sources).toMatchObject({ v1: 'template', v2: 'generated' });
  });

  it('flips canvas_generation to "template" (without adding a version) when generation falls back', async () => {
    vi.mocked(generateHearingCanvas).mockResolvedValue({
      source: 'template',
      html: '<html><head></head><body>fallback</body></html>',
      reason: 'forbidden_pattern:script_tag',
    });

    const sessionId = `sess-${randomUUID()}`;
    const namespace = hearingNamespace([TEST_TENANT]);
    const res = fakeResponse();
    answer(fakeRequest({ params: { session: sessionId }, body: { text: 'Freelancers.' } }), res);
    await flushMicrotasks();

    const persisted = loadHearingRecord(namespace, sessionId);
    expect(persisted?.canvas_generation).toBe('template');
    expect(persisted?.canvas_versions).toEqual(['v1']);
  });

  it('never lets a stale generation overwrite a newer answer (latest answer wins)', async () => {
    let releaseFirst: (value: { source: 'generated'; html: string }) => void = () => {};
    vi.mocked(generateHearingCanvas).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = resolve;
        })
    );

    const sessionId = `sess-${randomUUID()}`;
    const namespace = hearingNamespace([TEST_TENANT]);
    const firstRes = fakeResponse();
    answer(
      fakeRequest({ params: { session: sessionId }, body: { text: 'First answer.' } }),
      firstRes
    );

    // A second answer arrives while the first generation is still in
    // flight — its own generation is queued, not started overlapping.
    vi.mocked(generateHearingCanvas).mockResolvedValueOnce({
      source: 'generated',
      html: '<html><head></head><body>second draft</body></html>',
    });
    const secondRes = fakeResponse();
    answer(
      fakeRequest({ params: { session: sessionId }, body: { text: 'Second answer.' } }),
      secondRes
    );
    expect(vi.mocked(generateHearingCanvas)).toHaveBeenCalledTimes(1);

    // The stale first generation resolves after the second answer already
    // moved `updated_at` forward — it must be discarded.
    releaseFirst({
      source: 'generated',
      html: '<html><head></head><body>stale draft</body></html>',
    });
    await flushMicrotasks();
    await flushMicrotasks();

    const persisted = loadHearingRecord(namespace, sessionId);
    // v1 (first answer's template), v2 (second answer's template), v3 (the
    // queued second-answer generation) -- the stale first generation never
    // wrote a version.
    expect(persisted?.canvas_versions).toEqual(['v1', 'v2', 'v3']);
    expect(persisted?.canvas_generation).toBe('generated');
    expect(vi.mocked(generateHearingCanvas)).toHaveBeenCalledTimes(2);
  });
});

// WI-08: `scenario_id` resolution + the `work_inventory_table` canvas path.
// Its `/answer` handler is `async` (it awaits `renderWorkInventoryCanvasHtml`
// for this scenario, unlike the synchronous `web_app_build` template path
// exercised above), so every call here is awaited.
describe('POST /api/hearing/:session/answer scenario_id resolution (WI-08)', () => {
  let savedTenant: string | undefined;
  const { app, handlers } = createFakeApp();
  registerHearingRoutes(app);
  const answer = handlers.get('POST /api/hearing/:session/answer')!;
  const SCENARIO_TEST_TENANT = 'zz-hearing-scenario-id-test';

  beforeEach(() => {
    savedTenant = process.env.KYBERION_TENANT;
    process.env.KYBERION_TENANT = SCENARIO_TEST_TENANT;
    vi.mocked(generateHearingCanvas).mockReset();
    // Only the legacy-scenario test below reaches the `web_app_preview`
    // model-generation follow-up; a resolved default keeps that call from
    // throwing on `undefined.then(...)` the way an un-implemented `vi.fn()`
    // mock would.
    vi.mocked(generateHearingCanvas).mockResolvedValue({
      source: 'template',
      html: '<html><head></head><body>ok</body></html>',
    });
  });

  afterEach(() => {
    if (savedTenant === undefined) delete process.env.KYBERION_TENANT;
    else process.env.KYBERION_TENANT = savedTenant;
    safeRmSync(pathResolver.sharedTmp(`hearing/${SCENARIO_TEST_TENANT}`), {
      recursive: true,
      force: true,
    });
  });

  it('creates the record from the hearing-scenarios.json catalog entry when scenario_id is given', async () => {
    const sessionId = `sess-${randomUUID()}`;
    const res = fakeResponse();
    await answer(
      fakeRequest({
        params: { session: sessionId },
        body: { text: '毎週の定例報告書の作成', scenario_id: 'work_inventory' },
      }),
      res
    );
    expect(res.statusCode).toBe(200);
    const body = res.body as { record: HearingRecord };
    expect(body.record.scenario).toBe('work_inventory');
    expect(body.record.requirements.map((item) => item.id)).toEqual([
      'task_name',
      'trigger',
      'frequency',
      'effort',
      'steps',
      'systems',
      'decisions',
      'output',
    ]);
    expect(body.record.requirements.find((item) => item.id === 'task_name')?.answer).toBe(
      '毎週の定例報告書の作成'
    );
  });

  it('rejects an unknown scenario_id with 400', async () => {
    const sessionId = `sess-${randomUUID()}`;
    const res = fakeResponse();
    await answer(
      fakeRequest({
        params: { session: sessionId },
        body: { text: 'hi', scenario_id: 'does-not-exist' },
      }),
      res
    );
    expect(res.statusCode).toBe(400);
  });

  it('still accepts the legacy inline scenario object when no scenario_id is sent', async () => {
    const sessionId = `sess-${randomUUID()}`;
    const res = fakeResponse();
    await answer(
      fakeRequest({
        params: { session: sessionId },
        body: {
          text: 'answer',
          scenario: {
            id: 'legacy_custom',
            requirements: [{ id: 'only', label_key: 'front_desk:hearing_req_audience' }],
          },
        },
      }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as { record: HearingRecord }).record.scenario).toBe('legacy_custom');
  });

  it('renders the work_inventory_table canvas deterministically (final "template" state, no model generation scheduled)', async () => {
    const sessionId = `sess-${randomUUID()}`;
    const res = fakeResponse();
    await answer(
      fakeRequest({
        params: { session: sessionId },
        body: { text: '月次請求書の作成', scenario_id: 'work_inventory' },
      }),
      res
    );
    expect(res.statusCode).toBe(200);
    const body = res.body as { record: HearingRecord };
    expect(body.record.canvas_generation).toBe('template');
    expect(generateHearingCanvas).not.toHaveBeenCalled();
  });

  it("carries ?scenario_id= on canvas_url so the iframe's own separate fetch resolves the right default before anything is persisted", async () => {
    const sessionId = `sess-${randomUUID()}`;
    const res = fakeResponse();
    await answer(
      fakeRequest({
        params: { session: sessionId },
        body: { text: '月次請求書の作成', scenario_id: 'work_inventory' },
      }),
      res
    );
    const body = res.body as { canvas_url: string };
    expect(body.canvas_url).toContain('scenario_id=work_inventory');
  });
});

describe('POST /api/hearing/:session/inventory (WI-08)', () => {
  let savedTenant: string | undefined;
  const { app, handlers } = createFakeApp();
  registerHearingRoutes(app);
  const answer = handlers.get('POST /api/hearing/:session/answer')!;
  const decide = handlers.get('POST /api/hearing/:session/decide')!;
  const inventory = handlers.get('POST /api/hearing/:session/inventory')!;
  const INVENTORY_TEST_TENANT = 'zz-hearing-inventory-test';
  const INVENTORY_TEST_MEMBER_ID = 'zz-hearing-inventory-member';
  const namespace = hearingNamespace([INVENTORY_TEST_TENANT]);

  const ANSWERS: Record<string, string> = {
    task_name: '月次請求書の作成',
    trigger: '毎月末に経理から依頼',
    frequency: '毎月',
    effort: '1時間',
    steps: '請求データを集計する→請求書を作成する→PDF化して送付する',
    systems: 'Excel、Slack',
    decisions: '金額が10万円を超える場合は上長の承認が必要',
    output: 'PDF 請求書を経理チームに渡す',
  };

  function inventoryFixtureMember(role: 'owner' | 'approver' | 'viewer' = 'approver') {
    return {
      member_id: INVENTORY_TEST_MEMBER_ID,
      display_name: 'ZZ Inventory Tester',
      status: 'active' as const,
      memberships: [{ tenant_slug: INVENTORY_TEST_TENANT, role }],
      access_registrations: [],
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
  }

  async function answerAllWorkInventoryRequirements(sessionId: string): Promise<void> {
    for (const [id, text] of Object.entries(ANSWERS)) {
      const res = fakeResponse();
      await answer(
        fakeRequest({
          params: { session: sessionId },
          body: id === 'task_name' ? { text, scenario_id: 'work_inventory' } : { text },
        }),
        res
      );
    }
  }

  beforeEach(() => {
    savedTenant = process.env.KYBERION_TENANT;
    process.env.KYBERION_TENANT = INVENTORY_TEST_TENANT;
    vi.mocked(resolveMemberByPrincipal).mockReset();
    vi.mocked(generateHearingCanvas).mockReset();
  });

  afterEach(() => {
    if (savedTenant === undefined) delete process.env.KYBERION_TENANT;
    else process.env.KYBERION_TENANT = savedTenant;
    safeRmSync(pathResolver.sharedTmp(`hearing/${INVENTORY_TEST_TENANT}`), {
      recursive: true,
      force: true,
    });
    // Confidential-tier cleanup needs the same elevation the route itself
    // uses to write there (see hearing-routes.ts's `/inventory` handler).
    withExecutionContext('ecosystem_architect', () =>
      safeRmSync(pathResolver.rootResolve(`knowledge/confidential/${INVENTORY_TEST_TENANT}`), {
        recursive: true,
        force: true,
      })
    );
  });

  it('refuses with 400 when requirements are still unanswered', async () => {
    const sessionId = `sess-${randomUUID()}`;
    const seedRes = fakeResponse();
    await answer(
      fakeRequest({
        params: { session: sessionId },
        body: { text: ANSWERS.task_name, scenario_id: 'work_inventory' },
      }),
      seedRes
    );

    const res = fakeResponse();
    await inventory(fakeRequest({ params: { session: sessionId } }), res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { ok: boolean }).ok).toBe(false);
  });

  it('refuses with 400 when the record has not been decided yet', async () => {
    const sessionId = `sess-${randomUUID()}`;
    await answerAllWorkInventoryRequirements(sessionId);

    const res = fakeResponse();
    await inventory(fakeRequest({ params: { session: sessionId } }), res);
    expect(res.statusCode).toBe(400);
  });

  it('refuses with 400 a hearing scenario that is not registered with handoff: work_inventory', async () => {
    const sessionId = `sess-${randomUUID()}`;
    const seedRes = fakeResponse();
    // No scenario_id -> defaults to web_app_build (handoff: mission).
    await answer(
      fakeRequest({ params: { session: sessionId }, body: { text: 'Freelancers.' } }),
      seedRes
    );

    const res = fakeResponse();
    await inventory(fakeRequest({ params: { session: sessionId } }), res);
    expect(res.statusCode).toBe(400);
  });

  it('creates a confirmed work inventory entry under the tenant scope, parses frequency/effort/trigger/systems, and is idempotent', async () => {
    const sessionId = `sess-${randomUUID()}`;
    await answerAllWorkInventoryRequirements(sessionId);

    vi.mocked(resolveMemberByPrincipal).mockReturnValue(inventoryFixtureMember('approver'));
    const decideRes = fakeResponse();
    decide(fakeRequest({ params: { session: sessionId } }), decideRes);
    expect(decideRes.statusCode).toBe(200);

    const res = fakeResponse();
    await inventory(fakeRequest({ params: { session: sessionId } }), res);
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      ok: boolean;
      entry_id: string;
      scope: { tenant_slug?: string };
      steps: number;
      next: { href: string };
    };
    expect(body.ok).toBe(true);
    expect(body.entry_id).toMatch(/^WI-/);
    expect(body.scope).toEqual({ tenant_slug: INVENTORY_TEST_TENANT });
    expect(body.steps).toBeGreaterThan(0);
    expect(body.next.href).toContain('/');

    const entry = withExecutionContext('ecosystem_architect', () =>
      loadWorkInventoryEntry({ tenant_slug: INVENTORY_TEST_TENANT }, body.entry_id)
    );
    expect(entry?.status).toBe('confirmed');
    expect(entry?.title).toBe(ANSWERS.task_name);
    expect(entry?.trigger.kind).toBe('schedule');
    expect(entry?.frequency).toEqual({ per: 'month', count: 1 });
    expect(entry?.effort_minutes_per_run).toBe(60);
    expect(entry?.systems).toEqual(['Excel', 'Slack']);
    expect(entry?.observations?.some((item) => item.ref === `hearing:${sessionId}`)).toBe(true);

    const persisted = loadHearingRecord(namespace, sessionId) as HearingRecordWithInventoryFields;
    expect(persisted.work_inventory_entry_id).toBe(body.entry_id);

    // Idempotent: a second call returns the same entry_id, no second write.
    const res2 = fakeResponse();
    await inventory(fakeRequest({ params: { session: sessionId } }), res2);
    expect((res2.body as { entry_id: string }).entry_id).toBe(body.entry_id);
  });

  it('refuses with 409 instead of overwriting an existing entry with the same id', async () => {
    const sessionId = `sess-${randomUUID()}`;
    await answerAllWorkInventoryRequirements(sessionId);
    vi.mocked(resolveMemberByPrincipal).mockReturnValue(inventoryFixtureMember('approver'));
    const decideRes = fakeResponse();
    decide(fakeRequest({ params: { session: sessionId } }), decideRes);
    expect(decideRes.statusCode).toBe(200);

    const fixedNow = new Date('2026-09-22T09:00:00.000Z');
    const scope = { tenant_slug: INVENTORY_TEST_TENANT };
    const occupant = {
      ...createWorkInventoryEntry(
        { title: ANSWERS.task_name, scope, trigger: { kind: 'ad_hoc', description: 'other' } },
        fixedNow
      ),
      title: 'Occupant',
    };
    withExecutionContext('ecosystem_architect', () => saveWorkInventoryEntry(occupant));

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(fixedNow);
    const res = fakeResponse();
    try {
      await inventory(fakeRequest({ params: { session: sessionId } }), res);
    } finally {
      vi.useRealTimers();
    }
    expect(res.statusCode).toBe(409);
    const stored = withExecutionContext('ecosystem_architect', () =>
      loadWorkInventoryEntry(scope, occupant.entry_id)
    );
    expect(stored?.title).toBe('Occupant');
    const persisted = loadHearingRecord(namespace, sessionId) as HearingRecordWithInventoryFields;
    expect(persisted.work_inventory_entry_id).toBeUndefined();
  });
});
