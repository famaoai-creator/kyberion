// HT-04/05: training-catalog routes, split out of `server.ts` — see
// `training-routes.ts`'s module doc and `front-desk-routes.test.ts` for the
// established pattern this file follows: register the real
// `registerTrainingRoutes` onto a tiny fake `express.Express` that records
// handlers by `METHOD path`, then exercise route behavior directly.
// `libs/core/training-catalog.ts` persists progress/assignments under real
// `knowledge/personal/members/` and `knowledge/confidential/` paths (no
// fixture-rootDir seam), so this file uses dedicated fictitious member/tenant
// ids and removes them in `afterEach`.
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver, safeReadFile, safeRmSync } from '@agent/core';
import { withExecutionContext } from '@agent/core/authority';

vi.mock('@agent/core/member-registry', async () => {
  const actual = await vi.importActual<typeof import('@agent/core/member-registry')>(
    '@agent/core/member-registry'
  );
  return { ...actual, resolveMemberByPrincipal: vi.fn() };
});

import { resolveMemberByPrincipal } from '@agent/core/member-registry';
import { readTrainingProgress } from '@agent/core/training-catalog';
import { registerTrainingRoutes } from './training-routes.js';

function readRepoFile(relativePath: string): string {
  return String(safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }));
}

type Handler = (req: unknown, res: unknown) => void;

function createFakeApp(): { app: import('express').Express; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const fake = {
    get(routePath: string, handler: Handler) {
      handlers.set(`GET ${routePath}`, handler);
    },
    post(routePath: string, handler: Handler) {
      handlers.set(`POST ${routePath}`, handler);
    },
  };
  return { app: fake as unknown as import('express').Express, handlers };
}

function fakeRequest(overrides: { remoteAddress: string; authorization?: string; body?: unknown }) {
  const urlPath = '/api/training/progress';
  return {
    params: {},
    query: {},
    body: overrides.body,
    headers: overrides.authorization ? { authorization: overrides.authorization } : {},
    socket: { remoteAddress: overrides.remoteAddress },
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

const TEST_MEMBER_ID = 'zz-training-route-member';

function fixtureMember() {
  return {
    member_id: TEST_MEMBER_ID,
    display_name: 'ZZ Training Tester',
    status: 'active' as const,
    memberships: [],
    access_registrations: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

describe('training-routes.ts route wiring', () => {
  it('registers the training catalog/progress/assignments endpoints', () => {
    const { app, handlers } = createFakeApp();
    registerTrainingRoutes(app);
    expect(handlers.has('GET /api/training/catalog')).toBe(true);
    expect(handlers.has('GET /api/training/progress')).toBe(true);
    expect(handlers.has('POST /api/training/progress')).toBe(true);
    expect(handlers.has('GET /api/training/assignments')).toBe(true);
    expect(handlers.has('POST /api/training/assignments')).toBe(true);
  });

  it('server.ts registers training routes after hearing routes, behind the same guard', () => {
    const source = readRepoFile('presence/displays/presence-studio/server.ts');
    const hearingCall = source.indexOf('registerHearingRoutes(presenceStudioData.app)');
    const trainingCall = source.indexOf('registerTrainingRoutes(presenceStudioData.app)');
    expect(hearingCall).toBeGreaterThan(-1);
    expect(trainingCall).toBeGreaterThan(hearingCall);
  });
});

describe('GET /api/training/catalog', () => {
  it('lists at least one governed training track', () => {
    const { app, handlers } = createFakeApp();
    registerTrainingRoutes(app);
    const res = fakeResponse();
    handlers.get('GET /api/training/catalog')!(fakeRequest({ remoteAddress: '127.0.0.1' }), res);
    const body = res.body as { ok: boolean; catalog: { tracks: unknown[] } };
    expect(body.ok).toBe(true);
    expect(body.catalog.tracks.length).toBeGreaterThan(0);
  });
});

describe('POST /api/training/progress is localadmin-only', () => {
  const { app, handlers } = createFakeApp();
  registerTrainingRoutes(app);
  const postProgress = handlers.get('POST /api/training/progress')!;
  const originalToken = process.env.PRESENCE_STUDIO_TOKEN;

  beforeEach(() => {
    vi.mocked(resolveMemberByPrincipal).mockReset();
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.PRESENCE_STUDIO_TOKEN;
    else process.env.PRESENCE_STUDIO_TOKEN = originalToken;
    withExecutionContext('ecosystem_architect', () =>
      safeRmSync(path.join(pathResolver.rootDir(), 'knowledge/personal/members', TEST_MEMBER_ID), {
        recursive: true,
        force: true,
      })
    );
  });

  it('rejects a remote token viewer (requirePresenceStudioLocalAdmin) with 403, never reaching the member/catalog write', () => {
    const savedTenant = process.env.KYBERION_TENANT;
    process.env.KYBERION_TENANT = 'zz-training-route-test';
    process.env.PRESENCE_STUDIO_TOKEN = 'training-route-test-token';
    vi.mocked(resolveMemberByPrincipal).mockReturnValue(fixtureMember());

    const res = fakeResponse();
    postProgress(
      fakeRequest({
        remoteAddress: '198.51.100.24',
        authorization: 'Bearer training-route-test-token',
        body: { lesson_id: 'first-request', status: 'complete' },
      }),
      res
    );

    expect(res.statusCode).toBe(403);
    expect(resolveMemberByPrincipal).not.toHaveBeenCalled();

    if (savedTenant === undefined) delete process.env.KYBERION_TENANT;
    else process.env.KYBERION_TENANT = savedTenant;
  });

  it('writes progress for the server-resolved member on a loopback (localadmin) request', () => {
    vi.mocked(resolveMemberByPrincipal).mockReturnValue(fixtureMember());

    const res = fakeResponse();
    postProgress(
      fakeRequest({
        remoteAddress: '127.0.0.1',
        body: { lesson_id: 'first-request', status: 'complete' },
      }),
      res
    );

    expect(res.statusCode).toBe(200);
    const body = res.body as {
      ok: boolean;
      progress: { lessons: Record<string, { status: string; completed_at?: string }> };
    };
    expect(body.ok).toBe(true);
    expect(body.progress.lessons['first-request']?.status).toBe('complete');
    expect(body.progress.lessons['first-request']?.completed_at).toBeTruthy();

    // Never keyed by a client-supplied member id — the write lands under the
    // server-resolved TEST_MEMBER_ID's own progress file.
    const persisted = withExecutionContext('ecosystem_architect', () =>
      readTrainingProgress(TEST_MEMBER_ID)
    );
    expect(persisted.lessons['first-request']?.status).toBe('complete');
  });

  it('rejects an unknown lesson id or status', () => {
    vi.mocked(resolveMemberByPrincipal).mockReturnValue(fixtureMember());

    const res = fakeResponse();
    postProgress(
      fakeRequest({
        remoteAddress: '127.0.0.1',
        body: { lesson_id: 'does-not-exist', status: 'complete' },
      }),
      res
    );

    expect(res.statusCode).toBe(400);
  });
});
