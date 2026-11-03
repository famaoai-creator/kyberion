vi.mock('@agent/core/information-assets/collector', () => ({
  readInformationAssetCollectionCoverage: () => undefined,
  informationAssetCollectionStatePath: () =>
    '/repo/active/shared/runtime/dot/confidential/tenant-a/organizations/org-a/projects/project-a/information-assets/collections/reviews.json',
}));
vi.mock('@agent/core/path-resolver', () => ({ pathResolver: { rootDir: () => '/repo' } }));
vi.mock('@agent/core/foundation/resource-access-scope', () => ({
  runInResourceAccessScope: (_scope: unknown, fn: () => unknown) => fn(),
}));
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  catalog: vi.fn(),
  authorize: vi.fn(),
  workspace: vi.fn(),
  scope: vi.fn(),
  registryAuthority: 'free',
}));
vi.mock('@agent/core/foundation/authorization-registry', () => ({
  subjectAuthorization: () => ({
    declared: true,
    source: 'code',
    effectClass: 'local_only',
    authority: { kind: mocks.registryAuthority },
  }),
}));
vi.mock('@agent/core/authority', () => ({
  withExecutionContext: (
    role: string,
    fn: () => unknown,
    _persona: unknown,
    tenant: string,
    org: string,
    identity: unknown
  ) => {
    mocks.scope({ role, tenant, org, identity });
    return fn();
  },
}));
vi.mock('@agent/core/information-assets/catalog', () => ({
  readInformationAssetCatalog: mocks.catalog,
  loadInformationAssetDefinitions: () => [{ asset_type: 'code.review_request', title: 'Reviews' }],
}));
vi.mock('@agent/core/surface/surface-authn', () => ({
  authorizeSurfaceContextOperation: mocks.authorize,
}));
vi.mock('./workspace-scope', () => ({ resolveChronosWorkspace: mocks.workspace }));
vi.mock('./ops-viewer', () => ({
  toSurfaceAuthorizationContext: (v: unknown) => v,
  ViewerContextError: class extends Error {
    constructor(
      public status: number,
      message: string
    ) {
      super(message);
    }
  },
}));
import { collectInformationAssets } from './information-assets';
import type { ViewerContext } from './ops-viewer';
const viewer = {
  role: 'readonly',
  source: 'token',
  tenantSlugs: ['tenant-a'],
  organizationIds: ['org-a'],
  projectIds: ['project-a'],
  tierAccess: ['confidential'],
} as ViewerContext;
const selection = {
  tenant_slug: 'tenant-a',
  organization_id: 'org-a',
  project_id: 'project-a',
  tier: 'confidential',
} as const;
beforeEach(() => {
  mocks.registryAuthority = 'free';
  vi.clearAllMocks();
  mocks.workspace.mockReturnValue({
    selection,
    tenantSlugs: ['tenant-a'],
    organizationIds: ['org-a'],
    projectIds: ['project-a'],
    tierAccess: ['confidential'],
  });
  mocks.authorize.mockReturnValue({ allowed: true });
  mocks.catalog.mockReturnValue({
    version: 2,
    locations: [
      {
        location_id: 'reviews',
        asset_type: 'code.review_request',
        scope: selection,
        service_id: 'github',
        collector_id: 'github.review_requests',
        binding_id: 'private-binding',
        selectors: { secret: 'hidden' },
        enabled: true,
        authoritative: true,
        freshness_seconds: 300,
        updated_at: '2026-11-02T00:00:00Z',
      },
    ],
  });
});
describe('information source viewer projection', () => {
  it('does not bypass a strengthened registry authority with readonly surface permission', () => {
    mocks.registryAuthority = 'approval';
    expect(() => collectInformationAssets(viewer, selection)).toThrow('declared authority');
    expect(mocks.catalog).not.toHaveBeenCalled();
    expect(mocks.workspace).not.toHaveBeenCalled();
  });
  it('binds the server-authorized entity scope and omits connection selectors and bindings', () => {
    const result = collectInformationAssets(viewer, selection);
    expect(mocks.catalog).toHaveBeenCalledWith({
      tenant_slug: 'tenant-a',
      organization_id: 'org-a',
      project_id: 'project-a',
    });
    expect(mocks.scope).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant: 'tenant-a',
        org: 'org-a',
        identity: { projectId: 'project-a', missionId: null },
      })
    );
    expect(result.locations).toEqual([
      expect.objectContaining({ id: 'reviews', title: 'Reviews' }),
    ]);
    expect(JSON.stringify(result)).not.toContain('private-binding');
    expect(JSON.stringify(result)).not.toContain('hidden');
  });
  it('denies failed authorization before reading catalog or counting rows', () => {
    mocks.authorize.mockReturnValue({ allowed: false, reason: 'denied' });
    expect(() => collectInformationAssets(viewer, selection)).toThrow('denied');
    expect(mocks.catalog).not.toHaveBeenCalled();
  });
  it('requires a project selection for project-limited viewers', () => {
    mocks.workspace.mockReturnValue({ selection: { ...selection, project_id: undefined } });
    expect(() => collectInformationAssets(viewer, {})).toThrow('Select an authorized project');
    expect(mocks.catalog).not.toHaveBeenCalled();
  });
  it('does not replace a failed source read with a successful empty catalog', () => {
    mocks.catalog.mockImplementation(() => {
      throw new Error('catalog unavailable');
    });
    expect(() => collectInformationAssets(viewer, selection)).toThrow('catalog unavailable');
  });
  it('requires confidential organization selection', () => {
    mocks.workspace.mockReturnValue({ selection: { ...selection, tier: 'public' } });
    expect(() => collectInformationAssets(viewer, {})).toThrow('confidential');
    expect(mocks.catalog).not.toHaveBeenCalled();
  });
});
