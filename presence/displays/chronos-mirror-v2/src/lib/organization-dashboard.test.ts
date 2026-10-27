import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveWorkspaceScope,
  type WorkspaceScopeDependencies,
} from '@agent/core/surface/workspace-scope';
import type { WorkItem } from '@agent/core/workforce/work-coordination-types';
import type { ViewerContext } from './viewer-context';

const mocks = vi.hoisted(() => ({ list: vi.fn(), project: vi.fn(), authorize: vi.fn() }));
vi.mock('@agent/core/project/project-registry', () => ({ loadProjectRecord: mocks.project }));
vi.mock('@agent/core/workforce/work-coordination', () => ({ listWorkItems: mocks.list }));
vi.mock('@agent/core/surface/surface-authn', () => ({
  authorizeSurfaceContextOperation: mocks.authorize,
}));
vi.mock('./viewer-context', () => ({
  withViewerExecutionContext: (_viewer: unknown, read: () => unknown) => read(),
  toSurfaceAuthorizationContext: (viewer: unknown) => viewer,
  ViewerContextError: class extends Error {
    constructor(
      public status: number,
      message: string
    ) {
      super(message);
    }
  },
}));
vi.mock('./workspace-scope', () => ({
  resolveChronosWorkspace: (
    viewer: ViewerContext,
    requested: Parameters<typeof resolveWorkspaceScope>[1]
  ) =>
    resolveWorkspaceScope(
      {
        ...viewer,
        organizationIds: viewer.organizationIds ?? 'all',
        projectIds: viewer.projectIds ?? 'all',
        tierAccess: viewer.tierAccess ?? ['public', 'confidential'],
      },
      requested,
      {
        readTenant: (id) => ({ tenant_slug: id }),
        readProject: mocks.project,
        readOrganization: (id, query) => ({
          organization_id: id,
          tenant_slug: query.tenantSlug,
          tier: query.tier,
        }),
        readOperation: () => null,
      } satisfies WorkspaceScopeDependencies
    ),
}));

import { collectOrganizationDashboard } from './organization-dashboard';

const viewer: ViewerContext = {
  role: 'readonly',
  source: 'token',
  principalId: 'principal-a',
  memberId: 'alice',
  tenantSlugs: ['tenant-a'],
  organizationIds: ['org-a'],
  projectIds: ['project-a'],
  tierAccess: ['public', 'confidential'],
};
function item(id: string, project = 'project-a', assignee = 'alice', status = 'ready'): WorkItem {
  return {
    item_id: id,
    title: id,
    status,
    priority: 'normal',
    assignee_user_id: assignee,
    context: {
      tenant_slug: project === 'foreign' ? 'tenant-b' : 'tenant-a',
      organization_id: project === 'foreign' ? 'org-b' : 'org-a',
      project_id: project,
    },
    project_id: project,
    metadata: {},
    labels: [],
    updated_at: '2026-10-27T00:00:00Z',
  } as WorkItem;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockReturnValue({ allowed: true });
  mocks.project.mockImplementation((id) => ({
    project_id: id,
    organization_id: id === 'foreign' ? 'org-b' : 'org-a',
    tenant_slug: id === 'foreign' ? 'tenant-b' : 'tenant-a',
    tier: id === 'private' ? 'personal' : 'confidential',
  }));
  mocks.list.mockReturnValue([
    item('mine'),
    item('colleague', 'project-a', 'bob', 'review'),
    item('other-project', 'project-b'),
    item('cross-tenant', 'foreign'),
    item('private-tier', 'private'),
    { ...item('untyped'), context: undefined },
  ]);
});

describe('organization dashboard scope and aggregation', () => {
  it('uses real owner visibility to exclude foreign tenant, project, tier and untyped items before counts', () => {
    const data = collectOrganizationDashboard(viewer, {}, 'scope');
    expect(data.counts).toEqual({ total: 2, active: 2, blocked: 0, review: 1, ready: 1 });
    expect(data.attention.map((row) => row.id)).toEqual(['colleague', 'mine']);
    expect(data.viewer.projects).toEqual(['project-a']);
    expect(data.available).toEqual({ mine: true, organization: false });
  });
  it('filters the authenticated member before aggregation and limits returned rows only afterwards', () => {
    mocks.list.mockReturnValue([
      ...Array.from({ length: 12 }, (_, i) => item('mine-' + i)),
      item('bob', 'project-a', 'bob'),
    ]);
    const data = collectOrganizationDashboard(viewer, {}, 'mine');
    expect(data.counts.total).toBe(12);
    expect(data.attentionTotal).toBe(12);
    expect(data.attention).toHaveLength(10);
    expect(data.attention.some((row) => row.id === 'bob')).toBe(false);
  });
  it('requires member binding instead of substituting principal, role or source', () => {
    expect(() =>
      collectOrganizationDashboard({ ...viewer, memberId: undefined }, {}, 'mine')
    ).toThrow('member identity');
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it.each([
    { organization_id: 'org-a', tenant_slug: 'tenant-a' },
    { organization_id: 'org-a', tenant_slug: 'tenant-a', project_id: 'project-a' },
  ])('refuses organization-wide data for project-restricted viewers', (selection) => {
    expect(() => collectOrganizationDashboard(viewer, selection, 'organization')).toThrow();
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it('permits a selected organization only within its tenant and tier', () => {
    const data = collectOrganizationDashboard(
      { ...viewer, projectIds: 'all' },
      { tenant_slug: 'tenant-a', organization_id: 'org-a' },
      'organization'
    );
    expect(data.counts.total).toBe(3);
    expect(data.attention.some((row) => ['cross-tenant', 'private-tier'].includes(row.id))).toBe(
      false
    );
  });
  it.each([
    { tenant_slug: 'tenant-b' },
    { organization_id: 'org-b', tenant_slug: 'tenant-a' },
    { project_id: 'project-b' },
    { tier: 'personal' as const },
    { project_id: 'project-a', organization_id: 'org-b' },
  ])('rejects client selection that exceeds or contradicts the grant', (selection) => {
    expect(() => collectOrganizationDashboard(viewer, selection, 'scope')).toThrow();
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it('honors policy denial before reading work', () => {
    mocks.authorize.mockReturnValue({ allowed: false, reason: 'denied' });
    expect(() => collectOrganizationDashboard(viewer, {}, 'scope')).toThrow('denied');
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it('propagates source failure instead of reporting empty healthy data', () => {
    mocks.list.mockImplementation(() => {
      throw new Error('store unavailable');
    });
    expect(() => collectOrganizationDashboard(viewer, {}, 'scope')).toThrow('store unavailable');
  });
});
