import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({
  listWorkItems: vi.fn(),
  getWorkItem: vi.fn(),
  requestAlignment: vi.fn(),
  readAlignment: vi.fn(),
  updateWorkItem: vi.fn(),
  buildWorkVisibilityProjection: vi.fn(),
  guardOpsRequest: vi.fn((): unknown => null),
  requireOpsAccess: vi.fn((): unknown => null),
  resolveOpsViewerForRequest: vi.fn(),
  strictViewerScopeTenantSlugs: vi.fn(),
  strictViewerScopeOrganizationIds: vi.fn(),
  strictViewerScopeProjectIds: vi.fn(),
  viewerScopeTenantSlugs: vi.fn(),
  viewerErrorResponse: vi.fn(),
  withViewerExecutionContext: vi.fn((_viewer: unknown, fn: () => unknown) => fn()),
  invalidateWorkspaceGraphCache: vi.fn(),
}));

vi.mock('@agent/core/surface/surface-operation-registry', () => ({
  invalidateWorkspaceGraphCache: mocks.invalidateWorkspaceGraphCache,
}));

vi.mock('@agent/core/workforce/work-coordination', () => ({
  listWorkItems: mocks.listWorkItems,
  getWorkItem: mocks.getWorkItem,
  updateWorkItem: mocks.updateWorkItem,
}));

vi.mock('@agent/core/workforce/work-visibility', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/workforce/work-visibility')>()),
  buildWorkVisibilityProjection: mocks.buildWorkVisibilityProjection,
}));

vi.mock('../../../../lib/ops/ops-request-guard', () => ({
  guardOpsRequest: mocks.guardOpsRequest,
  requireOpsAccess: mocks.requireOpsAccess,
}));

