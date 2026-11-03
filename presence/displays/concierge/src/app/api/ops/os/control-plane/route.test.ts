import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  guardOpsRequest: vi.fn((): unknown => null),
  requireOpsAccess: vi.fn((): unknown => null),
  resolveOpsViewerForRequest: vi.fn(),
  defaultTierAccess: vi.fn(() => ['public', 'confidential']),
  resolveViewerTierAccess: vi.fn(
    (_role: string, requested?: string[]) => requested || ['public', 'confidential']
  ),
  withViewerExecutionContext: vi.fn((_viewer: unknown, operation: () => unknown) => operation()),
  snapshot: vi.fn(),
}));

vi.mock('@agent/core/cloudflare-os-surface', () => ({
  CloudflareOsReadOnlySurface: class {
    snapshot = mocks.snapshot;
  },
}));

vi.mock('../../../../../lib/ops/ops-request-guard', () => ({
  guardOpsRequest: mocks.guardOpsRequest,
  requireOpsAccess: mocks.requireOpsAccess,
}));

vi.mock('../../../../../lib/ops/ops-viewer', () => ({
  resolveOpsViewerForRequest: mocks.resolveOpsViewerForRequest,
  defaultTierAccess: mocks.defaultTierAccess,
  resolveViewerTierAccess: mocks.resolveViewerTierAccess,
  viewerErrorResponse: (error: unknown) =>
    Response.json(
      { ok: false, error: error instanceof Error ? error.message : 'Forbidden' },
      { status: 403 }
    ),
  withViewerExecutionContext: mocks.withViewerExecutionContext,
}));

import { GET } from './route';

describe('Chronos OS control-plane route', () => {
  beforeEach(() => {
    mocks.guardOpsRequest.mockReset();
    mocks.requireOpsAccess.mockReset();
    mocks.resolveOpsViewerForRequest.mockReset();
    mocks.defaultTierAccess.mockReset();
    mocks.resolveViewerTierAccess.mockReset();
    mocks.withViewerExecutionContext.mockReset();
    mocks.snapshot.mockReset();
    mocks.guardOpsRequest.mockReturnValue(null);
    mocks.requireOpsAccess.mockReturnValue(null);
    mocks.resolveOpsViewerForRequest.mockReturnValue({
      context: {
        role: 'readonly',
        source: 'token',
        principalId: 'chronos-tenant-a',
        tenantSlugs: ['tenant-a'],
      },
    });
    mocks.defaultTierAccess.mockReturnValue(['public', 'confidential']);
    mocks.resolveViewerTierAccess.mockImplementation(
      (_role: string, requested?: string[]) => requested || ['public', 'confidential']
    );
    mocks.withViewerExecutionContext.mockImplementation(
      (_viewer: unknown, operation: () => unknown) => operation()
    );
    mocks.snapshot.mockReturnValue({
      missionId: 'mission-1',
      heldActions: [],
      observations: [],
    });
  });

  it('passes server-derived human identity and tenant scope to the shared surface', () => {
    const response = GET(
      new Request('http://localhost/api/os/control-plane?mission_id=mission-1') as any
    );

    return Promise.resolve(response).then(async (result) => {
      expect(result.status).toBe(200);
      expect(mocks.snapshot).toHaveBeenCalledWith('mission-1', {
        principalId: 'human:chronos:chronos-tenant-a',
        tenantSlugs: ['tenant-a'],
        tierAccess: ['public', 'confidential'],
      });
      expect(result.headers.get('cache-control')).toBe('private, no-store');
      expect(await result.json()).toMatchObject({ ok: true, missionId: 'mission-1' });
    });
  });

  it('rejects a readonly viewer without an explicit tenant scope', async () => {
    mocks.resolveOpsViewerForRequest.mockReturnValue({
      context: {
        role: 'readonly',
        source: 'token',
        principalId: 'legacy-api-token',
        tenantSlugs: 'all',
      },
    });

    const response = await GET(new Request('http://localhost/api/os/control-plane') as any);

    expect(response.status).toBe(403);
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });

  it('does not let a denied viewer reach the shared surface', async () => {
    mocks.resolveOpsViewerForRequest.mockReturnValue({
      response: Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 }),
    });

    const response = await GET(new Request('http://localhost/api/os/control-plane') as any);

    expect(response.status).toBe(401);
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });
});
