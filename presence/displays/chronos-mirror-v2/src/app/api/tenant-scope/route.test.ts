import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({
  organizations: 'all' as string[] | 'all',
  projects: 'all' as string[] | 'all',
}));
vi.mock('../../../lib/api-guard', () => ({
  guardRequest: () => null,
  requireChronosAccess: () => null,
}));
vi.mock('../../../lib/viewer-context', () => ({
  resolveViewerContextForRequest: () => ({ context: { source: 'test' } }),
  strictViewerScopeTenantSlugs: () => ['acme'],
  strictViewerScopeOrganizationIds: (_: unknown, requested?: string) => {
    if (requested && mocks.organizations !== 'all' && !mocks.organizations.includes(requested))
      throw Error('denied');
    return requested ? [requested] : mocks.organizations;
  },
  strictViewerScopeProjectIds: (_: unknown, requested?: string) => {
    if (requested && mocks.projects !== 'all' && !mocks.projects.includes(requested))
      throw Error('denied');
    return requested ? [requested] : mocks.projects;
  },
  withViewerExecutionContext: (_: unknown, fn: () => unknown) => fn(),
  viewerErrorResponse: () => new Response('{}', { status: 403 }),
}));
vi.mock('@agent/core/path-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/path-resolver')>()),
  organizationWorkspaceDir: (id: string) => '/organizations/' + id,
}));
vi.mock('@agent/core/secure-io', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/secure-io')>()),
  safeExistsSync: () => true,
  safeReaddir: () => ['ORG-A', 'ORG-EMPTY', 'ORG-B'],
}));
vi.mock('@agent/core/organization/organization-operating-model-persistence', () => ({
  loadOrganizationOperationalState: (id: string) => ({ organization_id: id }),
}));
vi.mock('@agent/core/organization/tenant-registry', () => ({
  listTenantProfileSlugs: () => ['acme'],
  readTenantProfile: () => ({ display_name: 'Acme', status: 'active' }),
}));
vi.mock('@agent/core/project/project-registry', () => ({
  listProjectRecords: () => [
    { project_id: 'PRJ-A', organization_id: 'ORG-A', tenant_slug: 'acme', name: 'A' },
    { project_id: 'PRJ-B', organization_id: 'ORG-A', tenant_slug: 'acme', name: 'B' },
    { project_id: 'PRJ-C', organization_id: 'ORG-B', tenant_slug: 'other', name: 'C' },
  ],
}));
import { GET } from './route';
describe('tenant scope options', () => {
  beforeEach(() => {
    mocks.organizations = 'all';
    mocks.projects = 'all';
  });
  it('includes empty organizations and keeps authorized siblings after a selection', async () => {
    const response = GET(
      new NextRequest(
        'http://localhost/api/tenant-scope?tenant=acme&organization_id=ORG-A&project_id=PRJ-A'
      )
    );
    const data = await response.json();
    expect(data.organizations.map((item: { id: string }) => item.id)).toEqual([
      'ORG-A',
      'ORG-B',
      'ORG-EMPTY',
    ]);
    expect(data.projects.map((item: { id: string }) => item.id)).toEqual(['PRJ-A', 'PRJ-B']);
  });
  it('retains principal limits and rejects forged selection', async () => {
    mocks.organizations = ['ORG-A'];
    mocks.projects = ['PRJ-A'];
    const data = await GET(new NextRequest('http://localhost/api/tenant-scope')).json();
    expect(data.organizations.map((item: { id: string }) => item.id)).toEqual(['ORG-A']);
    expect(data.projects.map((item: { id: string }) => item.id)).toEqual(['PRJ-A']);
    expect(
      GET(new NextRequest('http://localhost/api/tenant-scope?organization_id=ORG-B')).status
    ).toBe(403);
    expect(GET(new NextRequest('http://localhost/api/tenant-scope?project_id=PRJ-B')).status).toBe(
      403
    );
  });
});
