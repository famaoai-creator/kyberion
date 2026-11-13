import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { ScheduledPipeline } from '@agent/core/pipeline/pipeline-scheduler';

const f = vi.hoisted(() => ({
  viewer: { role: 'localadmin', tenantSlugs: 'all' as string[] | 'all', source: 'loopback' },
  installationOwner: false,
  schedules: [] as unknown[],
  register: vi.fn(),
  unregister: vi.fn(),
  dispatch: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('../../../../lib/ops/ops-request-guard', () => ({
  guardOpsRequest: vi.fn((): unknown => null),
  requireOpsAccess: vi.fn((): unknown => null),
}));
vi.mock('../../../../lib/ops/ops-viewer', () => ({
  resolveOpsViewerForRequest: vi.fn(() => ({ context: f.viewer })),
  strictViewerScopeTenantSlugs: vi.fn(() => f.viewer.tenantSlugs),
  withViewerExecutionContext: vi.fn((_viewer: unknown, run: () => unknown) => run()),
  viewerErrorResponse: vi.fn((error: unknown, status = 500) =>
    Response.json({ error: error instanceof Error ? error.message : String(error) }, { status })
  ),
}));
vi.mock('../../../../lib/ops/ops-audit', () => ({ auditOpsMutation: f.audit }));
vi.mock('../../../../lib/installation-access', () => ({
  resolveConciergeInstallationAccess: vi.fn(() => ({ allowed: f.installationOwner })),
}));
// The registry store and the detached child are replaced; validation stays real.
vi.mock('@agent/core/pipeline/pipeline-scheduler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/pipeline/pipeline-scheduler')>()),
  listScheduledPipelines: () => f.schedules,
  listOperatorExcludedSchedules: () => [],
  registerScheduledPipeline: f.register,
  unregisterScheduledPipeline: f.unregister,
}));
vi.mock('../../../../lib/ops/pipeline-run', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/ops/pipeline-run')>();
  return {
    ...actual,
    dispatchPipelineRun: (input: Parameters<typeof actual.dispatchPipelineRun>[0]) => {
      // The real guard runs first, exactly as in dispatchPipelineRun.
      if (input.context) actual.assertClientPipelineContext(input.context);
      return f.dispatch(input);
    },
  };
});

import { POST as register } from './route';
import { DELETE as remove, PATCH as update } from './[id]/route';
import { POST as runNow } from './[id]/run/route';

const PIPELINE = 'pipelines/vital-check.json';
const request = (body: unknown) => ({ json: async () => body }) as unknown as NextRequest;
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const schedule = (overrides: Partial<ScheduledPipeline> = {}): ScheduledPipeline => ({
  id: 'nightly',
  name: 'Nightly',
  pipelinePath: PIPELINE,
  actuator: 'run_pipeline',
  trigger: { type: 'cron', cron: '0 3 * * *' },
  enabled: true,
  ...overrides,
});
const registration = (context?: Record<string, unknown>) => ({
  id: 'nightly',
  name: 'Nightly',
  pipelinePath: PIPELINE,
  actuator: 'run_pipeline',
  trigger: { type: 'cron', cron: '0 3 * * *' },
  ...(context ? { context } : {}),
});
const confined = () => {
  f.viewer = { role: 'localadmin', tenantSlugs: ['alpha-team'], source: 'token' };
};

beforeEach(() => {
  f.viewer = { role: 'localadmin', tenantSlugs: 'all', source: 'loopback' };
  f.installationOwner = false;
  f.schedules = [];
  f.register.mockReset();
  f.unregister.mockReset();
  f.dispatch.mockReset();
  f.dispatch.mockImplementation((input: { pipelinePath: string }) => ({
    resourceId: 'run-1',
    pipelinePath: input.pipelinePath,
  }));
  f.audit.mockReset();
});

describe('schedule registration', () => {
  it('registers a catalog schedule with parameters for an all-tenant localadmin', async () => {
    const response = await register(request(registration({ topic: 'weekly', mission_id: 'M1' })));
    expect(response.status).toBe(200);
    expect(f.register).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'nightly', context: { topic: 'weekly', mission_id: 'M1' } })
    );
  });

  it('registers for the installation owner on a tenant-bound server', async () => {
    confined();
    f.installationOwner = true;
    expect((await register(request(registration()))).status).toBe(200);
    expect(f.register).toHaveBeenCalledTimes(1);
  });

  it('refuses a tenant-confined localadmin (403), whatever id it picks', async () => {
    confined();
    const response = await register(
      request({ ...registration(), id: 'tenant-alpha-team-nightly' })
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ ok: false });
    expect(f.register).not.toHaveBeenCalled();
    expect(f.audit).toHaveBeenCalledWith(
      f.viewer,
      'concierge.schedule.register',
      'failed',
      expect.objectContaining({ refused: 'tenant_confined_viewer' })
    );
  });

  it.each(['_knowledge_scope', 'mission_tier', 'mission_dir', '__pipeline_options'])(
    'refuses a context that sets the runner-derived key %s (400)',
    async (key) => {
      const response = await register(request(registration({ topic: 'x', [key]: 'v' })));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        ok: false,
        error: `context must not set runner-derived keys: ${key}`,
      });
      expect(f.register).not.toHaveBeenCalled();
    }
  );
});

