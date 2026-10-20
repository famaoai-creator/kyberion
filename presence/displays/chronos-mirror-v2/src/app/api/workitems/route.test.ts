import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({
  listWorkItems: vi.fn(),
  getWorkItem: vi.fn(),
  requestAlignment: vi.fn(),
  readAlignment: vi.fn(),
  updateWorkItem: vi.fn(),
  buildWorkVisibilityProjection: vi.fn(),
  guardRequest: vi.fn(() => null),
  requireChronosAccess: vi.fn(() => null),
  resolveViewerContextForRequest: vi.fn(),
  strictViewerScopeTenantSlugs: vi.fn(),
  strictViewerScopeOrganizationIds: vi.fn(),
  strictViewerScopeProjectIds: vi.fn(),
  viewerScopeTenantSlugs: vi.fn(),
  viewerErrorResponse: vi.fn(),
  withViewerExecutionContext: vi.fn((_viewer: unknown, fn: () => unknown) => fn()),
}));

vi.mock('@agent/core/workforce/work-coordination', () => ({
  listWorkItems: mocks.listWorkItems,
  getWorkItem: mocks.getWorkItem,
  updateWorkItem: mocks.updateWorkItem,
}));

vi.mock('@agent/core/workforce/work-visibility', () => ({
  buildWorkVisibilityProjection: mocks.buildWorkVisibilityProjection,
}));

vi.mock('../../../lib/api-guard', () => ({
  guardRequest: mocks.guardRequest,
  requireChronosAccess: mocks.requireChronosAccess,
}));

vi.mock('./mission-alignment', () => ({
  requestWorkItemMissionAlignment: mocks.requestAlignment,
  readWorkItemMissionAlignment: mocks.readAlignment,
}));
vi.mock('../../../lib/viewer-context', () => ({
  ViewerContextError: class extends Error {},
  resolveViewerContextForRequest: mocks.resolveViewerContextForRequest,
  strictViewerScopeTenantSlugs: mocks.strictViewerScopeTenantSlugs,
  strictViewerScopeOrganizationIds: mocks.strictViewerScopeOrganizationIds,
  strictViewerScopeProjectIds: mocks.strictViewerScopeProjectIds,
  viewerScopeTenantSlugs: mocks.viewerScopeTenantSlugs,
  viewerErrorResponse: mocks.viewerErrorResponse,
  withViewerExecutionContext: mocks.withViewerExecutionContext,
}));

import { GET, POST } from './route.js';

