import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

// Hermetic, like api/progress/route.test.ts: a temporary KYBERION_ROOT under
// SYSTEM_ROLE=concierge, so the role assumption and the path authority for
// the tenant work inventory and the member's own consent records are the real
// ones (moved from presence-studio `/api/front-desk/work-inventory`). Only the
// viewer and the member resolution are stubbed.
const viewer = vi.hoisted(() => ({ value: undefined as unknown }));
const member = vi.hoisted(() => ({ id: null as string | null }));
// The installation-owner decision has its own tests; here only its wiring.
const installation = vi.hoisted(() => ({ allowed: false }));
vi.mock('../../../../lib/installation-access', () => ({
  resolveConciergeInstallationAccess: () => ({ allowed: installation.allowed }),
}));

vi.mock('../../../../lib/viewer-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/viewer-context')>()),
  resolveConciergeViewer: () => viewer.value,
}));
vi.mock('../../../../lib/work-inventory-member', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/work-inventory-member')>()),
  resolveWorkInventoryMember: () => (member.id ? { member_id: member.id } : null),
}));

const sourceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../../../..'
);
const root = path.join(sourceRoot, 'active/shared/tmp', `vitest-wi-panel-${randomUUID()}`);
const STEP_SENTINEL = 'ZZ-WI-PANEL-STEP-SENTINEL';
const OBSERVATION_SENTINEL = 'ZZ-WI-PANEL-OBSERVATION-SENTINEL';
const MEMBER_ID = 'zz-wi-panel-member';

let route: typeof import('./route');

function scopedViewer(
  tenantSlugs: string[] | 'all',
  source: 'loopback' | 'token' = 'token',
  role: 'localadmin' | 'readonly' = source === 'loopback' ? 'localadmin' : 'readonly'
) {
  return {
    context: {
      role,
      tenantSlugs,
      organizationIds: 'all',
      projectIds: 'all',
      tierAccess: ['confidential', 'public'],
      source,
      principalId: 'human:wi-panel-test',
    },
  };
}

async function readPanel(query = '') {
  const response = route.GET({
    method: 'GET',
    headers: new Headers({ 'accept-language': 'en' }),
    nextUrl: new URL(`http://127.0.0.1/api/work-inventory/candidates${query}`),
  } as unknown as NextRequest);
  return { status: response.status, body: await response.json() };
}

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
  const io = await import('@agent/core');
  const authority = await import('@agent/core/authority');
  const inventory = await import('@agent/core/workforce/work-inventory');
  const consent = await import('@agent/core/workforce/work-inventory-consent');
  const observation = await import('@agent/core/workforce/work-inventory-observation');

  authority.withExecutionContext('ecosystem_architect', () => {
    const entry = (tenant: string | undefined, title: string, status: 'confirmed' | 'draft') => {
      const created = inventory.createWorkInventoryEntry(
        {
          title,
          scope: tenant ? { tenant_slug: tenant } : {},
          trigger: { kind: 'schedule', description: 'monthly' },
          frequency: { per: 'month', count: 4 },
          effort_minutes_per_run: 60,
          steps: [
            {
              step_id: 'S1',
              stage: 'act',
              verb: 'input',
              description: STEP_SENTINEL,
              data_sensitivity: 'internal',
              effects: [],
              method: { assigned: 'ai_reasoning', source: 'rule', rule_id: 'r1', rationale: 'x' },
            },
          ],
        },
        new Date('2026-09-01T00:00:00.000Z')
      );
      inventory.saveWorkInventoryEntry({ ...created, status });
    };
    entry('alpha', 'Alpha monthly report', 'confirmed');
    entry('beta', 'Beta invoice run', 'confirmed');
  });
  // The loopback owner's personal inventory: Concierge does not read the personal tier.
  authority.withExecutionContext('sovereign_concierge', () => {
    const created = inventory.createWorkInventoryEntry(
      {
        title: 'My personal chore',
        scope: {},
        trigger: { kind: 'schedule', description: 'weekly' },
        frequency: { per: 'week', count: 1 },
        effort_minutes_per_run: 30,
        steps: [],
      },
      new Date('2026-09-01T00:00:00.000Z')
    );
    inventory.saveWorkInventoryEntry({ ...created, status: 'confirmed' });
  });
  authority.withExecutionContext('sovereign_concierge', () => {
    consent.grantWorkInventoryConsent({
      member_id: MEMBER_ID,
      sources: ['desktop_recording'],
      observation_kinds: ['active_window'],
      purpose: 'work inventory panel test',
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      granted_by: { kind: 'human', id: MEMBER_ID },
    });
    const file = observation.observationSummaryPath(MEMBER_ID, 'WIO-20260901-aaaaaaaaaaaa');
    io.safeMkdir(path.dirname(file), { recursive: true });
    io.safeWriteFile(
      file,
      `${JSON.stringify({
        schema_version: 'work-inventory-observation-summary.v1',
        summary_id: 'WIO-20260901-aaaaaaaaaaaa',
        member_id: MEMBER_ID,
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
      })}\n`
    );
  });
  route = await import('./route');
}, 120_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  const bootstrap = await import('@agent/core');
  bootstrap.safeRmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  viewer.value = scopedViewer(['alpha']);
  member.id = null;
  installation.allowed = false;
});

