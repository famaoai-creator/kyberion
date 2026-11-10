import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

// Hermetic: a temporary KYBERION_ROOT (governance and schemas copied in)
// under SYSTEM_ROLE=concierge, so the role assumption (role-assumption-policy)
// and the path authority for the task-session, deliverable-inbox,
// artifact-record and mission-state stores are the real ones — a route moved
// between processes re-checks both. Only the viewer is stubbed; the tenant
// selection (URL hint, cookie, tenant registry) and the narrowing are real.
const viewer = vi.hoisted(() => ({ value: undefined as unknown }));

vi.mock('../../../lib/viewer-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/viewer-context')>()),
  resolveConciergeViewer: () => viewer.value,
}));

const sourceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../../..'
);
const root = path.join(sourceRoot, 'active/shared/tmp', `vitest-progress-${randomUUID()}`);
const NON_ASCII_ID = 'TS-依頼-日本語';

let list: typeof import('./route');
let detail: typeof import('./[id]/route');
let io: typeof import('@agent/core');

function scopedViewer(
  tenantSlugs: string[] | 'all',
  source: 'loopback' | 'token' = 'token',
  scope: { organizationIds?: string[] | 'all'; projectIds?: string[] | 'all' } = {}
) {
  return {
    context: {
      role: source === 'loopback' ? 'localadmin' : 'readonly',
      tenantSlugs,
      organizationIds: scope.organizationIds ?? 'all',
      projectIds: scope.projectIds ?? 'all',
      tierAccess: ['confidential', 'public'],
      source,
      principalId: 'human:progress-test',
    },
  };
}

function request(query = '', cookie?: string): NextRequest {
  return {
    method: 'GET',
    headers: new Headers({
      'accept-language': 'en',
      ...(cookie ? { cookie: `kyberion_selected_tenant=${cookie}` } : {}),
    }),
    nextUrl: new URL(`http://127.0.0.1/api/progress${query}`),
  } as unknown as NextRequest;
}

async function readList(query = '', cookie?: string) {
  const response = list.GET(request(query, cookie));
  return { status: response.status, body: await response.json() };
}

async function readDetail(id: string, query = '') {
  const response = await detail.GET(request(query), { params: Promise.resolve({ id }) });
  return { status: response.status, body: await response.json() };
}

const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id).sort();
const deliveryPath = (tier: string, tenant: string, file: string) =>
  `active/shared/artifacts/${tier}/${tenant}/report/${file}`;

