// Keep hierarchy validation real; managed readers and one project-OS path are synthetic.
// No member, organization or project state is created on disk.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import * as secureIO from '@agent/core/secure-io';

vi.mock('@agent/core/organization/organization-operating-model', async () => ({
  ...(await vi.importActual<typeof import('@agent/core/organization/organization-operating-model')>(
    '@agent/core/organization/organization-operating-model'
  )),
  loadOrganizationOperationalState: vi.fn(),
}));
vi.mock('@agent/core/project/project-registry', async () => ({
  ...(await vi.importActual<typeof import('@agent/core/project/project-registry')>(
    '@agent/core/project/project-registry'
  )),
  loadProjectRecord: vi.fn(),
}));

import {
  loadOrganizationOperationalState,
  type OrganizationOperationalState,
} from '@agent/core/organization/organization-operating-model';
import { loadProjectRecord, type ProjectRecord } from '@agent/core/project/project-registry';
import {
  HearingScopeError,
  hearingScopedUrl,
  resolveHearingHandoffScope,
} from './hearing-request-scope.js';
import type { PresenceStudioViewerContext } from './security.js';

const TENANT = 'zz-hearing-request-scope';
const PROJECT_OS_PATH = pathResolver.projectOsDir('project-a', 'confidential', TENANT);
const realExists = secureIO.safeExistsSync;
const realLstat = secureIO.safeLstat;
let projectOsMode: 'directory' | 'missing' | 'file';
const organization: OrganizationOperationalState = {
  organization_id: 'org-a',
  name: 'Synthetic organization',
  tier: 'confidential',
  tenant_slug: TENANT,
  status: 'active',
  active_project_ids: ['project-a'],
  updated_at: '2026-10-18T07:00:00.000Z',
};
const project: ProjectRecord = {
  project_id: 'project-a',
  name: 'Synthetic project',
  summary: 'Hearing request scope test fixture',
  status: 'active',
  tier: 'confidential',
  tenant_slug: TENANT,
  organization_id: 'org-a',
};

function viewer(patch: Partial<PresenceStudioViewerContext> = {}): PresenceStudioViewerContext {
  return {
    principalId: 'human:scope-unit-test',
    source: 'loopback',
    tenantSlugs: [TENANT],
    organizationIds: ['org-a'],
    projectIds: ['project-a'],
    ...patch,
  };
}

function expectScopeError(
  fn: () => unknown,
  code: HearingScopeError['code'] = 'hearing_scope_unavailable'
) {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HearingScopeError);
  expect(caught).toMatchObject({ status: 400, code, message: code });
}

function expectNoRegistryReads() {
  expect(loadProjectRecord).not.toHaveBeenCalled();
  expect(loadOrganizationOperationalState).not.toHaveBeenCalled();
}