vi.mock('./mission-alignment', () => ({
  requestWorkItemMissionAlignment: mocks.requestAlignment,
  readWorkItemMissionAlignment: mocks.readAlignment,
}));
vi.mock('../../../../lib/ops/ops-viewer', () => ({
  ViewerContextError: class extends Error {},
  resolveOpsViewerForRequest: mocks.resolveOpsViewerForRequest,
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
    mocks.guardOpsRequest.mockReset();
    mocks.requireOpsAccess.mockReset();
    mocks.resolveOpsViewerForRequest.mockReset();
    mocks.strictViewerScopeTenantSlugs.mockReset();
    mocks.strictViewerScopeOrganizationIds.mockReset();
    mocks.strictViewerScopeProjectIds.mockReset();
    mocks.viewerScopeTenantSlugs.mockReset();
    mocks.viewerErrorResponse.mockReset();
    mocks.withViewerExecutionContext.mockReset();
    mocks.withViewerExecutionContext.mockImplementation((_viewer: unknown, fn: () => unknown) =>
      fn()
    );
    mocks.guardOpsRequest.mockReturnValue(null);
    mocks.requireOpsAccess.mockReturnValue(null);
    mocks.resolveOpsViewerForRequest.mockReturnValue({
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

  it('reads legitimate system selection without dropping source rows or exposing tenant/person work', async () => {
    const actual = await vi.importActual<typeof import('@agent/core/workforce/work-visibility')>(
      '@agent/core/workforce/work-visibility'
    );
    mocks.buildWorkVisibilityProjection.mockImplementation(actual.buildWorkVisibilityProjection);
    const row = {
      item_id: 'system',
      title: 'Platform maintenance',
      description: 'System work',
      status: 'ready',
      project_id: '',
      labels: [],
      dependencies: [],
      metadata: {},
      created_at: '2026-11-15',
      updated_at: '2026-11-15',
    };
    const context = {
      role: 'localadmin',
      tenantSlugs: [],
      organizationIds: [],
      projectIds: [],
      tierAccess: ['public', 'confidential'],
      includeUntenanted: true,
    };
    mocks.resolveOpsViewerForRequest.mockReturnValue({ context });
    mocks.strictViewerScopeTenantSlugs.mockReturnValue([]);
    mocks.strictViewerScopeOrganizationIds.mockReturnValue([]);
    mocks.strictViewerScopeProjectIds.mockReturnValue([]);
    mocks.listWorkItems.mockReturnValue([
      row,
      { ...row, item_id: 'tenant', context: { tenant_slug: 'company' } },
      {
        ...row,
        item_id: 'personal',
        metadata: { dot_scope: { tier: 'personal', owner_nhi: 'owner' } },
      },
      {
        ...row,
        item_id: 'public-person',
        metadata: { dot_scope: { tier: 'public', nhi_id: 'owner' } },
      },
      { ...row, item_id: 'unknown-dot', metadata: { dot_id: 'old' } },
      {
        ...row,
        item_id: 'public-dot',
        metadata: { dot_id: 'public', dot_scope: { tier: 'public' } },
      },
    ]);
    const response = await GET(new NextRequest('http://localhost/api/workitems'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items.map((entry: { item_id: string }) => entry.item_id)).toEqual([
      'system',
      'public-dot',
    ]);
    expect(body.counts.ready).toBe(2);
    expect(mocks.listWorkItems).toHaveBeenCalledWith({
      tenantSlugs: undefined,
      organizationIds: undefined,
      projectIds: undefined,
    });
  });

  it('filters personal rows and counts through the actual projection for public and foreign viewers', async () => {
    const actual = await vi.importActual<typeof import('@agent/core/workforce/work-visibility')>(
      '@agent/core/workforce/work-visibility'
    );
    mocks.buildWorkVisibilityProjection.mockImplementation(actual.buildWorkVisibilityProjection);
    const row = {
      item_id: 'private',
      title: 'private prose',
      description: 'secret',
      status: 'ready',
      project_id: '',
      labels: [],
      dependencies: [],
      metadata: { dot_scope: { tier: 'personal', owner_nhi: 'owner' } },
      created_at: '2026-11-15',
      updated_at: '2026-11-15',
    };
    mocks.listWorkItems.mockReturnValue([
      row,
      {
        ...row,
        item_id: 'legacy-private-dot',
        metadata: { dot_id: 'old-dot', action_ref: 'old-action' },
      },
      { ...row, item_id: 'ordinary', title: 'ordinary', metadata: {} },
    ]);
    for (const context of [
      {
        role: 'localadmin',
        tenantSlugs: 'all',
        tierAccess: ['public', 'confidential'],
        principalId: 'owner',
      },
      {
        role: 'localadmin',
        tenantSlugs: 'all',
        tierAccess: ['personal', 'public'],
        principalId: 'foreign',
      },
    ]) {
      mocks.resolveOpsViewerForRequest.mockReturnValue({ context });
      const response = await GET(new NextRequest('http://localhost/api/workitems'));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.items.map((entry: { item_id: string }) => entry.item_id)).toEqual(['ordinary']);
      expect(body.counts.ready).toBe(1);
      expect(JSON.stringify(body)).not.toContain('private prose');
      expect(body.lineage.total_items).toBe(1);
    }
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
      viewer: {
        role: 'localadmin',
        source: 'loopback',
        tenantSlugs: 'all',
        organizationIds: 'all',
        projectIds: 'all',
      },
      scope: 'operations',
      view: 'active',
      organizationId: undefined,
      missionId: undefined,
      projectId: 'PROJECT-A',
    });
    expect(await response.json()).toMatchObject({
      ok: true,
      accessRole: 'localadmin',
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
    mocks.guardOpsRequest.mockReturnValue(null);
    mocks.requireOpsAccess.mockReturnValue(null);
    mocks.resolveOpsViewerForRequest.mockReturnValue({
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
  it('allows legitimate localadmin system status updates using actual ownerless record scope', async () => {
    mocks.resolveOpsViewerForRequest.mockReturnValue({
      context: {
        role: 'localadmin',
        tenantSlugs: [],
        organizationIds: [],
        projectIds: [],
        includeUntenanted: true,
      },
    });
    mocks.strictViewerScopeOrganizationIds.mockReturnValue([]);
    mocks.strictViewerScopeProjectIds.mockReturnValue([]);
    const current = { ...intake(), context: {}, metadata: {} };
    mocks.getWorkItem.mockReturnValue(current);
    mocks.updateWorkItem.mockReturnValue({ ...current, status: 'done' });
    expect((await post({ itemId: 'WI-1', status: 'done' })).status).toBe(200);
    expect(mocks.updateWorkItem).toHaveBeenCalledWith({ itemId: 'WI-1', status: 'done' });
    mocks.requireOpsAccess.mockReturnValue(NextResponse.json({ ok: false }, { status: 403 }));
    mocks.updateWorkItem.mockClear();
    expect((await post({ itemId: 'WI-1', status: 'done' })).status).toBe(403);
    expect(mocks.updateWorkItem).not.toHaveBeenCalled();
  });
  it('sends a schedule change through the same custody gate without a status', async () => {
    const current = { ...intake(), status: 'ready' };
    mocks.getWorkItem.mockReturnValue(current);
    mocks.updateWorkItem.mockReturnValue({ ...current, due_date: '2026-11-30' });
    expect((await post({ itemId: 'WI-1', dueDate: '2026-11-30', startDate: null })).status).toBe(
      200
    );
    expect(mocks.updateWorkItem).toHaveBeenCalledWith({
      itemId: 'WI-1',
      dueDate: '2026-11-30',
      startDate: null,
    });
    mocks.updateWorkItem.mockClear();
    mocks.strictViewerScopeOrganizationIds.mockReturnValue(['org-other']);
    expect((await post({ itemId: 'WI-1', dueDate: '2026-11-30' })).status).toBe(403);
    expect(mocks.updateWorkItem).not.toHaveBeenCalled();
  });
  it('answers 400, not 500, for a malformed date or a date the store refuses', async () => {
    mocks.getWorkItem.mockReturnValue({ ...intake(), status: 'ready' });
    const bad = await post({ itemId: 'WI-1', dueDate: 'next friday' });
    expect(bad.status).toBe(400);
    expect(mocks.updateWorkItem).not.toHaveBeenCalled();
    mocks.updateWorkItem.mockImplementation(() => {
      throw Object.assign(new Error('start_date must not be after due_date'), {
        name: 'WorkCoordinationError',
        code: 'validation_error',
      });
    });
    const refused = await post({ itemId: 'WI-1', dueDate: '2026-11-01' });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ ok: false, error_code: 'invalid_change' });
  });
  it('rejects personal status mutation before touching shared state even for an all-tenant administrator', async () => {
    mocks.resolveOpsViewerForRequest.mockReturnValue({
      context: {
        role: 'localadmin',
        tenantSlugs: 'all',
        tierAccess: ['public', 'confidential'],
        principalId: 'owner',
      },
    });
    mocks.getWorkItem.mockReturnValue({
      ...intake(),
      metadata: { dot_scope: { tier: 'personal', owner_nhi: 'owner' } },
    });
    expect((await post({ itemId: 'WI-1', status: 'done' })).status).toBe(403);
    expect(mocks.updateWorkItem).not.toHaveBeenCalled();
    expect(mocks.requestAlignment).not.toHaveBeenCalled();
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
    mocks.requireOpsAccess.mockReturnValue(NextResponse.json({ ok: false }, { status: 403 }));
    expect((await post()).status).toBe(403);
    expect(mocks.requestAlignment).not.toHaveBeenCalled();
  });
  it('moves a card through the governed update and drops the cached workspace graph', async () => {
    mocks.updateWorkItem.mockReturnValue({ ...intake(), status: 'in_progress' });
    const response = await post({ itemId: 'WI-1', status: 'in_progress' });
    expect(response.status).toBe(200);
    expect(mocks.updateWorkItem).toHaveBeenCalledWith({ itemId: 'WI-1', status: 'in_progress' });
    expect(mocks.invalidateWorkspaceGraphCache).toHaveBeenCalledTimes(1);
  });
  it('keeps the cache when the move is refused', async () => {
    mocks.requireOpsAccess.mockReturnValue(NextResponse.json({ ok: false }, { status: 403 }));
    expect((await post({ itemId: 'WI-1', status: 'done' })).status).toBe(403);
    expect(mocks.updateWorkItem).not.toHaveBeenCalled();
    expect(mocks.invalidateWorkspaceGraphCache).not.toHaveBeenCalled();
  });
});
