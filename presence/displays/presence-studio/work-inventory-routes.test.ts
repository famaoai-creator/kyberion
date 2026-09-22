// WI-11: the presence-studio progress page's work-inventory
// automation-candidate panel, split out into `work-inventory-routes.ts` — see
// its module doc and `training-routes.test.ts` / `hearing-routes.test.ts`
// for the established pattern this file follows: register the real
// `registerWorkInventoryRoutes` onto a tiny fake `express.Express` that
// records handlers by `METHOD path`, then exercise route behavior directly.
// `libs/core/work-inventory*.ts` persist under real
// `knowledge/confidential/<tenant>/work-inventory/` and
// `knowledge/personal/members/<member_id>/work-inventory/` paths (no
// fixture-rootDir seam for the route layer, since the route itself never
// passes `rootDir`), so this file uses dedicated fictitious tenant/member
// ids and removes them in `afterEach`.
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver, safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core';
import { withExecutionContext } from '@agent/core/authority';
import {
  createWorkInventoryEntry,
  saveWorkInventoryEntry,
  workInventoryRoot,
  type WorkInventoryStep,
} from '@agent/core/work-inventory';
import { grantWorkInventoryConsent } from '@agent/core/work-inventory-consent';
import {
  observationSummaryPath,
  type WorkInventoryObservationSummary,
} from '@agent/core/work-inventory-observation';

vi.mock('@agent/core/member-registry', async () => {
  const actual = await vi.importActual<typeof import('@agent/core/member-registry')>(
    '@agent/core/member-registry'
  );
  return { ...actual, resolveMemberByPrincipal: vi.fn() };
});

import { resolveMemberByPrincipal } from '@agent/core/member-registry';
import {
  registerWorkInventoryRoutes,
  resolveWorkInventoryScopeForViewer,
  WORK_INVENTORY_VOCABULARY_KEYS,
} from './work-inventory-routes.js';
import type { PresenceStudioViewerContext } from './security.js';

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

