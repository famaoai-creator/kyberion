import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const f = vi.hoisted(() => ({
  viewer: { role: 'localadmin', tenantSlugs: 'all' as string[] | 'all', source: 'loopback' },
  accessDenied: null as unknown,
  dispatch: vi.fn(),
  audit: vi.fn(),
  installationOwner: false,
}));

vi.mock('../../../../../lib/ops/ops-request-guard', () => ({
  guardOpsRequest: vi.fn((): unknown => null),
  requireOpsAccess: vi.fn((): unknown => f.accessDenied),
}));
vi.mock('../../../../../lib/ops/ops-viewer', () => ({
  resolveOpsViewerForRequest: vi.fn(() => ({ context: f.viewer })),
  withViewerExecutionContext: vi.fn((_viewer: unknown, run: () => unknown) => run()),
  viewerErrorResponse: vi.fn((error: unknown, status = 500) =>
    Response.json({ error: error instanceof Error ? error.message : String(error) }, { status })
  ),
}));
vi.mock('../../../../../lib/ops/ops-audit', () => ({ auditOpsMutation: f.audit }));
// The installation-owner decision has its own suite; here it is a fact.
vi.mock('../../../../../lib/installation-access', () => ({
  resolveConciergeInstallationAccess: vi.fn(() => ({ allowed: f.installationOwner })),
}));
// The detached child is never started here; the context guard stays real.
vi.mock('../../../../../lib/ops/pipeline-run', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../lib/ops/pipeline-run')>()),
  dispatchPipelineRun: f.dispatch,
}));

import { POST } from './route';

const PIPELINE = 'pipelines/vital-check.json';

function post(body: unknown): Promise<Response> {
  return POST({ json: async () => body } as unknown as NextRequest);
}

beforeEach(() => {
  f.viewer = { role: 'localadmin', tenantSlugs: 'all', source: 'loopback' };
  f.accessDenied = null;
  f.installationOwner = false;
  f.dispatch.mockReset();
  f.dispatch.mockImplementation((input: { pipelinePath: string }) => ({
    resourceId: 'concierge-pipeline-run-test',
    pipelinePath: input.pipelinePath,
  }));
  f.audit.mockReset();
});

describe('POST /api/ops/pipelines/run', () => {
  it('dispatches a catalog pipeline with its parameters for an all-tenant localadmin', async () => {
    const response = await post({
      pipelinePath: PIPELINE,
      context: { tenant_slug: 'alpha-team', mission_id: 'MSN-1', topic: 'weekly' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, run: { pipelinePath: PIPELINE } });
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(f.dispatch).toHaveBeenCalledWith({
      pipelinePath: PIPELINE,
      context: { tenant_slug: 'alpha-team', mission_id: 'MSN-1', topic: 'weekly' },
      label: 'concierge:catalog',
    });
  });

  it('dispatches for the installation owner on a tenant-bound server', async () => {
    f.viewer = { role: 'localadmin', tenantSlugs: ['alpha-team'], source: 'token' };
    f.installationOwner = true;
    const response = await post({ pipelinePath: PIPELINE });
    expect(response.status).toBe(200);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });

  it('refuses a tenant-confined localadmin with 403 before reading the body', async () => {
    f.viewer = { role: 'localadmin', tenantSlugs: ['alpha-team'], source: 'loopback' };
    const response = await post({ pipelinePath: PIPELINE });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: expect.stringContaining('a viewer confined to a tenant cannot use it'),
    });
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.audit).toHaveBeenCalledWith(
      f.viewer,
      'concierge.pipeline.run',
      'failed',
      expect.objectContaining({ refused: 'tenant_confined_viewer' })
    );
  });

  it('keeps refusing viewers below localadmin', async () => {
    f.accessDenied = Response.json({ error: 'forbidden' }, { status: 403 });
    const response = await post({ pipelinePath: PIPELINE });
    expect(response.status).toBe(403);
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ['_knowledge_scope', { tiers: ['public', 'confidential'], customerId: 'beta-team' }],
    ['mission_tier', 'confidential'],
    ['mission_dir', 'active/missions/confidential/beta-team/MSN-2'],
    ['mission_evidence_dir', 'active/missions/confidential/beta-team/MSN-2/evidence'],
    ['trust_resolved', true],
    ['project_trust_approval_id', 'approval-1'],
    ['repo_root', '/elsewhere'],
    ['__pipeline_options', { max_steps: 1 }],
    ['__anything_private', 1],
  ])('refuses a context that sets the runner-derived key %s', async (key, value) => {
    const response = await post({ pipelinePath: PIPELINE, context: { topic: 'x', [key]: value } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: `pipeline context must not set runner-derived keys: ${key}`,
    });
    expect(f.dispatch).not.toHaveBeenCalled();
  });
});