beforeAll(async () => {
  const bootstrap = await import('@agent/core');
  const copy = (from: string, to: string): void => {
    bootstrap.safeMkdir(path.dirname(to), { recursive: true });
    if (bootstrap.safeLstat(from).isDirectory()) {
      bootstrap.safeMkdir(to, { recursive: true });
      for (const name of bootstrap.safeReaddir(from))
        copy(path.join(from, name), path.join(to, name));
    } else bootstrap.safeCopyFileSync(from, to);
  };
  bootstrap.safeMkdir(root, { recursive: true });
  for (const name of ['schemas', 'governance', 'orchestration']) {
    copy(
      path.join(sourceRoot, 'knowledge/product', name),
      path.join(root, 'knowledge/product', name)
    );
  }
  copy(
    path.join(sourceRoot, 'knowledge/public/common/project_standards.json'),
    path.join(root, 'knowledge/public/common/project_standards.json')
  );
  // The tenant registry the header selection is checked against.
  for (const tenant of ['alpha', 'beta']) {
    bootstrap.safeMkdir(path.join(root, 'knowledge/personal/tenants'), { recursive: true });
    bootstrap.safeWriteFile(
      path.join(root, `knowledge/personal/tenants/${tenant}.json`),
      JSON.stringify({ tenant_slug: tenant })
    );
  }
  bootstrap.safeWriteFile(path.join(root, 'package.json'), '{}');
  vi.stubEnv('KYBERION_ROOT', root);
  vi.stubEnv('SYSTEM_ROLE', 'concierge');
  vi.stubEnv('KYBERION_BASE_ROLE', 'worker');
  vi.resetModules();
  io = await import('@agent/core');
  const authority = await import('@agent/core/authority');
  const sessions = await import('@agent/core/task/task-session');
  const inbox = await import('@agent/core/deliverable-inbox');
  const artifacts = await import('@agent/core/workforce/artifact-record');

  // Fixture writes run under a role the Concierge process may assume.
  authority.withExecutionContext('mission_controller', () => {
    // A personal-tier mission: its artifacts are personal whatever their path says.
    const missionDir = io.pathResolver.missionDir('MSN-PERSONAL-1', 'personal');
    io.safeMkdir(missionDir, { recursive: true });
    io.safeWriteFile(
      path.join(missionDir, 'mission-state.json'),
      JSON.stringify({
        mission_id: 'MSN-PERSONAL-1',
        tier: 'personal',
        status: 'active',
        execution_mode: 'local',
        priority: 3,
        org_role: 'worker',
        confidence_score: 1,
        tenant_slug: 'alpha',
        git: { branch: 'main', start_commit: 'x', latest_commit: 'x', checkpoints: [] },
        history: [],
      })
    );

    const session = (
      id: string,
      projectContext: Record<string, string> | undefined,
      status: 'executing' | 'planning' = 'executing'
    ) =>
      sessions.saveTaskSession({
        ...sessions.createTaskSession({
          sessionId: id,
          correlationId: `req-${id}`,
          surface: 'presence',
          taskType: 'report_document',
          status,
          goal: { summary: `Request ${id}`, success_condition: 'A short report' },
          ...(projectContext ? { projectContext } : {}),
        }),
        history: [{ ts: '2026-11-07T09:00:00.000Z', type: 'execution', text: `Working on ${id}` }],
      });
    session('TS-ALPHA', { tenant_slug: 'alpha' });
    session('TS-BETA', { tenant_slug: 'beta' });
    session('TS-NOTENANT', undefined, 'planning');
    session('TS-PERSONAL', { tenant_slug: 'alpha', tier: 'personal' });
    session('TS-BOTH', { tenant_slug: 'alpha' });
    session(NON_ASCII_ID, { tenant_slug: 'alpha' });

    inbox.addInboxEntry({
      entryId: 'INBOX-ALPHA',
      missionId: 'MSN-ALPHA',
      title: 'Alpha report',
      artifactPaths: [deliveryPath('confidential', 'alpha', 'alpha.txt')],
      tenantSlug: 'alpha',
    });
    inbox.addInboxEntry({
      entryId: 'INBOX-DONE',
      title: 'Accepted report',
      artifactPaths: [deliveryPath('confidential', 'alpha', '2026-09-30.json')],
      tenantSlug: 'alpha',
      status: 'accepted',
    });
    inbox.addInboxEntry({
      entryId: 'INBOX-BETA',
      title: 'Beta report',
      artifactPaths: [deliveryPath('confidential', 'alpha', 'alpha-shared.txt')],
      tenantSlug: 'beta',
    });
    const artifact = (
      artifactId: string,
      tenant: string,
      artifactPath: string,
      extra: Record<string, unknown> = {}
    ) =>
      artifacts.saveArtifactRecord({
        artifact_id: artifactId,
        kind: 'txt',
        storage_class: 'tmp',
        tenant_slug: tenant,
        mission_id: `MSN-${tenant.toUpperCase()}`,
        path: artifactPath,
        ...extra,
      });
    artifact('ART-ALPHA', 'alpha', deliveryPath('confidential', 'alpha', 'alpha.txt'));
    artifact('ART-BETA', 'beta', deliveryPath('confidential', 'beta', 'beta.txt'));
    // Shares a path with beta's entry: the beta status must never leak.
    artifact(
      'ART-ALPHA-SHARED',
      'alpha',
      deliveryPath('confidential', 'alpha', 'alpha-shared.txt')
    );
    // Out of scope, but records an in-scope task session.
    artifact('ART-BETA-LINKED', 'beta', deliveryPath('confidential', 'beta', 'linked.txt'), {
      task_session_id: 'TS-ALPHA',
    });
    // Canonical organization / project scope.
    artifact('ART-ORG', 'alpha', deliveryPath('confidential', 'alpha', '2026-10-24.json'), {
      kind: 'report',
      organization_id: 'org-a',
      project_id: 'project-a',
    });
    // Accepted in the inbox: a finished delivery.
    artifact('ART-DONE', 'alpha', deliveryPath('confidential', 'alpha', '2026-09-30.json'), {
      kind: 'report',
    });
    // Names a task session's id too.
    artifact('TS-BOTH', 'alpha', deliveryPath('confidential', 'alpha', 'both.txt'));
    // Personal by path, by mission and by metadata; and a tier nothing states.
    artifact('ART-PERSONAL-PATH', 'alpha', deliveryPath('personal', 'alpha', 'mine.txt'));
    artifact('ART-PERSONAL-MISSION', 'alpha', deliveryPath('confidential', 'alpha', 'm.txt'), {
      mission_id: 'MSN-PERSONAL-1',
    });
    artifact('ART-PERSONAL-META', 'alpha', deliveryPath('confidential', 'alpha', 'meta.txt'), {
      metadata: { tier: 'personal' },
    });
    artifact('ART-UNKNOWN-TIER', 'alpha', 'active/shared/tmp/progress-fixture/unknown.txt');
  });
  list = await import('./route');
  detail = await import('./[id]/route');
}, 120_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  const bootstrap = await import('@agent/core');
  bootstrap.safeRmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  viewer.value = scopedViewer(['alpha']);
});