describe('concierge /api/work-inventory/candidates (依頼 › 業務の自動化候補)', () => {
  it("lists only the selected company's candidates, summary level only", async () => {
    const { status, body } = await readPanel();
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, scoped: true, counts: { confirmed: 1, draft: 0 } });
    expect(body.candidates.map((row: { title: string }) => row.title)).toEqual([
      'Alpha monthly report',
    ]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('Beta invoice run');
    expect(serialized).not.toContain(STEP_SENTINEL);
    expect(body.start_href).toMatch(/\/ask\?mode=hearing&scenario=work_inventory$/);
    expect(body.operator_hint).toBe(false);
  });

  it('follows the header selection and never widens', async () => {
    viewer.value = scopedViewer('all', 'loopback');
    const beta = await readPanel('?tenant=beta');
    expect(beta.body.candidates.map((row: { title: string }) => row.title)).toEqual([
      'Beta invoice run',
    ]);
    expect(beta.body.operator_hint).toBe(true);
    viewer.value = scopedViewer(['alpha']);
    const refused = await readPanel('?tenant=beta');
    expect(JSON.stringify(refused.body)).not.toContain('Beta invoice run');
  });

  it('shows the local owner their own personal inventory in the personal view', async () => {
    viewer.value = scopedViewer('all', 'loopback');
    const { body } = await readPanel('?tenant=personal');
    expect(body).toMatchObject({ ok: true, scoped: true });
    expect(body.candidates.map((row: { title: string }) => row.title)).toEqual([
      'My personal chore',
    ]);
    expect(JSON.stringify(body)).not.toMatch(/Alpha monthly report|Beta invoice run/);
  });

  it('shows the signed-in installation owner their personal inventory in the personal view', async () => {
    // The normal case on a bound install: the owner's browser sends its session.
    viewer.value = scopedViewer('all', 'token', 'localadmin');
    installation.allowed = true;
    const { body } = await readPanel('?tenant=personal');
    expect(body).toMatchObject({ ok: true, scoped: true });
    expect(body.candidates.map((row: { title: string }) => row.title)).toEqual([
      'My personal chore',
    ]);
    const system = await readPanel('?tenant=shared');
    expect(JSON.stringify(system.body)).not.toContain('My personal chore');
  });

  it.each([
    ['a remote localadmin token', scopedViewer('all', 'token', 'localadmin'), '?tenant=personal'],
    [
      'a loopback readonly session',
      scopedViewer('all', 'loopback', 'readonly'),
      '?tenant=personal',
    ],
    ['the local owner in the system view', scopedViewer('all', 'loopback'), '?tenant=shared'],
  ])('never lists the personal inventory for %s', async (_label, who, query) => {
    viewer.value = who;
    const { body } = await readPanel(query);
    expect(body).toMatchObject({ ok: true, scoped: false, candidates: [] });
    expect(JSON.stringify(body)).not.toContain('My personal chore');
  });

  it("reports the viewer's own consent standing, never an observation digest", async () => {
    member.id = MEMBER_ID;
    const { body } = await readPanel();
    expect(body.consent).toMatchObject({ active: 1, pending_summaries: 1 });
    expect(typeof body.consent.expires_soonest).toBe('string');
    expect(JSON.stringify(body)).not.toContain(OBSERVATION_SENTINEL);
    member.id = null;
    expect((await readPanel()).body.consent).toBeUndefined();
  });

  it('passes a refused viewer through unchanged', () => {
    viewer.value = { response: new Response('{}', { status: 401 }) };
    expect(
      route.GET({
        headers: new Headers(),
        nextUrl: new URL('http://127.0.0.1/api/work-inventory/candidates'),
      } as unknown as NextRequest).status
    ).toBe(401);
  });
});
