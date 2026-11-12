import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const f = vi.hoisted(() => ({
  viewer: { role: 'localadmin', tenantSlugs: 'all' as string[] | 'all', source: 'loopback' },
  installationOwner: false,
}));

vi.mock('../../../../lib/ops/ops-request-guard', () => ({
  guardOpsRequest: vi.fn((): unknown => null),
  requireOpsAccess: vi.fn((): unknown => null),
}));
vi.mock('../../../../lib/ops/ops-viewer', () => ({
  resolveOpsViewerForRequest: vi.fn(() => ({ context: f.viewer })),
  withViewerExecutionContext: vi.fn((_viewer: unknown, run: () => unknown) => run()),
}));
vi.mock('../../../../lib/ops/pipeline-catalog', () => ({ listPipelineCatalog: () => [] }));
vi.mock('../../../../lib/installation-access', () => ({
  resolveConciergeInstallationAccess: vi.fn(() => ({ allowed: f.installationOwner })),
}));

import { GET } from './route';

const canRun = async () => (await (await GET({} as NextRequest)).json()).canRun;

beforeEach(() => {
  f.viewer = { role: 'localadmin', tenantSlugs: 'all', source: 'loopback' };
  f.installationOwner = false;
});

describe('GET /api/ops/pipelines canRun', () => {
  it('tells the page whether the run route would accept this viewer', async () => {
    expect(await canRun()).toBe(true);

    f.viewer = { role: 'localadmin', tenantSlugs: ['alpha-team'], source: 'token' };
    expect(await canRun()).toBe(false);
    f.installationOwner = true;
    expect(await canRun()).toBe(true);

    f.viewer = { role: 'readonly', tenantSlugs: 'all', source: 'token' };
    expect(await canRun()).toBe(false);
  });
});