function fakeRequest(overrides: {
  remoteAddress: string;
  authorization?: string;
  query?: Record<string, string>;
}) {
  const urlPath = '/api/front-desk/work-inventory';
  return {
    params: {},
    query: overrides.query || {},
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

const STEP_SENTINEL = 'ZZ-WI-ROUTE-STEP-SENTINEL-DESCRIPTION';

function fixtureStep(overrides: Partial<WorkInventoryStep> = {}): WorkInventoryStep {
  return {
    step_id: 'S1',
    stage: 'act',
    verb: 'input',
    description: STEP_SENTINEL,
    data_sensitivity: 'internal',
    effects: [],
    method: { assigned: 'ai_reasoning', source: 'rule', rule_id: 'r1', rationale: 'fixture' },
    ...overrides,
  };
}

describe('work-inventory-routes.ts route wiring', () => {
  it('registers the panel data and vocabulary endpoints', () => {
    const { app, handlers } = createFakeApp();
    registerWorkInventoryRoutes(app);
    expect(handlers.has('GET /api/front-desk/work-inventory')).toBe(true);
    expect(handlers.has('GET /api/work-inventory-vocabulary')).toBe(true);
  });

  it('server.ts registers work-inventory routes after training routes, behind the same guard', () => {
    const source = readRepoFile('presence/displays/presence-studio/server.ts');
    const trainingCall = source.indexOf('registerTrainingRoutes(presenceStudioData.app)');
    const workInventoryCall = source.indexOf('registerWorkInventoryRoutes(presenceStudioData.app)');
    expect(trainingCall).toBeGreaterThan(-1);
    expect(workInventoryCall).toBeGreaterThan(trainingCall);
  });
});

describe('resolveWorkInventoryScopeForViewer', () => {
  function viewer(overrides: Partial<PresenceStudioViewerContext>): PresenceStudioViewerContext {
    return { principalId: 'human:test', tenantSlugs: ['acme'], source: 'loopback', ...overrides };
  }

  it('resolves a single-tenant viewer to that tenant scope', () => {
    expect(resolveWorkInventoryScopeForViewer(viewer({ tenantSlugs: ['acme-corp'] }))).toEqual({
      tenant_slug: 'acme-corp',
    });
  });

  it('resolves the local owner (loopback "all" fallback) to the personal scope', () => {
    expect(
      resolveWorkInventoryScopeForViewer(viewer({ tenantSlugs: 'all', source: 'loopback' }))
    ).toEqual({});
  });

  it('resolves a remote "all" viewer to null — no single scope to read', () => {
    expect(
      resolveWorkInventoryScopeForViewer(viewer({ tenantSlugs: 'all', source: 'token' }))
    ).toBeNull();
  });

  it('resolves a loopback viewer with no tenant to the personal scope', () => {
    expect(
      resolveWorkInventoryScopeForViewer(viewer({ tenantSlugs: [], source: 'loopback' }))
    ).toEqual({});
  });

  it('never resolves a non-loopback (remote token) viewer with no tenant to the personal scope', () => {
    expect(
      resolveWorkInventoryScopeForViewer(viewer({ tenantSlugs: [], source: 'token' }))
    ).toBeNull();
  });
});

const TENANT_A = 'zz-wi-route-tenant-a';
const TENANT_B = 'zz-wi-route-tenant-b';
const TENANT_BROKEN = 'zz-wi-route-tenant-broken';

function cleanupTenant(tenant: string): void {
  withExecutionContext('ecosystem_architect', () =>
    safeRmSync(pathResolver.rootResolve(`knowledge/confidential/${tenant}`), {
      recursive: true,
      force: true,
    })
  );
}

describe('GET /api/front-desk/work-inventory (tenant scoping)', () => {
  const { app, handlers } = createFakeApp();
  registerWorkInventoryRoutes(app);
  const getPanel = handlers.get('GET /api/front-desk/work-inventory')!;
  const originalTenant = process.env.KYBERION_TENANT;

  beforeEach(() => {
    vi.mocked(resolveMemberByPrincipal).mockReset();
    vi.mocked(resolveMemberByPrincipal).mockReturnValue(null);
  });

  afterEach(() => {
    if (originalTenant === undefined) delete process.env.KYBERION_TENANT;
    else process.env.KYBERION_TENANT = originalTenant;
    cleanupTenant(TENANT_A);
    cleanupTenant(TENANT_B);
    cleanupTenant(TENANT_BROKEN);
  });

  it("only returns the viewer tenant's own candidates, counts, and never a step description or observation digest", () => {
    withExecutionContext('ecosystem_architect', () => {
      const entryA = createWorkInventoryEntry(
        {
          title: 'Tenant A monthly report',
          scope: { tenant_slug: TENANT_A },
          trigger: { kind: 'schedule', description: 'monthly' },
          frequency: { per: 'month', count: 4 },
          effort_minutes_per_run: 60,
          steps: [fixtureStep()],
        },
        new Date('2026-09-01T00:00:00.000Z')
      );
      saveWorkInventoryEntry({ ...entryA, status: 'confirmed' });

      const entryB = createWorkInventoryEntry(
        {
          title: 'Tenant B invoice run',
          scope: { tenant_slug: TENANT_B },
          trigger: { kind: 'schedule', description: 'monthly' },
          frequency: { per: 'month', count: 2 },
          effort_minutes_per_run: 30,
          steps: [fixtureStep({ description: 'TENANT-B-ONLY-STEP' })],
        },
        new Date('2026-09-01T00:00:00.000Z')
      );
      saveWorkInventoryEntry({ ...entryB, status: 'draft' });
    });

    process.env.KYBERION_TENANT = TENANT_A;
    const res = fakeResponse();
    getPanel(fakeRequest({ remoteAddress: '127.0.0.1' }), res);

    expect(res.statusCode).toBe(200);
    const body = res.body as {
      ok: boolean;
      scope: { tenant_slug?: string } | null;
      candidates: Array<{ entry_id: string; title: string; status: string }>;
      counts: Record<string, number>;
    };
    expect(body.ok).toBe(true);
    expect(body.scope).toEqual({ tenant_slug: TENANT_A });
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0]?.title).toBe('Tenant A monthly report');
    expect(body.candidates[0]?.status).toBe('confirmed');
    expect(body.counts.confirmed).toBe(1);
    expect(body.counts.draft).toBe(0);

    // Never a step description or observation digest — summary-level only.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(STEP_SENTINEL);
    expect(serialized).not.toContain('TENANT-B-ONLY-STEP');
    // Never another tenant's entry, even by title.
    expect(serialized).not.toContain('Tenant B invoice run');
  });

  it('returns an empty panel with zeroed counts when the tenant has no entries', () => {
    process.env.KYBERION_TENANT = TENANT_A;
    const res = fakeResponse();
    getPanel(fakeRequest({ remoteAddress: '127.0.0.1' }), res);

    expect(res.statusCode).toBe(200);
    const body = res.body as { ok: boolean; candidates: unknown[]; counts: Record<string, number> };
    expect(body.ok).toBe(true);
    expect(body.candidates).toEqual([]);
    expect(body.counts).toEqual({ draft: 0, confirmed: 0, candidate: 0, promoted: 0, retired: 0 });
  });

  it('a read failure (invalid stored entry) yields empty candidates/counts, never a 500', () => {
    withExecutionContext('ecosystem_architect', () => {
      const entriesDir = path.join(workInventoryRoot({ tenant_slug: TENANT_BROKEN }), 'entries');
      safeMkdir(entriesDir, { recursive: true });
      safeWriteFile(path.join(entriesDir, 'WI-broken.json'), '{ not valid json', {
        encoding: 'utf8',
      });
    });

    process.env.KYBERION_TENANT = TENANT_BROKEN;
    const res = fakeResponse();
    getPanel(fakeRequest({ remoteAddress: '127.0.0.1' }), res);

    expect(res.statusCode).toBe(200);
    const body = res.body as { ok: boolean; candidates: unknown[]; counts: Record<string, number> };
    expect(body.ok).toBe(true);
    expect(body.candidates).toEqual([]);
    expect(body.counts).toEqual({ draft: 0, confirmed: 0, candidate: 0, promoted: 0, retired: 0 });
  });

  it('rejects an unauthenticated remote viewer the same way /api/progress does', () => {
    const originalToken = process.env.PRESENCE_STUDIO_TOKEN;
    const originalAllowRemote = process.env.PRESENCE_STUDIO_ALLOW_REMOTE;
    delete process.env.PRESENCE_STUDIO_TOKEN;
    delete process.env.PRESENCE_STUDIO_ALLOW_REMOTE;

    const res = fakeResponse();
    getPanel(fakeRequest({ remoteAddress: '198.51.100.24' }), res);
    expect(res.statusCode).toBe(403);

    if (originalToken === undefined) delete process.env.PRESENCE_STUDIO_TOKEN;
    else process.env.PRESENCE_STUDIO_TOKEN = originalToken;
    if (originalAllowRemote === undefined) delete process.env.PRESENCE_STUDIO_ALLOW_REMOTE;
    else process.env.PRESENCE_STUDIO_ALLOW_REMOTE = originalAllowRemote;
  });
});

