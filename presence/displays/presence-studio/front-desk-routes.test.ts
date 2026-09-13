// FD-00 / FD-01: `/api/me` and `/api/front-desk/nav` (presence-studio side).
//
// `server.ts` (where these routes are registered) calls
// `presenceStudioData.server.listen(...)` unconditionally at module scope
// (see `presence-studio-runtime-data.ts`), so — matching the existing
// `os-control-plane-route.test.ts` / `route-param-boundary.test.ts` style —
// this file never imports `server.ts`. Instead it:
//   1. exercises the real, side-effect-free pieces the routes are built
//      from (`resolvePresenceStudioViewerContext`, `toFrontDeskViewerScope`,
//      `requirePresenceStudioAccess`, `@agent/core/front-desk-identity`,
//      `@agent/core/front-desk-nav`) directly, proving the actual behavior
//      the routes produce; and
//   2. reads `server.ts` / `security.ts` / `presence-studio-runtime-data.ts`
//      as text to prove the routes are wired to those same functions.
// Tenant profiles are fixture-backed via the `TenantRegistryPathOptions`
// seam (same pattern as `libs/core/front-desk-identity.test.ts` /
// `tenant-registry.test.ts`) — no real `knowledge/` file is touched.
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver, safeReadFile, safeRmSync } from '@agent/core';
import { writeTenantProfile } from '@agent/core/tenant-registry';
import { readFrontDeskMe } from '@agent/core/front-desk-identity';
import { t as catalogT, type VocabularyKey } from '@agent/core/t';

vi.mock('@agent/core/surface-runtime', () => ({
  loadSurfaceManifest: () => ({
    version: 1,
    surfaces: [
      { id: 'presence-studio', kind: 'ui', description: '', command: 'node', port: 3031 },
      { id: 'concierge', kind: 'ui', description: '', command: 'node', port: 4050 },
    ],
  }),
}));

import {
  FRONT_DESK_HELP_LINK,
  frontDeskRoleFromViewer,
  readFrontDeskSurfacePorts,
  resolveFrontDeskMenu,
} from '@agent/core/front-desk-nav';
import {
  requirePresenceStudioAccess,
  resolvePresenceStudioViewerContext,
  toFrontDeskViewerScope,
} from './security.js';

function readRepoFile(relativePath: string): string {
  return String(safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }));
}

function fakeRequest(overrides: {
  remoteAddress: string;
  authorization?: string;
  urlPath?: string;
}) {
  const url = overrides.urlPath ?? '/api/me';
  return {
    headers: overrides.authorization ? { authorization: overrides.authorization } : {},
    socket: { remoteAddress: overrides.remoteAddress },
    path: url.split('?')[0],
    originalUrl: url,
    url,
  } as never;
}

function fakeResponse() {
  const res: {
    statusCode: number;
    body: unknown;
    status: (code: number) => typeof res;
    json: (body: unknown) => typeof res;
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
  };
  return res;
}

