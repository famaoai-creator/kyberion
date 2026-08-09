import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  guardRequest: vi.fn(() => null),
  requireChronosAccess: vi.fn(() => null),
  resolveViewerContextForRequest: vi.fn(),
  defaultTierAccess: vi.fn(() => ['public', 'confidential']),
  resolveViewerTierAccess: vi.fn(
    (_role: string, requested?: string[]) => requested || ['public', 'confidential']
  ),
  withViewerExecutionContext: vi.fn((_viewer: unknown, operation: () => unknown) => operation()),
  snapshot: vi.fn(),
}));

vi.mock('@agent/core', () => ({
  CloudflareOsReadOnlySurface: class {
    snapshot = mocks.snapshot;
  },
}));

vi.mock('../../../../lib/api-guard', () => ({
  guardRequest: mocks.guardRequest,
  requireChronosAccess: mocks.requireChronosAccess,
}));

vi.mock('../../../../lib/viewer-context', () => ({
  resolveViewerContextForRequest: mocks.resolveViewerContextForRequest,
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
    mocks.guardRequest.mockReset();
    mocks.requireChronosAccess.mockReset();
    mocks.resolveViewerContextForRequest.mockReset();
    mocks.defaultTierAccess.mockReset();
    mocks.resolveViewerTierAccess.mockReset();
    mocks.withViewerExecutionContext.mockReset();
    mocks.snapshot.mockReset();
    mocks.guardRequest.mockReturnValue(null);
    mocks.requireChronosAccess.mockReturnValue(null);
    mocks.resolveViewerContextForRequest.mockReturnValue({
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
    mocks.resolveViewerContextForRequest.mockReturnValue({
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
    mocks.resolveViewerContextForRequest.mockReturnValue({
      response: Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 }),
    });

    const response = await GET(new Request('http://localhost/api/os/control-plane') as any);

    expect(response.status).toBe(401);
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });
});