beforeEach(() => {
  projectOsMode = 'directory';
  vi.spyOn(secureIO, 'safeExistsSync').mockImplementation((path) =>
    path === PROJECT_OS_PATH ? projectOsMode !== 'missing' : realExists(path)
  );
  vi.spyOn(secureIO, 'safeLstat').mockImplementation((path) => {
    if (path === PROJECT_OS_PATH) {
      return realLstat(
        projectOsMode === 'file' ? pathResolver.rootResolve('package.json') : pathResolver.rootDir()
      );
    }
    return realLstat(path);
  });
  vi.mocked(loadProjectRecord)
    .mockReset()
    .mockReturnValue({ ...project });
  vi.mocked(loadOrganizationOperationalState)
    .mockReset()
    .mockReturnValue({ ...organization });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('hearing handoff destination scope', () => {
  it('resolves the registered tenant, organization and project relationship', () => {
    expect(resolveHearingHandoffScope(viewer(), 'mission')).toEqual({
      tenantSlug: TENANT,
      organizationId: 'org-a',
      projectId: 'project-a',
    });
    expect(loadProjectRecord).toHaveBeenCalledWith('project-a');
    expect(secureIO.safeExistsSync).toHaveBeenCalledWith(PROJECT_OS_PATH);
    expect(secureIO.safeLstat).toHaveBeenCalledWith(PROJECT_OS_PATH);
    expect(loadOrganizationOperationalState).toHaveBeenCalledExactlyOnceWith('org-a', {
      tier: 'confidential',
      tenantSlug: TENANT,
    });
  });

  it('derives an omitted broad parent from the selected managed project', () => {
    expect(resolveHearingHandoffScope(viewer({ organizationIds: 'all' }), 'mission')).toEqual({
      tenantSlug: TENANT,
      organizationId: 'org-a',
      projectId: 'project-a',
    });
    expect(loadOrganizationOperationalState).toHaveBeenCalledWith('org-a', {
      tier: 'confidential',
      tenantSlug: TENANT,
    });
  });

  it.each(['mission', 'inventory'] as const)(
    'supports a selected organization without a project for %s',
    (kind) => {
      expect(resolveHearingHandoffScope(viewer({ projectIds: 'all' }), kind)).toEqual({
        tenantSlug: TENANT,
        organizationId: 'org-a',
      });
      expect(loadProjectRecord).not.toHaveBeenCalled();
      expect(loadOrganizationOperationalState).toHaveBeenCalledExactlyOnceWith('org-a', {
        tier: 'confidential',
        tenantSlug: TENANT,
      });
    }
  );

  it.each(['mission', 'inventory'] as const)(
    'preserves a tenant-only destination for %s when org/project are unrestricted',
    (kind) => {
      expect(
        resolveHearingHandoffScope(
          viewer({
            organizationIds: 'all',
            projectIds: 'all',
          }),
          kind
        )
      ).toEqual({ tenantSlug: TENANT });
      expectNoRegistryReads();
    }
  );

  it.each([
    ['foreign tenant', { tenant_slug: 'zz-foreign-scope' }],
    ['foreign tier', { tier: 'personal' }],
    ['different project id', { project_id: 'project-b' }],
    ['different organization', { organization_id: 'org-b' }],
    ['missing organization', { organization_id: undefined }],
  ] satisfies Array<[string, Partial<ProjectRecord>]>)(
    'rejects a project with %s without disclosing registry details',
    (_label, patch) => {
      vi.mocked(loadProjectRecord).mockReturnValue({ ...project, ...patch });
      expectScopeError(() => resolveHearingHandoffScope(viewer(), 'mission'));
      expect(loadOrganizationOperationalState).not.toHaveBeenCalled();
    }
  );

  it.each(['missing', 'corrupt', 'unreadable'] as const)(
    'rejects a %s managed project',
    (failure) => {
      if (failure === 'missing') vi.mocked(loadProjectRecord).mockReturnValue(null);
      else
        vi.mocked(loadProjectRecord).mockImplementation(() => {
          throw new Error('Private project registry detail: ' + failure);
        });
      expectScopeError(() => resolveHearingHandoffScope(viewer(), 'mission'));
      expect(loadOrganizationOperationalState).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['foreign tenant', { tenant_slug: 'zz-foreign-scope' }],
    ['missing tenant', { tenant_slug: undefined }],
    ['foreign tier', { tier: 'public' }],
    ['different organization id', { organization_id: 'org-b' }],
  ] satisfies Array<[string, Partial<OrganizationOperationalState>]>)(
    'rejects an organization with %s even if the managed reader returned a record',
    (_label, patch) => {
      vi.mocked(loadOrganizationOperationalState).mockReturnValue({ ...organization, ...patch });
      expectScopeError(() => resolveHearingHandoffScope(viewer(), 'mission'));
    }
  );

  it.each(['mission', 'inventory'] as const)(
    'rejects missing and unreadable organizations for %s',
    (kind) => {
      const selected = viewer({ projectIds: 'all' });
      vi.mocked(loadOrganizationOperationalState).mockReturnValue(null);
      expectScopeError(() => resolveHearingHandoffScope(selected, kind));
      vi.mocked(loadOrganizationOperationalState).mockImplementation(() => {
        throw new Error('Private organization registry corruption');
      });
      expectScopeError(() => resolveHearingHandoffScope(selected, kind));
      expect(loadProjectRecord).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['tenant', { tenantSlugs: [TENANT, 'zz-other-scope'] }],
    ['organization', { organizationIds: ['org-a', 'org-b'] }],
    ['project', { projectIds: ['project-a', 'project-b'] }],
    ['empty organization set', { organizationIds: [] }],
    ['empty project set', { projectIds: [] }],
  ] satisfies Array<[string, Partial<PresenceStudioViewerContext>]>)(
    'requires an explicit selection from a finite %s set before registry reads',
    (_label, patch) => {
      expectScopeError(() => resolveHearingHandoffScope(viewer(patch), 'mission'));
      expectNoRegistryReads();
    }
  );

  it('keeps a multi-organization selection ambiguous even when a project supplies a parent', () => {
    expectScopeError(() =>
      resolveHearingHandoffScope(
        viewer({
          organizationIds: ['org-a', 'org-b'],
          projectIds: ['project-a'],
        }),
        'mission'
      )
    );
    expectNoRegistryReads();
  });

  it('retains unscoped local personal inventory without managed owner reads', () => {
    expect(
      resolveHearingHandoffScope(
        viewer({
          tenantSlugs: [],
          organizationIds: 'all',
          projectIds: 'all',
        }),
        'inventory'
      )
    ).toEqual({});
    expectNoRegistryReads();
  });

  it.each(['all', 'unscoped'] as const)(
    'rejects mission handoff without one tenant: %s',
    (tenants) => {
      expectScopeError(() =>
        resolveHearingHandoffScope(
          viewer({
            tenantSlugs: tenants === 'all' ? 'all' : [],
            organizationIds: 'all',
            projectIds: 'all',
          }),
          'mission'
        )
      );
      expectNoRegistryReads();
    }
  );

  it('does not let a token viewer use unscoped personal inventory', () => {
    expectScopeError(() =>
      resolveHearingHandoffScope(
        viewer({
          tenantSlugs: [],
          organizationIds: 'all',
          projectIds: 'all',
          source: 'token',
        }),
        'inventory'
      )
    );
    expectNoRegistryReads();
  });

  it.each([
    { projectIds: ['project-a'] },
    { projectIds: ['project-a', 'project-b'] },
    { projectIds: [] },
  ])('rejects project-scoped inventory before registry reads: $projectIds', ({ projectIds }) => {
    expectScopeError(
      () => resolveHearingHandoffScope(viewer({ projectIds }), 'inventory'),
      'hearing_inventory_project_unsupported'
    );
    expectNoRegistryReads();
  });

  it.each(['missing', 'file'] as const)(
    'rejects a project whose project-OS scaffold is %s before handoff effects',
    (mode) => {
      projectOsMode = mode;
      expectScopeError(() => resolveHearingHandoffScope(viewer(), 'mission'));
      expect(secureIO.safeExistsSync).toHaveBeenCalledWith(PROJECT_OS_PATH);
      if (mode === 'missing') expect(secureIO.safeLstat).not.toHaveBeenCalledWith(PROJECT_OS_PATH);
      else expect(secureIO.safeLstat).toHaveBeenCalledWith(PROJECT_OS_PATH);
    }
  );
});

describe('hearing scoped links', () => {
  it('preserves scenario, version and fragment when carrying validated singleton scope', () => {
    const result = hearingScopedUrl(
      '/api/hearing/session/canvas?scenario_id=work_inventory&version=v3#preview',
      viewer()
    );
    const url = new URL(result, 'http://localhost');
    expect(url.pathname).toBe('/api/hearing/session/canvas');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      scenario_id: 'work_inventory',
      version: 'v3',
      tenant: TENANT,
      organizationId: 'org-a',
      projectId: 'project-a',
    });
    expect(url.hash).toBe('#preview');
    expectNoRegistryReads();
  });

  it('does not fabricate an org/project selection from broad allowed sets', () => {
    const result = hearingScopedUrl(
      '/api/hearing/session/canvas',
      viewer({
        organizationIds: ['org-a', 'org-b'],
        projectIds: 'all',
      })
    );
    expect(Object.fromEntries(new URL(result, 'http://localhost').searchParams)).toEqual({
      tenant: TENANT,
    });
    expectNoRegistryReads();
  });

  it('clears preexisting scope selectors while preserving configured origin, query and fragment', () => {
    const result = hearingScopedUrl(
      'https://example.invalid/progress?tenant=foreign&organizationId=org-foreign&projectId=project-foreign&view=hearing#card',
      viewer({ tenantSlugs: [], organizationIds: 'all', projectIds: ['project-a', 'project-b'] })
    );
    const url = new URL(result);
    expect(url.origin).toBe('https://example.invalid');
    expect(url.pathname).toBe('/progress');
    expect(Object.fromEntries(url.searchParams)).toEqual({ view: 'hearing' });
    expect(url.hash).toBe('#card');
    expectNoRegistryReads();
  });
});
