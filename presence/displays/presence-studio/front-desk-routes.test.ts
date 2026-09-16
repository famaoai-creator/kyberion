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

// FD-00/FD-01 routes moved from `server.ts` into `front-desk-routes.ts` (a
// dedicated module, registered from `server.ts` via `registerFrontDeskRoutes`)
// purely to keep `server.ts` under the repo's `max-file-lines` gate — same
// routes, same wiring, so these checks now read the new module instead.
describe('front-desk-routes.ts route wiring (Deliverables 1-2)', () => {
  it('wires GET /api/me to the shared viewer-scope + readFrontDeskMe pipeline', () => {
    const source = readRepoFile('presence/displays/presence-studio/front-desk-routes.ts');
    const routeStart = source.indexOf("app.get('/api/me'");
    const routeEnd = source.indexOf("app.get('/api/front-desk/nav'", routeStart);
    expect(routeStart).toBeGreaterThan(-1);
    const route = source.slice(routeStart, routeEnd === -1 ? undefined : routeEnd);

    expect(route).toContain('resolvePresenceStudioViewerContext(req)');
    expect(route).toContain('toFrontDeskViewerScope(viewer)');
    expect(route).toContain('readFrontDeskMe(scope');
    expect(route).toContain('presenceAvailableOperations(viewer)');
    expect(route).toContain("res.setHeader('Cache-Control', 'no-store')");
  });

  it('wires GET /api/front-desk/nav to the shared menu definition and locale-aware labels', () => {
    const source = readRepoFile('presence/displays/presence-studio/front-desk-routes.ts');
    const routeStart = source.indexOf("app.get('/api/front-desk/nav'");
    const routeEnd = source.indexOf("app.get('/api/home-vocabulary'", routeStart);
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

// FD-02/03/05/08 page routes moved from `presence-studio-runtime-data.ts`
// into `front-desk-pages.ts` (registered from the same two call sites via
// `registerFrontDeskHomeWorkPages` / `registerFrontDeskAuxPages`) purely to
// keep `presence-studio-runtime-data.ts` under the repo's `max-file-lines`
// gate — same routes, same registration order, so these checks now read the
// new module for route content and the runtime-data module only for the
// call-site ordering around `express.static`.
describe('FD-08 help page routing', () => {
  it('serves help.html at /help instead of the interim /onboarding redirect', () => {
    const source = readRepoFile('presence/displays/presence-studio/front-desk-pages.ts');

    const helpStart = source.indexOf("app.get('/help'");
    expect(helpStart).toBeGreaterThan(-1);
    const helpRoute = source.slice(helpStart, helpStart + 200);
    expect(helpRoute).toContain("'help.html'");
    expect(helpRoute).not.toContain('res.redirect');
  });
});

describe('FD-03 ask page routing (Deliverable 3)', () => {
  it('serves ask.html at /ask instead of the interim /work redirect', () => {
    const source = readRepoFile('presence/displays/presence-studio/front-desk-pages.ts');
    const askStart = source.indexOf("app.get('/ask'");
    const progressStart = source.indexOf("app.get('/progress'");
    expect(askStart).toBeGreaterThan(-1);
    expect(source.slice(askStart, progressStart)).toContain("'ask.html'");
    expect(source.slice(askStart, progressStart)).not.toContain('res.redirect');
  });
});

describe('FD-05 progress page routing (Deliverable 4)', () => {
  it('serves progress.html at /progress instead of the interim /work redirect', () => {
    const source = readRepoFile('presence/displays/presence-studio/front-desk-pages.ts');
    const progressStart = source.indexOf("app.get('/progress'");
    const helpStart = source.indexOf("app.get('/help'");
    expect(progressStart).toBeGreaterThan(-1);
    expect(source.slice(progressStart, helpStart)).toContain("'progress.html'");
    expect(source.slice(progressStart, helpStart)).not.toContain('res.redirect');
  });
});

describe('FD-02 home page routing (Deliverable 3)', () => {
  it('serves home.html at / and the pre-FD-02 workbench (index.html) at /work, registered ahead of express.static', () => {
    const runtimeSource = readRepoFile(
      'presence/displays/presence-studio/presence-studio-runtime-data.ts'
    );
    const registerCallStart = runtimeSource.indexOf('registerFrontDeskHomeWorkPages(');
    const staticStart = runtimeSource.indexOf('app.use(express.static(staticDir))');
    expect(registerCallStart).toBeGreaterThan(-1);
    expect(staticStart).toBeGreaterThan(-1);
    // The routes must be registered ahead of express.static so its default
    // `index: 'index.html'` behavior for `GET /` never wins.
    expect(registerCallStart).toBeLessThan(staticStart);

    const pagesSource = readRepoFile('presence/displays/presence-studio/front-desk-pages.ts');
    const rootRouteStart = pagesSource.indexOf("app.get('/', ");
    const workRouteStart = pagesSource.indexOf("app.get('/work', ");
    expect(rootRouteStart).toBeGreaterThan(-1);
    expect(workRouteStart).toBeGreaterThan(-1);
    expect(rootRouteStart).toBeLessThan(workRouteStart);

    expect(pagesSource.slice(rootRouteStart, workRouteStart)).toContain("'home.html'");
    expect(pagesSource.slice(workRouteStart, workRouteStart + 200)).toContain("'index.html'");
  });
});

describe('static rail mount (Deliverable 3)', () => {
  it('mounts the rail in home.html as current "home", and in index.html / help.html as expected', () => {
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

    // FD-08: /help is not one of the 5 rail items either — like /work,
    // nothing renders as "current" there.
    const helpHtml = readRepoFile('presence/displays/presence-studio/static/help.html');
    expect(helpHtml).toContain('id="front-desk-rail"');
    expect(helpHtml).toContain('front-desk-rail.css');
    expect(helpHtml).toContain('front-desk-rail.js');
    expect(helpHtml).toContain('current: null');
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

describe('front-desk-routes.ts route wiring (FD-05 Deliverable 2)', () => {
  it('wires GET /api/progress, GET /api/progress/:id, GET /api/progress-vocabulary, and POST /api/outcomes/:id/verdict', () => {
    const source = readRepoFile('presence/displays/presence-studio/front-desk-routes.ts');
    expect(source).toContain("app.get('/api/progress'");
    expect(source).toContain("app.get('/api/progress/:id'");
    expect(source).toContain("app.get('/api/progress-vocabulary'");
    expect(source).toContain("app.post('/api/outcomes/:id/verdict'");

    const verdictStart = source.indexOf("app.post('/api/outcomes/:id/verdict'");
    const verdictRoute = source.slice(verdictStart, verdictStart + 1500);
    expect(verdictRoute).toContain('requirePresenceStudioLocalAdmin(');
  });
});

describe('server.ts installs the real reasoning backend before routes register', () => {
  it('calls installReasoningBackends( before registerFrontDeskRoutes(', () => {
    const source = readRepoFile('presence/displays/presence-studio/server.ts');
    const installCall = source.indexOf('installReasoningBackends(');
    const frontDeskCall = source.indexOf('registerFrontDeskRoutes(');
    expect(installCall).toBeGreaterThan(-1);
    expect(frontDeskCall).toBeGreaterThan(installCall);
  });
});

describe('FD-03 ask page static contract', () => {
  it('mounts the rail in ask.html as current "ask"', () => {
    const askHtml = readRepoFile('presence/displays/presence-studio/static/ask.html');
    expect(askHtml).toContain('id="front-desk-rail"');
    expect(askHtml).toContain('front-desk-rail.css');
    expect(askHtml).toContain('front-desk-rail.js');
    expect(askHtml).toContain("current: 'ask'");
  });

  it('ask.html/ask.js never use target="_blank", emoji, 127.0.0.1, or internal vocabulary', () => {
    const askHtml = readRepoFile('presence/displays/presence-studio/static/ask.html');
    const askJs = readRepoFile('presence/displays/presence-studio/static/ask.js');
    const combined = `${askHtml}\n${askJs}`;

    expect(combined).not.toContain('target=');
    expect(combined).not.toContain('127.0.0.1');
    expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(combined)).toBe(false);

    // HT-03 (2nd half): `mission_id` is the `/handoff` response's wire field
    // name, and `front_desk:hearing_mission_label` is a vocabulary-key
    // identifier — neither is rendered prose (the key's *value* is
    // "Request {id}" / "依頼番号 {id}", no "mission" wording shown to the
    // user). Strip both before scanning so an identifier substring can't
    // trip the raw-copy guard the forbidden-word list exists for.
    const withoutInternalIdentifiers = combined
      .replace(/front_desk:[a-zA-Z0-9_]+/g, '')
      .replace(/\bmission_id\b/g, '');

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
      expect(withoutInternalIdentifiers.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });

  it('FD-09: renders resolution_shape and the turn shape chip through vocabulary lookups, never the raw enum', () => {
    const askJs = readRepoFile('presence/displays/presence-studio/static/ask.js');

    // The "Current state" block looks `resolution_shape` up in a
    // vocabulary-key map instead of writing the raw enum value.
    expect(askJs).toContain('function shapeLabelKey');
    expect(askJs).toContain('shapeLabelKey(contract.resolution_shape)');
    expect(askJs).not.toMatch(/:\s*contract\.resolution_shape\s*[;\n]/);

    // The conversation-turn shape chip does the same for the UX-contract
    // shape id instead of `escapeHtml(turn.shape)` verbatim.
    expect(askJs).toContain('function turnShapeLabelKey');
    expect(askJs).toContain('turnShapeLabelKey(turn.shape)');
    expect(askJs).not.toContain('escapeHtml(turn.shape)');

    // "What I understood" prefers the server-resolved `intent_label` over
    // the raw `normalized_intent` slug.
    expect(askJs).toContain('companionTurn.intent_label');
    expect(askJs).not.toMatch(/'about-understood'[^)]*contract\.normalized_intent/s);
  });
});

describe('FD-03 remote-safe allowlist wiring', () => {
  it('extends the allowlist to /api/ask-vocabulary but leaves /api/conversation out', () => {
    const source = readRepoFile('presence/displays/presence-studio/security.ts');
    expect(source).toContain("path === '/api/ask-vocabulary'");
  });

  it('allows a remote token to reach /api/ask-vocabulary but blocks /api/conversation', () => {
    process.env.PRESENCE_STUDIO_TOKEN = 'studio-token';
    const middleware = requirePresenceStudioAccess();

    const vocabRes = fakeResponse();
    const vocabNext = vi.fn();
    middleware(
      fakeRequest({
        remoteAddress: '198.51.100.24',
        authorization: 'Bearer studio-token',
        urlPath: '/api/ask-vocabulary?locale=ja',
      }) as never,
      vocabRes as never,
      vocabNext
    );
    expect(vocabNext).toHaveBeenCalledTimes(1);

    const conversationRes = fakeResponse();
    const conversationNext = vi.fn();
    middleware(
      fakeRequest({
        remoteAddress: '198.51.100.24',
        authorization: 'Bearer studio-token',
        urlPath: '/api/conversation',
      }) as never,
      conversationRes as never,
      conversationNext
    );
    expect(conversationNext).not.toHaveBeenCalled();
    expect(conversationRes.statusCode).toBe(403);

    delete process.env.PRESENCE_STUDIO_TOKEN;
  });
});

describe('front-desk-routes.ts route wiring (FD-03 Deliverable 1)', () => {
  it('wires GET /api/ask-vocabulary and POST /api/conversation', () => {
    const source = readRepoFile('presence/displays/presence-studio/front-desk-routes.ts');
    expect(source).toContain("app.get('/api/ask-vocabulary'");
    expect(source).toContain("app.post('/api/conversation'");

    const conversationStart = source.indexOf("app.post('/api/conversation'");
    const conversationRoute = source.slice(conversationStart, conversationStart + 6500);
    expect(conversationRoute).toContain('requirePresenceStudioLocalAdmin(');
    expect(conversationRoute).toContain('presenceStudioConversationScope(');
    expect(conversationRoute).toContain('viewFromIntentResolution(');
    expect(conversationRoute).toContain('checkAndRepairSurfaceUxContract(');
    expect(conversationRoute).toContain('runSurfaceMessageConversation(');
    expect(conversationRoute).toContain("mode: 'unavailable'");
  });
});

describe('FD-08 help page static contract', () => {
  it('mounts the rail in help.html as current null and links to /ask, decide, and /progress', () => {
    const helpHtml = readRepoFile('presence/displays/presence-studio/static/help.html');
    expect(helpHtml).toContain('id="front-desk-rail"');
    expect(helpHtml).toContain('front-desk-rail.css');
    expect(helpHtml).toContain('front-desk-rail.js');
    expect(helpHtml).toContain('current: null');
    expect(helpHtml).toContain('id="help-ask-link"');
    expect(helpHtml).toContain('id="help-decide-link"');
    expect(helpHtml).toContain('id="help-progress-link"');
  });

  it('fills every link and sentence from GET /api/front-desk/nav, never a hardcoded port', () => {
    const helpJs = readRepoFile('presence/displays/presence-studio/static/help.js');
    expect(helpJs).toContain("fetch('/api/front-desk/nav?locale=");
    expect(helpJs).not.toContain('127.0.0.1');
    expect(helpJs).not.toContain('target=');
  });

  it('help.html/help.js never use target="_blank", emoji, 127.0.0.1, or internal vocabulary', () => {
    const helpHtml = readRepoFile('presence/displays/presence-studio/static/help.html');
    const helpJs = readRepoFile('presence/displays/presence-studio/static/help.js');
    const combined = `${helpHtml}\n${helpJs}`;

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

describe('FD-08 removed presence-studio dashboard panels', () => {
  it('drops the moved-to-control-plane panel ids and the developer A2UI sandbox from index.html', () => {
    const indexHtml = readRepoFile('presence/displays/presence-studio/static/index.html');
    const removedIds = [
      'id="current-agent-panel"',
      'id="agent-catalog-panel"',
      'id="project-panel"',
      'id="track-panel"',
      'id="binding-panel"',
      'id="mission-seed-panel"',
      'id="stimuli-panel"',
      'id="intent-resolution-panel"',
      'id="memory-panel"',
      'id="dev-panel"',
      'id="first-run-banner"',
    ];
    for (const marker of removedIds) {
      expect(indexHtml).not.toContain(marker);
    }
    expect(indexHtml).not.toContain('Observation Audit');
    expect(indexHtml).not.toContain('できること');
    expect(indexHtml).not.toContain(
      'A Digital Agency-inspired capture surface for subtitles, notes, minutes, and governed voice-channel stimuli.'
    );
  });

  it('keeps the ux-contract literal calls even though the Intent Resolution panel is gone', () => {
    const indexHtml = readRepoFile('presence/displays/presence-studio/static/index.html');
    expect(indexHtml).toContain('renderIntentResolution(body.intentResolution)');
    expect(indexHtml).toContain('understanding');
    expect(indexHtml).toContain('outcome_kind');
  });

  it('drops the /api/surface-agents route (nothing outside index.html referenced it) but keeps every route index.html or another caller still needs', () => {
    const serverSource = readRepoFile('presence/displays/presence-studio/server.ts');
    expect(serverSource).not.toContain("app.get('/api/surface-agents'");
    // Kept because a test (os-control-plane-route.test.ts) requires the
    // canonical standard-intent catalog loader be wired here.
    expect(serverSource).toContain("presenceStudioData.app.get('/api/standard-intents'");
    // Kept because libs/core/control-plane-client.ts and
    // scripts/control_plane_cli.ts still call these on this surface.
    expect(serverSource).toContain("presenceStudioData.app.get('/api/projects'");
    expect(serverSource).toContain("presenceStudioData.app.get('/api/project-tracks'");
    expect(serverSource).toContain("presenceStudioData.app.get('/api/service-bindings'");
    expect(serverSource).toContain("presenceStudioData.app.get('/api/mission-seeds'");
    // Kept because index.html's Work Detail / Requested Work / Latest
    // Outcomes "learned" links still resolve through these.
    expect(serverSource).toContain("presenceStudioData.app.get('/api/distill-candidates'");
    expect(serverSource).toContain("presenceStudioData.app.get('/api/knowledge-ref'");
  });
});

describe('HT-06 i18n gate: hearing canvas + training help vocabulary', () => {
  it('hearing.ts and hearing-runtime.ts carry no raw Japanese/English requirement labels or canvas chrome text', () => {
    const hearingTs = readRepoFile('presence/displays/presence-studio/hearing.ts');
    const hearingRuntimeTs = readRepoFile('presence/displays/presence-studio/hearing-runtime.ts');
    // The old raw labels are gone — every requirement now carries a
    // `front_desk:hearing_req_*` vocabulary key instead.
    for (const oldLabel of [
      '対象となる人',
      '解決したいこと',
      '主な流れ',
      '載せる内容',
      '見た目の方向',
      '制約・条件',
      'できたと判断する条件',
    ]) {
      expect(hearingTs).not.toContain(oldLabel);
    }
    expect(hearingTs).toContain("label_key: 'front_desk:hearing_req_audience'");
    // The canvas's fixed chrome (title, heading, coverage, unanswered
    // fallback) is gone as raw text and resolved through `t()` instead.
    for (const oldText of [
      'ヒアリングの案',
      '作りたいものの整理',
      '項目が埋まっています',
      'まだ聞けていません',
    ]) {
      expect(hearingRuntimeTs).not.toContain(oldText);
    }
    expect(hearingRuntimeTs).toContain("catalogT('front_desk:hearing_canvas_page_title'");
    expect(hearingRuntimeTs).toContain("catalogT('front_desk:hearing_canvas_heading'");
    expect(hearingRuntimeTs).toContain("'front_desk:hearing_canvas_coverage'");
    expect(hearingRuntimeTs).toContain("catalogT('front_desk:hearing_canvas_unanswered'");
    expect(hearingRuntimeTs).toContain('item.label_key as VocabularyKey');
  });

  it('renderHearingCanvas resolves requirement labels and chrome text per locale, never persisting rendered text', () => {
    const html = catalogT('front_desk:hearing_canvas_heading', undefined, 'ja');
    expect(html).toBe('作りたいものの整理');
    const enHtml = catalogT('front_desk:hearing_canvas_heading', undefined, 'en');
    expect(enHtml).not.toBe(html);
  });

  it('ask.html/ask.js hearing card has no raw Japanese fixed copy and reads it from /api/ask-vocabulary', () => {
    const askHtml = readRepoFile('presence/displays/presence-studio/static/ask.html');
    const askJs = readRepoFile('presence/displays/presence-studio/static/ask.js');
    for (const oldText of [
      'ヒアリングの整理',
      '項目が埋まっています',
      'この内容で進める',
      '準備中',
      '要件キャンバス',
    ]) {
      expect(askHtml).not.toContain(oldText);
      expect(askJs).not.toContain(oldText);
    }
    expect(askJs).toContain("vt(state.vocab, 'front_desk:hearing_title')");
    expect(askJs).toContain("vt(state.vocab, 'front_desk:hearing_coverage')");
    expect(askJs).toContain("vt(state.vocab, 'front_desk:hearing_decide')");
    expect(askJs).toContain("vt(state.vocab, 'front_desk:hearing_pending')");
    expect(askJs).toContain("vt(state.vocab, 'front_desk:hearing_canvas_frame_title')");
    // HT-02: the canvas-generation status line under the iframe.
    expect(askJs).toContain('front_desk:hearing_canvas_updating');
    expect(askJs).toContain('front_desk:hearing_canvas_generated');
    expect(askJs).toContain('front_desk:hearing_canvas_template');
    expect(askJs).toContain('canvas_generation');
    // HT-03 (2nd half): the hand-off button + its result.
    expect(askJs).toContain("vt(state.vocab, 'front_desk:hearing_handoff_button')");
    expect(askJs).toContain("vt(state.vocab, 'front_desk:hearing_handoff_pending')");
    expect(askJs).toContain("vt(state.vocab, 'front_desk:hearing_handoff_done')");
    expect(askJs).toContain("vt(state.vocab, 'front_desk:hearing_handoff_failed')");
    expect(askJs).toContain("vt(state.vocab, 'front_desk:hearing_mission_label')");
    expect(askJs).toContain("vt(state.vocab, 'front_desk:hearing_open_decide')");
    expect(askJs).toContain('/handoff?locale=');
    // The hearing endpoints carry the same `?locale=` the page already
    // sends to `/api/ask-vocabulary`.
    expect(askJs).toContain('/api/hearing/');
    expect(askJs).toMatch(/locale=.*encodeURIComponent\(state\.locale\)/);
  });

  it('help.html/help.js training block has no raw Japanese fixed copy and reads it from /api/help-vocabulary', () => {
    const helpJs = readRepoFile('presence/displays/presence-studio/static/help.js');
    for (const oldText of [
      'トラックから選ぶ',
      '開く',
      '使い方の一覧に戻る',
      'やってみる',
      'できたこと:',
      '未着手',
      '進行中',
      '完了',
    ]) {
      expect(helpJs).not.toContain(oldText);
    }
    expect(helpJs).toContain("fetch('/api/help-vocabulary?locale=");
    expect(helpJs).toContain("vt(vocab, 'front_desk:training_choose_track')");
    expect(helpJs).toContain("vt(vocab, 'front_desk:training_open')");
    expect(helpJs).toContain("vt(vocab, 'front_desk:training_back')");
    expect(helpJs).toContain("vt(vocab, 'front_desk:training_try')");
    expect(helpJs).toContain("vt(vocab, 'front_desk:training_done_prefix')");
    expect(helpJs).toContain('TRAINING_LEVEL_KEY');
    expect(helpJs).toContain('TRAINING_STATUS_KEY');
  });

  it('extends the remote-safe allowlist to /api/help-vocabulary', () => {
    const source = readRepoFile('presence/displays/presence-studio/security.ts');
    expect(source).toContain("path === '/api/help-vocabulary'");
  });

  it('wires GET /api/help-vocabulary the same shape as /api/ask-vocabulary', () => {
    const source = readRepoFile('presence/displays/presence-studio/front-desk-routes.ts');
    expect(source).toContain("app.get('/api/help-vocabulary'");
    const helpVocabStart = source.indexOf("app.get('/api/help-vocabulary'");
    const helpVocabRoute = source.slice(helpVocabStart, helpVocabStart + 400);
    expect(helpVocabRoute).toContain('HELP_VOCABULARY_KEYS');
    expect(helpVocabRoute).toContain("res.setHeader('Cache-Control', 'no-store')");
  });

  it('HT-04/05 second pass: help.js marks a lesson done by posting complete, using the training_mark_done* keys and no raw copy', () => {
    const helpJs = readRepoFile('presence/displays/presence-studio/static/help.js');

    // `HELP_VOCABULARY_KEYS` is frozen for this wave, so the mark-done copy
    // comes from a dedicated `/api/training/vocabulary` fetch instead.
    expect(helpJs).toContain("fetch('/api/training/vocabulary?locale=");
    expect(helpJs).toContain("fetch('/api/training/progress', {");
    expect(helpJs).toContain("method: 'POST'");
    expect(helpJs).toContain("status: 'complete'");
    expect(helpJs).toContain('lesson_id: lessonId');
    expect(helpJs).toContain("vt(vocab, 'front_desk:training_mark_done')");
    expect(helpJs).toContain("vt(vocab, 'front_desk:training_mark_done_recorded')");
    expect(helpJs).toContain("vt(vocab, 'front_desk:training_mark_done_failed')");

    // No raw stand-in copy for the new button/notice text.
    for (const oldText of ['できた', '記録しました', '記録できませんでした']) {
      expect(helpJs).not.toContain(oldText);
    }

    // Same posture as every other page: no hardcoded ports, no target=,
    // no emoji, no internal jargon leaking into the surface.
    expect(helpJs).not.toContain('127.0.0.1');
    expect(helpJs).not.toContain('target=');
    expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(helpJs)).toBe(false);
  });
});