describe('schedule update', () => {
  it('refuses a tenant-confined localadmin changing a catalog schedule (403)', async () => {
    confined();
    f.schedules = [schedule()];
    const response = await update(request({ enabled: false }), params('nightly'));
    expect(response.status).toBe(403);
    expect(f.register).not.toHaveBeenCalled();
  });

  it('refuses a tenant-confined localadmin pointing its tenant schedule at a catalog pipeline', async () => {
    confined();
    f.schedules = [
      schedule({
        id: 'tenant-alpha-team-digest',
        pipelinePath: 'knowledge/confidential/alpha-team/pipelines/digest.json',
      }),
    ];
    const response = await update(
      request({ pipelinePath: PIPELINE }),
      params('tenant-alpha-team-digest')
    );
    expect(response.status).toBe(403);
    expect(f.register).not.toHaveBeenCalled();
  });

  it('still lets a tenant-confined localadmin toggle its own tenant-floor schedule', async () => {
    confined();
    f.schedules = [
      schedule({
        id: 'tenant-alpha-team-digest',
        pipelinePath: 'knowledge/confidential/alpha-team/pipelines/digest.json',
      }),
    ];
    const response = await update(request({ enabled: false }), params('tenant-alpha-team-digest'));
    expect(response.status).toBe(200);
    expect(f.register).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('refuses a runner-derived context key on update (400) and admits parameters', async () => {
    f.schedules = [schedule()];
    const refused = await update(request({ context: { mission_dir: 'x' } }), params('nightly'));
    expect(refused.status).toBe(400);
    expect(f.register).not.toHaveBeenCalled();
    const admitted = await update(request({ context: { topic: 'weekly' } }), params('nightly'));
    expect(admitted.status).toBe(200);
  });
});

describe('schedule removal', () => {
  const tenantFloor = () =>
    schedule({
      id: 'tenant-alpha-team-digest',
      pipelinePath: 'knowledge/confidential/alpha-team/pipelines/digest.json',
    });

  it('refuses a tenant-confined localadmin removing a catalog schedule (403)', async () => {
    confined();
    f.schedules = [schedule(), schedule({ id: 'tenant-alpha-team-nightly' })];
    for (const id of ['nightly', 'tenant-alpha-team-nightly']) {
      const response = await remove(request({}), params(id));
      expect(response.status).toBe(403);
    }
    expect(f.unregister).not.toHaveBeenCalled();
    expect(f.audit).toHaveBeenCalledWith(
      f.viewer,
      'concierge.schedule.unregister',
      'failed',
      expect.objectContaining({ schedule_id: 'nightly', refused: 'tenant_confined_viewer' })
    );
  });

  it('still lets a tenant-confined localadmin remove its own tenant-floor schedule', async () => {
    confined();
    f.schedules = [tenantFloor()];
    const response = await remove(request({}), params('tenant-alpha-team-digest'));
    expect(response.status).toBe(200);
    expect(f.unregister).toHaveBeenCalledWith('tenant-alpha-team-digest');
  });

  it('removes a catalog schedule for an all-tenant localadmin and for the installation owner', async () => {
    f.schedules = [schedule()];
    expect((await remove(request({}), params('nightly'))).status).toBe(200);
    confined();
    f.installationOwner = true;
    expect((await remove(request({}), params('nightly'))).status).toBe(200);
    expect(f.unregister).toHaveBeenCalledTimes(2);
  });

  it('answers 404 for a schedule outside the viewer tenant scope', async () => {
    confined();
    f.schedules = [
      schedule({
        id: 'tenant-beta-team-digest',
        pipelinePath: 'knowledge/confidential/beta-team/pipelines/digest.json',
      }),
    ];
    expect((await remove(request({}), params('tenant-beta-team-digest'))).status).toBe(404);
    expect(f.unregister).not.toHaveBeenCalled();
  });
});

describe('schedule run-now', () => {
  it('runs a catalog schedule with its stored parameters for an all-tenant localadmin', async () => {
    f.schedules = [schedule({ context: { topic: 'weekly' } })];
    const response = await runNow(request({}), params('nightly'));
    expect(response.status).toBe(200);
    expect(f.dispatch).toHaveBeenCalledWith({
      pipelinePath: PIPELINE,
      context: { topic: 'weekly' },
      label: 'schedule:nightly',
    });
  });

  it('runs for the installation owner on a tenant-bound server', async () => {
    confined();
    f.installationOwner = true;
    f.schedules = [schedule()];
    expect((await runNow(request({}), params('nightly'))).status).toBe(200);
  });

  it('refuses a tenant-confined localadmin running a catalog schedule (403)', async () => {
    confined();
    f.schedules = [schedule(), schedule({ id: 'tenant-alpha-team-nightly' })];
    for (const id of ['nightly', 'tenant-alpha-team-nightly']) {
      const response = await runNow(request({}), params(id));
      expect(response.status).toBe(403);
    }
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it('refuses a stored context that sets runner-derived keys, even for an all-tenant localadmin (400)', async () => {
    f.schedules = [schedule({ context: { _knowledge_scope: { tiers: ['confidential'] } } })];
    const response = await runNow(request({}), params('nightly'));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'pipeline context must not set runner-derived keys: _knowledge_scope',
    });
    expect(f.dispatch).not.toHaveBeenCalled();
  });
});