describe('workitems route', () => {
  beforeEach(() => {
    mocks.listWorkItems.mockReset();
    mocks.buildWorkVisibilityProjection.mockReset();
    mocks.guardRequest.mockReset();
    mocks.requireChronosAccess.mockReset();
    mocks.resolveViewerContextForRequest.mockReset();
    mocks.strictViewerScopeTenantSlugs.mockReset();
    mocks.strictViewerScopeOrganizationIds.mockReset();
    mocks.strictViewerScopeProjectIds.mockReset();
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
    mocks.strictViewerScopeTenantSlugs.mockImplementation(
      (_viewer: unknown, tenant: string | undefined) => (tenant ? [tenant] : 'all')
    );
    mocks.strictViewerScopeOrganizationIds.mockImplementation(() => 'all');
    mocks.strictViewerScopeProjectIds.mockImplementation(() => 'all');
    mocks.listWorkItems.mockReturnValue([{ item_id: 'WI-1' }]);
    mocks.buildWorkVisibilityProjection.mockReturnValue({
      scope: 'operations',
      view: 'active',
      items: [{ item_id: 'WI-1', context: { project_id: 'PROJECT-A' } }],
      counts: { ready: 1 },
      quality: {
        explicit_context: 1,
        migrated_context: 0,
        missing_context: 0,
        warnings: [],
      },
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

  it('never forwards stored forged approval display metadata', async () => {
    mocks.buildWorkVisibilityProjection.mockReturnValue({
      items: [
        {
          item_id: 'WI-1',
          metadata: {
            mission_alignment_decision: { status: 'approved', requestId: 'forged' },
          },
        },
      ],
    });
    const body = await (await GET(new NextRequest('http://localhost/api/workitems'))).json();
    expect(body.items[0].metadata.mission_alignment_decision).toBeUndefined();
    expect(mocks.readAlignment).not.toHaveBeenCalled();
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
      viewer: { tenantSlugs: 'all', organizationIds: 'all', projectIds: 'all' },
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

const intake = () => ({
  item_id: 'WI-1',
  version: 3,
  title: 'Scoped intake',
  description: 'Goal',
  status: 'blocked',
  context: { tenant_slug: 'tenant-a', organization_id: 'org-a', project_id: 'project-a' },
  metadata: { requested_work_shape: 'mission', admission_only: true },
});
const post = (body: unknown = { itemId: 'WI-1', action: 'request_mission_alignment' }) =>
  POST(
    new NextRequest('http://localhost/api/workitems', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
describe('explicit mission alignment action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.guardRequest.mockReturnValue(null);
    mocks.requireChronosAccess.mockReturnValue(null);
    mocks.resolveViewerContextForRequest.mockReturnValue({
      context: { role: 'localadmin', tenantSlugs: ['tenant-a'] },
    });
    mocks.strictViewerScopeOrganizationIds.mockReturnValue(['org-a']);
    mocks.strictViewerScopeProjectIds.mockReturnValue(['project-a']);
    mocks.withViewerExecutionContext.mockImplementation((_viewer, fn) => fn());
    mocks.viewerErrorResponse.mockImplementation((error, status = 500) =>
      NextResponse.json({ ok: false, error: String(error) }, { status })
    );
    mocks.getWorkItem.mockReturnValue(intake());
    mocks.requestAlignment.mockImplementation(async (item) => ({
      item,
      admission: { requestId: 'exact-original', missionId: 'MSN-ONE', status: 'pending' },
    }));
  });
  it('uses current server scope and keeps the original work pending on repeated clicks', async () => {
    for (let n = 0; n < 2; n++) {
      const response = await post();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        item: { item_id: 'WI-1', status: 'blocked' },
        admission: { requestId: 'exact-original', status: 'pending' },
      });
    }
    expect(mocks.requestAlignment).toHaveBeenCalledWith(intake());
    expect(mocks.updateWorkItem).not.toHaveBeenCalled();
  });
  it.each(['tenant_slug', 'organization_id', 'project_id'])(
    'rejects changed or unrelated %s before invoking admission',
    async (axis) => {
      const current = intake();
      (current.context as Record<string, string>)[axis] = 'unrelated';
      mocks.getWorkItem.mockReturnValue(current);
      expect((await post()).status).toBe(403);
      expect(mocks.requestAlignment).not.toHaveBeenCalled();
    }
  );
  it.each(['done', 'cancelled', 'in_progress'])('does not prepare status %s', async (status) => {
    mocks.getWorkItem.mockReturnValue({ ...intake(), status });
    expect((await post()).status).toBe(409);
    expect(mocks.requestAlignment).not.toHaveBeenCalled();
  });
  it('rejects non-mission work', async () => {
    mocks.getWorkItem.mockReturnValue({
      ...intake(),
      metadata: { requested_work_shape: 'task' },
    });
    expect((await post()).status).toBe(409);
    expect(mocks.requestAlignment).not.toHaveBeenCalled();
  });
  it.each(['scope', 'status', 'role', 'version'])(
    'rejects client authority field %s',
    async (key) => {
      expect(
        (
          await post({
            itemId: 'WI-1',
            action: 'request_mission_alignment',
            [key]: 'forged',
          })
        ).status
      ).toBeGreaterThanOrEqual(400);
      expect(mocks.requestAlignment).not.toHaveBeenCalled();
    }
  );
  it.each(['expired', 'rejected'])('reports %s without completing work', async (status) => {
    mocks.requestAlignment.mockResolvedValue({
      item: intake(),
      admission: { requestId: 'exact-original', status },
    });
    expect(await (await post()).json()).toMatchObject({
      item: { status: 'blocked' },
      admission: { status },
    });
    expect(mocks.updateWorkItem).not.toHaveBeenCalled();
  });
  it('honors existing localadmin denial', async () => {
    mocks.requireChronosAccess.mockReturnValue(NextResponse.json({ ok: false }, { status: 403 }));
    expect((await post()).status).toBe(403);
    expect(mocks.requestAlignment).not.toHaveBeenCalled();
  });
});
