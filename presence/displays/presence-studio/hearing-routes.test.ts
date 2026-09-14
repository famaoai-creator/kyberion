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
import type express from 'express';

vi.mock('@agent/core/member-registry', async () => {
  const actual = await vi.importActual<typeof import('@agent/core/member-registry')>(
    '@agent/core/member-registry'
  );
  return { ...actual, resolveMemberByPrincipal: vi.fn() };
});

import { resolveMemberByPrincipal } from '@agent/core/member-registry';
import { applyHearingTurn, createHearingRecord, type HearingRecord } from './hearing.js';
import { hearingNamespace, loadHearingRecord, saveHearingRecord } from './hearing-runtime.js';
import { registerHearingRoutes } from './hearing-routes.js';

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
  it('registers the four HT-01/03 hearing endpoints', () => {
    const { app, handlers } = createFakeApp();
    registerHearingRoutes(app);
    expect(handlers.has('GET /api/hearing/:session/canvas')).toBe(true);
    expect(handlers.has('GET /api/hearing/:session')).toBe(true);
    expect(handlers.has('POST /api/hearing/:session/answer')).toBe(true);
    expect(handlers.has('POST /api/hearing/:session/decide')).toBe(true);
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
