import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  listWorkItems: vi.fn(),
  updateWorkItem: vi.fn(),
  buildWorkVisibilityProjection: vi.fn(),
  guardRequest: vi.fn(() => null),
  requireChronosAccess: vi.fn(() => null),
  resolveViewerContextForRequest: vi.fn(),
  viewerScopeTenantSlugs: vi.fn(),
  viewerErrorResponse: vi.fn(),
  withViewerExecutionContext: vi.fn((_viewer: unknown, fn: () => unknown) => fn()),
}));

vi.mock('@agent/core/work-coordination', () => ({
  listWorkItems: mocks.listWorkItems,
  updateWorkItem: mocks.updateWorkItem,
}));

vi.mock('@agent/core/work-visibility', () => ({
  buildWorkVisibilityProjection: mocks.buildWorkVisibilityProjection,
}));

vi.mock('../../../lib/api-guard', () => ({
  guardRequest: mocks.guardRequest,
  requireChronosAccess: mocks.requireChronosAccess,
}));

vi.mock('../../../lib/viewer-context', () => ({
  resolveViewerContextForRequest: mocks.resolveViewerContextForRequest,
  viewerScopeTenantSlugs: mocks.viewerScopeTenantSlugs,
  viewerErrorResponse: mocks.viewerErrorResponse,
  withViewerExecutionContext: mocks.withViewerExecutionContext,
}));

import { GET } from './route.js';

describe('workitems route', () => {
  beforeEach(() => {
    mocks.listWorkItems.mockReset();
    mocks.buildWorkVisibilityProjection.mockReset();
    mocks.guardRequest.mockReset();
    mocks.requireChronosAccess.mockReset();
    mocks.resolveViewerContextForRequest.mockReset();
    mocks.viewerScopeTenantSlugs.mockReset();
    mocks.viewerErrorResponse.mockReset();
    mocks.withViewerExecutionContext.mockReset();
    mocks.withViewerExecutionContext.mockImplementation((_viewer: unknown, fn: () => unknown) =>
      fn()
    );
    mocks.guardRequest.mockReturnValue(null);
    mocks.requireChronosAccess.mockReturnValue(null);
    mocks.resolveViewerContextForRequest.mockReturnValue({
      context: { role: 'localadmin', tenantSlugs: 'all', source: 'loopback' },
    });
    mocks.viewerScopeTenantSlugs.mockImplementation(
      (_viewer: unknown, tenant: string | undefined) => (tenant ? [tenant] : 'all')
    );
    mocks.listWorkItems.mockReturnValue([{ item_id: 'WI-1' }]);
    mocks.buildWorkVisibilityProjection.mockReturnValue({
      scope: 'operations',
      view: 'active',
      items: [{ item_id: 'WI-1', context: { project_id: 'PROJECT-A' } }],
      counts: { ready: 1 },
      quality: { explicit_context: 1, migrated_context: 0, missing_context: 0, warnings: [] },
      lineage: {
        hierarchy: ['tenant_slug', 'organization_id', 'project_id', 'mission_id', 'task_id'],
        nodes: [],
        edges: [],
        total_items: 1,
        complete_chain_items: 0,
        incomplete_chain_items: 1,
        missing_by_kind: {
          tenant_slug: 1,
          organization_id: 1,
          project_id: 0,
          mission_id: 1,
          task_id: 1,
        },
      },
    });
  });

  it('forwards the selected visualization scope to the shared projection', async () => {
    const response = await GET(
      new NextRequest(
        'http://localhost/api/workitems?scope=operations&view=active&project_id=PROJECT-A'
      )
    );

    expect(response.status).toBe(200);
    expect(mocks.buildWorkVisibilityProjection).toHaveBeenCalledWith({
      items: [{ item_id: 'WI-1' }],
      viewer: { tenantSlugs: 'all' },
      scope: 'operations',
      view: 'active',
      organizationId: undefined,
      missionId: undefined,
      projectId: 'PROJECT-A',
    });
    expect(await response.json()).toMatchObject({
      ok: true,
      scope: 'operations',
      view: 'active',
      items: [{ item_id: 'WI-1' }],
      lineage: {
        total_items: 1,
        incomplete_chain_items: 1,
      },
    });
  });
});