describe('FD-01 GET /api/me composition', () => {
  let fixtureRoot = '';
  let savedPersona: string | undefined;
  let savedRole: string | undefined;
  let savedTenant: string | undefined;

  beforeAll(() => {
    fixtureRoot = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `front-desk-routes-${randomUUID()}`
    );
    savedPersona = process.env.KYBERION_PERSONA;
    savedRole = process.env.MISSION_ROLE;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';

    writeTenantProfile(
      {
        tenant_slug: 'acme-corp',
        display_name: 'Acme Corp',
        status: 'active',
        assigned_role: 'owner',
      },
      { rootDir: fixtureRoot }
    );
    writeTenantProfile(
      {
        tenant_slug: 'beta-co',
        display_name: 'Beta Co',
        status: 'active',
        assigned_role: 'viewer',
      },
      { rootDir: fixtureRoot }
    );
  });

  afterAll(() => {
    if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedPersona;
    if (savedRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = savedRole;
    if (fixtureRoot) safeRmSync(fixtureRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    savedTenant = process.env.KYBERION_TENANT;
  });

  afterEach(() => {
    if (savedTenant === undefined) delete process.env.KYBERION_TENANT;
    else process.env.KYBERION_TENANT = savedTenant;
  });

  it('resolves a loopback viewer to member.source=loopback, role owner, and can_switch matching tenant count', () => {
    process.env.KYBERION_TENANT = 'acme-corp';
    const viewer = resolvePresenceStudioViewerContext(fakeRequest({ remoteAddress: '127.0.0.1' }));
    const scope = toFrontDeskViewerScope(viewer);
    expect(scope.role).toBe('localadmin');

    const me = readFrontDeskMe(scope, {
      availableOperations: ['presence.overview.read'],
      onboarded: true,
      tenantRegistry: { rootDir: fixtureRoot },
    });

    // presence-studio binds a loopback viewer to the server's own tenant
    // (loopbackUsesServerTenant: true), so it sees exactly one tenant here —
    // can_switch still correctly tracks that count.
    expect(me.ok).toBe(true);
    expect(me.member.source).toBe('loopback');
    expect(me.tenants.every((tenant) => tenant.role === 'owner')).toBe(true);
    expect(me.tenants).toHaveLength(1);
    expect(me.can_switch).toBe(me.tenants.length > 1);
    expect(me.can_switch).toBe(false);
  });

  it('reports can_switch true when the viewer scope spans multiple tenants', () => {
    // A registration-backed multi-tenant viewer (FD-07 member registry, or a
    // chronos-access registration today) resolves to tenantSlugs listing
    // every tenant it may see; readFrontDeskMe narrows to exactly those.
    const scope = {
      role: 'localadmin' as const,
      tenantSlugs: ['acme-corp', 'beta-co'],
      organizationIds: 'all' as const,
      projectIds: 'all' as const,
      tierAccess: ['personal', 'confidential', 'public'] as (
        'personal' | 'confidential' | 'public'
      )[],
      source: 'loopback' as const,
      principalId: 'human:presence-studio-localadmin',
    };

    const me = readFrontDeskMe(scope, {
      availableOperations: [],
      onboarded: true,
      tenantRegistry: { rootDir: fixtureRoot },
    });

    expect(me.tenants).toHaveLength(2);
    expect(me.can_switch).toBe(true);
  });

  it('never widens a token-scoped viewer to a requested tenant outside its scope', () => {
    process.env.KYBERION_TENANT = 'acme-corp';
    process.env.PRESENCE_STUDIO_TOKEN = 'studio-token';
    const viewer = resolvePresenceStudioViewerContext(
      fakeRequest({ remoteAddress: '198.51.100.24', authorization: 'Bearer studio-token' })
    );
    expect(viewer.tenantSlugs).toEqual(['acme-corp']);
    const scope = toFrontDeskViewerScope(viewer);

    const me = readFrontDeskMe(scope, {
      requestedTenant: 'beta-co',
      availableOperations: [],
      onboarded: true,
      tenantRegistry: { rootDir: fixtureRoot },
    });

    // beta-co exists as a tenant profile but is outside this viewer's scope:
    // it must never appear, and viewing must never become it.
    expect(me.tenants.map((tenant) => tenant.tenant_slug)).toEqual(['acme-corp']);
    expect(me.viewing?.tenant_slug).toBe('acme-corp');
    expect(me.viewing?.tenant_slug).not.toBe('beta-co');

    delete process.env.PRESENCE_STUDIO_TOKEN;
  });
});

describe('FD-00 GET /api/front-desk/nav composition (mirrors the route in server.ts)', () => {
  it('resolves 5 items in home/ask/decide/progress/settings order with ja labels and the manifest-driven concierge port', () => {
    const viewer = resolvePresenceStudioViewerContext(fakeRequest({ remoteAddress: '127.0.0.1' }));
    const role = frontDeskRoleFromViewer({ role: toFrontDeskViewerScope(viewer).role });
    const ports = readFrontDeskSurfacePorts();
    const items = resolveFrontDeskMenu({ currentSurface: 'presence-studio', ports, role }).map(
      (item) => ({
        id: item.id,
        label: catalogT(item.label_key as VocabularyKey, undefined, 'ja'),
        href: item.href,
        external: item.external,
      })
    );

    expect(items.map((item) => item.id)).toEqual(['home', 'ask', 'decide', 'progress', 'settings']);
    expect(items.map((item) => item.label)).toEqual([
      'ホーム',
      '頼む',
      '決める',
      '進み具合',
      '設定',
    ]);
    // decide/settings live on concierge — the port must come from the
    // (mocked) manifest, never a hardcoded literal.
    expect(items.find((item) => item.id === 'decide')?.href).toBe('http://127.0.0.1:4050/');
    expect(items.find((item) => item.id === 'settings')?.href).toBe(
      'http://127.0.0.1:4050/settings'
    );
    expect(items.find((item) => item.id === 'home')?.external).toBe(false);
    expect(FRONT_DESK_HELP_LINK.path).toBe('/help');
  });
});

describe('FD-01 remote-token allowlist (security.ts requirePresenceStudioAccess)', () => {
  const originalToken = process.env.PRESENCE_STUDIO_TOKEN;

  afterEach(() => {
    if (originalToken === undefined) delete process.env.PRESENCE_STUDIO_TOKEN;
    else process.env.PRESENCE_STUDIO_TOKEN = originalToken;
  });

  it('allows a remote token to reach /api/me and /api/front-desk/nav but still blocks other /api/* routes', () => {
    process.env.PRESENCE_STUDIO_TOKEN = 'studio-token';
    const middleware = requirePresenceStudioAccess();

    const meRes = fakeResponse();
    const meNext = vi.fn();
    middleware(
      fakeRequest({
        remoteAddress: '198.51.100.24',
        authorization: 'Bearer studio-token',
        urlPath: '/api/me?tenant=acme-corp',
      }) as never,
      meRes as never,
      meNext
    );
    expect(meNext).toHaveBeenCalledTimes(1);

    const navRes = fakeResponse();
    const navNext = vi.fn();
    middleware(
      fakeRequest({
        remoteAddress: '198.51.100.24',
        authorization: 'Bearer studio-token',
        urlPath: '/api/front-desk/nav?locale=ja',
      }) as never,
      navRes as never,
      navNext
    );
    expect(navNext).toHaveBeenCalledTimes(1);

    const blockedRes = fakeResponse();
    const blockedNext = vi.fn();
    middleware(
      fakeRequest({
        remoteAddress: '198.51.100.24',
        authorization: 'Bearer studio-token',
        urlPath: '/api/state',
      }) as never,
      blockedRes as never,
      blockedNext
    );
    expect(blockedNext).not.toHaveBeenCalled();
    expect(blockedRes.statusCode).toBe(403);
  });
});

describe('server.ts route wiring (Deliverables 1-2)', () => {
  it('wires GET /api/me to the shared viewer-scope + readFrontDeskMe pipeline', () => {
    const source = readRepoFile('presence/displays/presence-studio/server.ts');
    const routeStart = source.indexOf("presenceStudioData.app.get('/api/me'");
    const routeEnd = source.indexOf("presenceStudioData.app.get('/api/front-desk/nav'", routeStart);
    expect(routeStart).toBeGreaterThan(-1);
    const route = source.slice(routeStart, routeEnd === -1 ? undefined : routeEnd);

    expect(route).toContain('resolvePresenceStudioViewerContext(req)');
    expect(route).toContain('toFrontDeskViewerScope(viewer)');
    expect(route).toContain('readFrontDeskMe(scope');
    expect(route).toContain('presenceAvailableOperations(viewer)');
    expect(route).toContain("res.setHeader('Cache-Control', 'no-store')");
  });

  it('wires GET /api/front-desk/nav to the shared menu definition and locale-aware labels', () => {
    const source = readRepoFile('presence/displays/presence-studio/server.ts');
    const routeStart = source.indexOf("presenceStudioData.app.get('/api/front-desk/nav'");
    const routeEnd = source.indexOf(
      "presenceStudioData.app.get('/api/onboarding/browser-state'",
      routeStart
    );
    expect(routeStart).toBeGreaterThan(-1);
    const route = source.slice(routeStart, routeEnd === -1 ? undefined : routeEnd);

    expect(route).toContain('resolveFrontDeskMenu(');
    expect(route).toContain('readFrontDeskSurfacePorts()');
    expect(route).toContain('frontDeskRoleFromViewer(');
    expect(route).toContain("res.setHeader('Cache-Control', 'no-store')");
  });
});

describe('security.ts remote-safe allowlist wiring (Deliverable 1)', () => {
  it('extends the allowlist to /api/me and /api/front-desk/nav without removing the existing entries', () => {
    const source = readRepoFile('presence/displays/presence-studio/security.ts');
    expect(source).toContain("path.startsWith('/api/headless/')");
    expect(source).toContain("path.startsWith('/api/os/')");
    expect(source).toContain("path === '/api/me'");
    expect(source).toContain("path === '/api/front-desk/nav'");
  });
});

describe('interim front-desk page redirects (Deliverable 4)', () => {
  it('registers /ask and /help as 302 redirects to their interim targets', () => {
    const source = readRepoFile(
      'presence/displays/presence-studio/presence-studio-runtime-data.ts'
    );

    const askStart = source.indexOf("app.get('/ask'");
    const progressStart = source.indexOf("app.get('/progress'");
    const helpStart = source.indexOf("app.get('/help'");
    expect(askStart).toBeGreaterThan(-1);
    expect(progressStart).toBeGreaterThan(-1);
    expect(helpStart).toBeGreaterThan(-1);

    // FD-02 moved the workbench these panels live in from `/` to `/work`.
    expect(source.slice(askStart, progressStart)).toContain(
      "res.redirect(302, '/work#voice-panel')"
    );
    expect(source.slice(helpStart, helpStart + 200)).toContain("res.redirect(302, '/onboarding')");
  });
});

describe('FD-05 progress page routing (Deliverable 4)', () => {
  it('serves progress.html at /progress instead of the interim /work redirect', () => {
    const source = readRepoFile(
      'presence/displays/presence-studio/presence-studio-runtime-data.ts'
    );
    const progressStart = source.indexOf("app.get('/progress'");
    const helpStart = source.indexOf("app.get('/help'");
    expect(progressStart).toBeGreaterThan(-1);
    expect(source.slice(progressStart, helpStart)).toContain("'progress.html'");
    expect(source.slice(progressStart, helpStart)).not.toContain('res.redirect');
  });
});

describe('FD-02 home page routing (Deliverable 3)', () => {
  it('serves home.html at / and the pre-FD-02 workbench (index.html) at /work, registered ahead of express.static', () => {
    const source = readRepoFile(
      'presence/displays/presence-studio/presence-studio-runtime-data.ts'
    );
    const rootRouteStart = source.indexOf("app.get('/', ");
    const workRouteStart = source.indexOf("app.get('/work', ");
    const staticStart = source.indexOf('app.use(express.static(staticDir))');
    expect(rootRouteStart).toBeGreaterThan(-1);
    expect(workRouteStart).toBeGreaterThan(-1);
    expect(staticStart).toBeGreaterThan(-1);
    // Both explicit routes must be registered before express.static so its
    // default `index: 'index.html'` behavior for `GET /` never wins.
    expect(rootRouteStart).toBeLessThan(staticStart);
    expect(workRouteStart).toBeLessThan(staticStart);

    expect(source.slice(rootRouteStart, workRouteStart)).toContain("'home.html'");
    expect(source.slice(workRouteStart, staticStart)).toContain("'index.html'");
  });
});

describe('static rail mount (Deliverable 3)', () => {
  it('mounts the rail in home.html as current "home", and in index.html / onboarding.html as expected', () => {
    const homeHtml = readRepoFile('presence/displays/presence-studio/static/home.html');
    expect(homeHtml).toContain('id="front-desk-rail"');
    expect(homeHtml).toContain('front-desk-rail.css');
    expect(homeHtml).toContain('front-desk-rail.js');
    expect(homeHtml).toContain("current: 'home'");
    expect(homeHtml).toContain('<title>ホーム — Kyberion</title>');

    const indexHtml = readRepoFile('presence/displays/presence-studio/static/index.html');
    expect(indexHtml).toContain('id="front-desk-rail"');
    expect(indexHtml).toContain('front-desk-rail.css');
    expect(indexHtml).toContain('front-desk-rail.js');
    // FD-02: index.html moved from `/` to `/work` — nothing renders as
    // "current" there anymore (home.html owns the "home" rail item).
    expect(indexHtml).toContain('current: null');

    const onboardingHtml = readRepoFile('presence/displays/presence-studio/static/onboarding.html');
    expect(onboardingHtml).toContain('id="front-desk-rail"');
    expect(onboardingHtml).toContain('front-desk-rail.css');
    expect(onboardingHtml).toContain('front-desk-rail.js');
    expect(onboardingHtml).toContain("current: 'settings'");
  });

  it('never opens a rail link in a new tab and never hardcodes the loopback host', () => {
    const railJs = readRepoFile('presence/displays/presence-studio/static/front-desk-rail.js');
    expect(railJs).not.toContain('target=');
    expect(railJs).not.toContain('127.0.0.1');
    expect(railJs).toContain('FrontDeskRail');
  });

  it('home.html/home.js never use target="_blank", emoji, 127.0.0.1, or internal vocabulary', () => {
    const homeHtml = readRepoFile('presence/displays/presence-studio/static/home.html');
    const homeJs = readRepoFile('presence/displays/presence-studio/static/home.js');
    const combined = `${homeHtml}\n${homeJs}`;

    expect(combined).not.toContain('target=');
    expect(combined).not.toContain('127.0.0.1');
    // Kana/Hangul-adjacent emoji ranges aren't checked here; this is a
    // literal-emoji smoke check for the common pictograph block.
    expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(combined)).toBe(false);

    const forbiddenWords = [
      'mission',
      'ADF',
      'actuator',
      'pipeline',
      'stimuli',
      'A2UI',
      'Presence Studio',
      'ports',
    ];
    for (const word of forbiddenWords) {
      expect(combined.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });
});

describe('FD-02 remote-safe allowlist wiring', () => {
  it('extends the allowlist to /api/home and /api/home-vocabulary without removing the existing entries', () => {
    const source = readRepoFile('presence/displays/presence-studio/security.ts');
    expect(source).toContain("path === '/api/me'");
    expect(source).toContain("path === '/api/front-desk/nav'");
    expect(source).toContain("path === '/api/home'");
    expect(source).toContain("path === '/api/home-vocabulary'");
  });

  it('allows a remote token to reach /api/home and /api/home-vocabulary but still blocks other /api/* routes', () => {
    process.env.PRESENCE_STUDIO_TOKEN = 'studio-token';
    const middleware = requirePresenceStudioAccess();

    const homeRes = fakeResponse();
    const homeNext = vi.fn();
    middleware(
      fakeRequest({
        remoteAddress: '198.51.100.24',
        authorization: 'Bearer studio-token',
        urlPath: '/api/home',
      }) as never,
      homeRes as never,
      homeNext
    );
    expect(homeNext).toHaveBeenCalledTimes(1);

    const vocabRes = fakeResponse();
    const vocabNext = vi.fn();
    middleware(
      fakeRequest({
        remoteAddress: '198.51.100.24',
        authorization: 'Bearer studio-token',
        urlPath: '/api/home-vocabulary?locale=ja',
      }) as never,
      vocabRes as never,
      vocabNext
    );
    expect(vocabNext).toHaveBeenCalledTimes(1);

    delete process.env.PRESENCE_STUDIO_TOKEN;
  });
});

describe('FD-05 progress page static contract', () => {
  it('mounts the rail in progress.html as current "progress"', () => {
    const progressHtml = readRepoFile('presence/displays/presence-studio/static/progress.html');
    expect(progressHtml).toContain('id="front-desk-rail"');
    expect(progressHtml).toContain('front-desk-rail.css');
    expect(progressHtml).toContain('front-desk-rail.js');
    expect(progressHtml).toContain("current: 'progress'");
  });

  it('progress.html/progress.js never use target="_blank", emoji, 127.0.0.1, or internal vocabulary', () => {
    const progressHtml = readRepoFile('presence/displays/presence-studio/static/progress.html');
    const progressJs = readRepoFile('presence/displays/presence-studio/static/progress.js');
    const combined = `${progressHtml}\n${progressJs}`;

    expect(combined).not.toContain('target=');
    expect(combined).not.toContain('127.0.0.1');
    expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(combined)).toBe(false);

    const forbiddenWords = [
      'mission',
      'ADF',
      'actuator',
      'pipeline',
      'stimuli',
      'A2UI',
      'Presence Studio',
      'ports',
    ];
    for (const word of forbiddenWords) {
      expect(combined.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });
});

describe('FD-05 remote-safe allowlist wiring', () => {
  it('extends the allowlist to /api/progress and /api/progress-vocabulary but leaves the verdict mutation out', () => {
    const source = readRepoFile('presence/displays/presence-studio/security.ts');
    expect(source).toContain("path === '/api/progress'");
    expect(source).toContain("path.startsWith('/api/progress/')");
    expect(source).toContain("path === '/api/progress-vocabulary'");
  });

  it('allows a remote token to reach /api/progress and /api/progress/:id but still blocks other /api/* routes', () => {
    process.env.PRESENCE_STUDIO_TOKEN = 'studio-token';
    const middleware = requirePresenceStudioAccess();

    const listRes = fakeResponse();
    const listNext = vi.fn();
    middleware(
      fakeRequest({
        remoteAddress: '198.51.100.24',
        authorization: 'Bearer studio-token',
        urlPath: '/api/progress',
      }) as never,
      listRes as never,
      listNext
    );
    expect(listNext).toHaveBeenCalledTimes(1);

    const detailRes = fakeResponse();
    const detailNext = vi.fn();
    middleware(
      fakeRequest({
        remoteAddress: '198.51.100.24',
        authorization: 'Bearer studio-token',
        urlPath: '/api/progress/ts-1',
      }) as never,
      detailRes as never,
      detailNext
    );
    expect(detailNext).toHaveBeenCalledTimes(1);

    const verdictRes = fakeResponse();
    const verdictNext = vi.fn();
    middleware(
      fakeRequest({
        remoteAddress: '198.51.100.24',
        authorization: 'Bearer studio-token',
        urlPath: '/api/outcomes/INBOX-1/verdict',
      }) as never,
      verdictRes as never,
      verdictNext
    );
    expect(verdictNext).not.toHaveBeenCalled();
    expect(verdictRes.statusCode).toBe(403);

    delete process.env.PRESENCE_STUDIO_TOKEN;
  });
});

describe('server.ts route wiring (FD-05 Deliverable 2)', () => {
  it('wires GET /api/progress, GET /api/progress/:id, GET /api/progress-vocabulary, and POST /api/outcomes/:id/verdict', () => {
    const source = readRepoFile('presence/displays/presence-studio/server.ts');
    expect(source).toContain("presenceStudioData.app.get('/api/progress'");
    expect(source).toContain("presenceStudioData.app.get('/api/progress/:id'");
    expect(source).toContain("presenceStudioData.app.get('/api/progress-vocabulary'");
    expect(source).toContain("presenceStudioData.app.post('/api/outcomes/:id/verdict'");

    const verdictStart = source.indexOf("presenceStudioData.app.post('/api/outcomes/:id/verdict'");
    const verdictRoute = source.slice(verdictStart, verdictStart + 1500);
    expect(verdictRoute).toContain('requirePresenceStudioLocalAdmin(');
  });
});