const CONSENT_MEMBER_ID = 'zz-wi-route-consent-member';
const OBSERVATION_SENTINEL = 'ZZ-WI-ROUTE-OBSERVATION-SENTINEL-STEP';

function cleanupMember(memberId: string): void {
  withExecutionContext('ecosystem_architect', () =>
    safeRmSync(path.join(pathResolver.rootDir(), 'knowledge/personal/members', memberId), {
      recursive: true,
      force: true,
    })
  );
}

function fixtureObservationSummary(
  overrides: Partial<WorkInventoryObservationSummary> = {}
): WorkInventoryObservationSummary {
  return {
    schema_version: 'work-inventory-observation-summary.v1',
    summary_id: 'WIO-20260901-aaaaaaaaaaaa',
    member_id: CONSENT_MEMBER_ID,
    consent_id: 'WIC-20260901-aaaaaaaaaaaa',
    source: 'desktop_recording',
    recording_hash: 'a'.repeat(64),
    window: { start: '2026-09-01T00:00:00.000Z', end: '2026-09-01T01:00:00.000Z' },
    apps: ['Excel'],
    hosts: [],
    op_counts: { click: 3 },
    step_count: 1,
    proposed_steps: [
      {
        stage: 'act',
        verb: 'operate',
        description: OBSERVATION_SENTINEL,
        effects: [],
        requires_attention: false,
      },
    ],
    status: 'pending_review',
    created_at: '2026-09-01T01:00:00.000Z',
    ...overrides,
  };
}