const ALPHA_ACTIVE = [NON_ASCII_ID, 'TS-ALPHA', 'TS-BOTH'].sort();
const ALPHA_DELIVERED = ['ART-ALPHA', 'ART-ALPHA-SHARED', 'ART-ORG', 'TS-BOTH'];
const HIDDEN_TIERS = [
  'ART-PERSONAL-PATH',
  'ART-PERSONAL-MISSION',
  'ART-PERSONAL-META',
  'ART-UNKNOWN-TIER',
];

describe('concierge /api/progress (仕事 › 依頼)', () => {
  it('runs inside the temporary root, not the checkout', () => {
    expect(io.pathResolver.rootDir()).toBe(root);
  });

  it("lists only the viewer's tenant: another tenant's request or delivery never appears", async () => {
    const { status, body } = await readList();
    expect(status).toBe(200);
    expect(ids(body.active)).toEqual(ALPHA_ACTIVE);
    expect(ids(body.delivered)).toEqual(ALPHA_DELIVERED);
    expect(JSON.stringify(body)).not.toMatch(/BETA|NOTENANT|TS-PERSONAL|ART-PERSONAL|UNKNOWN/);
    const active = body.active.find((row: { id: string }) => row.id === 'TS-ALPHA');
    expect(active).toMatchObject({
      correlation_id: 'req-TS-ALPHA',
      task_state: 'executing',
      latest_update: { text: 'Working on TS-ALPHA' },
      percent: 65,
      progress_basis: 'phase_estimate',
    });
    const delivered = Object.fromEntries(
      body.delivered.map((row: { id: string }) => [row.id, row])
    );
    expect(delivered['ART-ALPHA']).toMatchObject({
      status: 'unread',
      can_verdict: true,
      entry_id: 'INBOX-ALPHA',
      downloadable: true,
    });
    // The matching inbox entry belongs to beta: no status, no decision, no files.
    expect(delivered['ART-ALPHA-SHARED']).toMatchObject({
      status: 'delivered',
      can_verdict: false,
      downloadable: false,
    });
    expect(delivered['ART-ALPHA-SHARED']).not.toHaveProperty('entry_id');
    // Title provenance and the real kind, for a readable title on the page.
    expect(delivered['ART-ORG']).toMatchObject({
      title: '2026-10-24.json',
      artifact_kind: 'report',
      title_from_file: true,
    });
    // A finished delivery carries its real kind too (the row kind is 'artifact').
    expect(body.done.find((row: { id: string }) => row.id === 'ART-DONE')).toMatchObject({
      kind: 'artifact',
      status: 'accepted',
      artifact_kind: 'report',
      title_from_file: true,
    });
  });

  it.each(HIDDEN_TIERS)(
    'never lists or returns %s: a personal or unknown tier is denied',
    async (id) => {
      viewer.value = scopedViewer('all', 'loopback');
      expect(ids((await readList('?tenant=alpha')).body.delivered)).not.toContain(id);
      const { status, body } = await readDetail(id, '?tenant=alpha');
      expect(status).toBe(404);
      expect(body.error_code).toBe('progress_item_unavailable');
    }
  );

  it('follows the header selection: a company, the personal view and the system view', async () => {
    viewer.value = scopedViewer('all', 'loopback');
    expect(ids((await readList('', 'beta')).body.active)).toEqual(['TS-BETA']);
    expect(ids((await readList('?tenant=beta')).body.delivered)).toEqual([
      'ART-BETA',
      'ART-BETA-LINKED',
    ]);
    // Personal: every company the viewer may see.
    expect(ids((await readList('?tenant=personal')).body.active)).toEqual(
      [...ALPHA_ACTIVE, 'TS-BETA', 'TS-NOTENANT'].sort()
    );
    // System: only company-less records.
    expect(ids((await readList('?tenant=shared')).body.active)).toEqual(['TS-NOTENANT']);
    expect((await readList('?tenant=shared')).body.delivered).toEqual([]);
  });

  it('refuses a tenant outside the viewer scope without listing it', async () => {
    const refused = await readList('?tenant=beta');
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).not.toContain('TS-BETA');
    viewer.value = scopedViewer(['alpha'], 'token', { organizationIds: ['org-a'] });
    expect((await readList('?organizationId=org-b')).status).toBe(403);
  });

  it('lists and returns org / project scoped records with canonical metadata only', async () => {
    const narrowed = await readList('?organizationId=org-a&projectId=project-a');
    expect(narrowed.status).toBe(200);
    expect(narrowed.body.active).toEqual([]);
    expect(ids(narrowed.body.delivered)).toEqual(['ART-ORG']);
    const item = await readDetail('ART-ORG', '?organizationId=org-a&projectId=project-a');
    expect(item.status).toBe(200);
    expect(item.body.item).toMatchObject({ kind: 'artifact', artifact_kind: 'report' });
    expect((await readDetail('ART-ALPHA', '?organizationId=org-a')).status).toBe(404);
    viewer.value = scopedViewer(['alpha'], 'token', {
      organizationIds: ['org-a'],
      projectIds: ['project-a'],
    });
    expect(ids((await readList()).body.delivered)).toEqual(['ART-ORG']);
    expect((await readDetail('ART-ORG')).status).toBe(200);
  });

  it('returns detail and history for an in-scope request', async () => {
    const { status, body } = await readDetail('TS-ALPHA');
    expect(status).toBe(200);
    expect(body.item).toMatchObject({
      kind: 'task_session',
      task_state: 'executing',
      requested: 'Request TS-ALPHA — A short report',
      log: [{ when: '2026-11-07T09:00:00.000Z', text: 'Working on TS-ALPHA' }],
    });
    const artifact = await readDetail('ART-ALPHA');
    expect(artifact.body.item).toMatchObject({
      kind: 'artifact',
      status: 'unread',
      artifact_kind: 'txt',
    });
  });

  it('prefers the task session when an id names both a request and a delivery', async () => {
    const { status, body } = await readDetail('TS-BOTH');
    expect(status).toBe(200);
    expect(body.item).toMatchObject({ kind: 'task_session', requested: expect.any(String) });
    expect(body.item).not.toHaveProperty('artifact_kind');
  });

  it('matches only the exact decoded id: non-ASCII works, its encoded form does not', async () => {
    expect((await readDetail(NON_ASCII_ID)).status).toBe(200);
    expect((await readDetail(encodeURIComponent(NON_ASCII_ID))).status).toBe(404);
    // Neither store can hold an id with '/', so such an id is simply unknown.
    expect((await readDetail('TS-ALPHA/../TS-BETA')).status).toBe(404);
    expect((await readDetail('TS-ALPHA ')).status).toBe(404);
  });

  it.each([
    ["another tenant's request", 'TS-BETA'],
    ["another tenant's delivery", 'ART-BETA'],
    ['an out-of-scope delivery that records an in-scope task', 'ART-BETA-LINKED'],
    ['a company-less request', 'TS-NOTENANT'],
    ['a personal-tier request', 'TS-PERSONAL'],
    ['an unknown id', 'TS-NOPE'],
  ])('never returns %s by id — a readable, coded 404', async (_label, id) => {
    const { status, body } = await readDetail(id);
    expect(status).toBe(404);
    expect(body).toEqual({
      ok: false,
      error: expect.stringMatching(/unavailable/i),
      error_code: 'progress_item_unavailable',
    });
    expect(JSON.stringify(body)).not.toContain('Request ');
  });

  it('passes a refused viewer through unchanged', async () => {
    viewer.value = { response: new Response('{}', { status: 401 }) };
    expect(list.GET(request()).status).toBe(401);
    expect(
      (await detail.GET(request(), { params: Promise.resolve({ id: 'TS-ALPHA' }) })).status
    ).toBe(401);
  });
});