describe('GET /api/front-desk/work-inventory (consent, self only)', () => {
  const { app, handlers } = createFakeApp();
  registerWorkInventoryRoutes(app);
  const getPanel = handlers.get('GET /api/front-desk/work-inventory')!;

  beforeEach(() => {
    vi.mocked(resolveMemberByPrincipal).mockReset();
  });

  afterEach(() => {
    cleanupMember(CONSENT_MEMBER_ID);
  });

  function fixtureMember() {
    return {
      member_id: CONSENT_MEMBER_ID,
      display_name: 'ZZ WI Route Consent Tester',
      status: 'active' as const,
      memberships: [],
      access_registrations: [],
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
  }

  it("reports the resolved viewer's own active-consent and pending-summary counts, never a digest", () => {
    withExecutionContext('ecosystem_architect', () => {
      grantWorkInventoryConsent({
        member_id: CONSENT_MEMBER_ID,
        sources: ['desktop_recording'],
        observation_kinds: ['active_window'],
        purpose: 'work inventory route test',
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        granted_by: { kind: 'human', id: CONSENT_MEMBER_ID },
      });
      const filePath = observationSummaryPath(CONSENT_MEMBER_ID, 'WIO-20260901-aaaaaaaaaaaa');
      safeMkdir(path.dirname(filePath), { recursive: true });
      safeWriteFile(filePath, `${JSON.stringify(fixtureObservationSummary())}\n`, {
        encoding: 'utf8',
      });
    });
    vi.mocked(resolveMemberByPrincipal).mockReturnValue(fixtureMember());

    const res = fakeResponse();
    getPanel(fakeRequest({ remoteAddress: '127.0.0.1' }), res);

    expect(res.statusCode).toBe(200);
    const body = res.body as {
      ok: boolean;
      consent?: { active: number; expires_soonest?: string; pending_summaries: number };
    };
    expect(body.ok).toBe(true);
    expect(body.consent?.active).toBe(1);
    expect(body.consent?.pending_summaries).toBe(1);
    expect(typeof body.consent?.expires_soonest).toBe('string');
    expect(JSON.stringify(body)).not.toContain(OBSERVATION_SENTINEL);
  });

  it('omits the consent block entirely when no member resolves for the viewer', () => {
    vi.mocked(resolveMemberByPrincipal).mockReturnValue(null);

    const res = fakeResponse();
    getPanel(fakeRequest({ remoteAddress: '127.0.0.1' }), res);

    expect(res.statusCode).toBe(200);
    const body = res.body as { ok: boolean; consent?: unknown };
    expect(body.ok).toBe(true);
    expect(body.consent).toBeUndefined();
  });
});

describe('GET /api/work-inventory-vocabulary', () => {
  it('returns every progress-panel key the static page renders, non-empty', () => {
    const { app, handlers } = createFakeApp();
    registerWorkInventoryRoutes(app);
    const res = fakeResponse();
    handlers.get('GET /api/work-inventory-vocabulary')!(
      fakeRequest({ remoteAddress: '127.0.0.1' }),
      res
    );
    const body = res.body as { ok: boolean; locale: string; texts: Record<string, string> };
    expect(body.ok).toBe(true);
    for (const key of WORK_INVENTORY_VOCABULARY_KEYS) {
      expect(body.texts[key]).toBeTruthy();
    }
  });
});

describe('static/progress.html + progress.js render the work-inventory panel keys', () => {
  it('fetches the panel data + vocabulary endpoints and renders every panel vocabulary key', () => {
    const progressHtml = readRepoFile('presence/displays/presence-studio/static/progress.html');
    const progressJs = readRepoFile('presence/displays/presence-studio/static/progress.js');

    expect(progressHtml).toContain('id="work-inventory-panel"');
    expect(progressJs).toContain("fetchJson('/api/front-desk/work-inventory')");
    expect(progressJs).toContain("'/api/work-inventory-vocabulary?locale='");

    // `progress_work_inventory_status_*` is built dynamically
    // (`'progress_work_inventory_status_' + key`) rather than referenced as
    // five literal strings — assert the shared prefix instead of each
    // concrete key for those five.
    for (const key of WORK_INVENTORY_VOCABULARY_KEYS) {
      const bareKey = key.replace(/^front_desk:/, '');
      if (bareKey.startsWith('progress_work_inventory_status_')) {
        expect(progressJs).toContain('progress_work_inventory_status_');
        continue;
      }
      expect(progressJs).toContain(bareKey);
    }
  });

  it('never uses target="_blank", emoji, 127.0.0.1, or internal vocabulary — same contract as the rest of the page', () => {
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
