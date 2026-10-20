import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveWorkspaceScope,
  workspaceScopeMatchesResource,
  type WorkspaceScopeDependencies,
  type WorkspaceViewer,
} from './workspace-scope.js';
import type { OrganizationOperationRecord } from '../organization/organization-operating-model.js';

const viewer: WorkspaceViewer = {
  tenantSlugs: ['tenant-a', 'tenant-b'],
  organizationIds: ['org-a', 'org-b'],
  projectIds: 'all',
  tierAccess: ['public', 'confidential'],
};
let deps: WorkspaceScopeDependencies;
beforeEach(() => {
  deps = {
    readTenant: vi.fn((slug) => ({ tenant_slug: slug })),
    readOrganization: vi.fn((id, query) => ({
      organization_id: id,
      tenant_slug: query.tenantSlug,
      tier: query.tier,
    })),
    readProject: vi.fn(() => ({
      project_id: 'project-a',
      organization_id: 'org-a',
      tenant_slug: 'tenant-a',
      tier: 'confidential',
    })),
    readOperation: vi.fn(
      (id, query) =>
        ({
          operation_id: id,
          organization_id: query.organizationId,
          tenant_slug: query.tenantSlug,
          tier: query.tier,
        }) as OrganizationOperationRecord
    ),
  };
});
describe('workspace scope resolution', () => {
  it('retains broad viewer restrictions without scanning registries', () => {
    expect(resolveWorkspaceScope(viewer, {}, deps)).toMatchObject({
      ...viewer,
      selection: { kind: 'tenant' },
    });
    for (const read of Object.values(deps)) expect(read).not.toHaveBeenCalled();
  });
  it('derives canonical project parents then narrows every allowed axis', () => {
    expect(resolveWorkspaceScope(viewer, { project_id: 'project-a' }, deps)).toMatchObject({
      selection: {
        kind: 'project',
        tenant_slug: 'tenant-a',
        organization_id: 'org-a',
        project_id: 'project-a',
        tier: 'confidential',
      },
      tenantSlugs: ['tenant-a'],
      organizationIds: ['org-a'],
      projectIds: ['project-a'],
      tierAccess: ['confidential'],
    });
    expect(deps.readOrganization).toHaveBeenCalledWith('org-a', {
      tier: 'confidential',
      tenantSlug: 'tenant-a',
    });
  });
  it.each(['public', 'personal'] as const)(
    'preserves an untenanted %s project without inventing parents',
    (tier) => {
      vi.mocked(deps.readProject).mockReturnValueOnce({ project_id: 'project-a', tier });
      const resolved = resolveWorkspaceScope(
        { tenantSlugs: 'all', organizationIds: 'all', projectIds: 'all', tierAccess: [tier] },
        { project_id: 'project-a' },
        deps
      );
      expect(resolved.selection).toMatchObject({ kind: 'project', project_id: 'project-a', tier });
      expect(resolved.selection.tenant_slug).toBeUndefined();
      expect(resolved.selection.organization_id).toBeUndefined();
      expect(deps.readTenant).not.toHaveBeenCalled();
      expect(deps.readOrganization).not.toHaveBeenCalled();
    }
  );
  it.each([
    { tenant_slug: 'tenant-b', project_id: 'project-a' },
    { organization_id: 'org-b', project_id: 'project-a' },
    { project_id: 'project-a', tier: 'public' as const },
  ])('rejects authorized ids whose actual parents differ: %j', (requested) => {
    expect(() => resolveWorkspaceScope(viewer, requested, deps)).toThrow();
  });
  it('rejects inferred parents outside the viewer and never reads their organization', () => {
    expect(() =>
      resolveWorkspaceScope(
        { ...viewer, tenantSlugs: ['tenant-b'] },
        { project_id: 'project-a' },
        deps
      )
    ).toThrow();
    expect(deps.readOrganization).not.toHaveBeenCalled();
  });
  it('rejects denied requested ids before registry inspection', () => {
    expect(() => resolveWorkspaceScope(viewer, { tenant_slug: 'other-tenant' }, deps)).toThrow();
    expect(deps.readTenant).not.toHaveBeenCalled();
  });
  it.each(['public', '../escape', 'shared', ''])(
    'never accepts partition or malformed tenant %s',
    (tenant_slug) => {
      expect(() => resolveWorkspaceScope(viewer, { tenant_slug }, deps)).toThrow();
    }
  );
  it('requires real matching tenant and organization records', () => {
    vi.mocked(deps.readTenant).mockReturnValueOnce(null);
    expect(() => resolveWorkspaceScope(viewer, { tenant_slug: 'tenant-a' }, deps)).toThrow();
    vi.mocked(deps.readOrganization).mockReturnValueOnce({
      organization_id: 'org-a',
      tenant_slug: 'tenant-b',
      tier: 'confidential',
    });
    expect(() =>
      resolveWorkspaceScope(viewer, { tenant_slug: 'tenant-a', organization_id: 'org-a' }, deps)
    ).toThrow();
  });
  it('resolves an operation inside its actual organization without a project relation', () => {
    expect(
      resolveWorkspaceScope(
        viewer,
        { tenant_slug: 'tenant-a', organization_id: 'org-a', operation_id: 'op-a' },
        deps
      )
    ).toMatchObject({
      selection: { kind: 'operation', operation_id: 'op-a', organization_id: 'org-a' },
    });
    expect(deps.readOperation).toHaveBeenCalledWith('op-a', {
      organizationId: 'org-a',
      tenantSlug: 'tenant-a',
      tier: 'confidential',
    });
  });
  it('cannot use project-specific authority as authority over an organization operation', () => {
    expect(() =>
      resolveWorkspaceScope(
        { ...viewer, projectIds: ['project-a'] },
        { tenant_slug: 'tenant-a', organization_id: 'org-a', operation_id: 'op-a' },
        deps
      )
    ).toThrow();
    expect(deps.readOperation).not.toHaveBeenCalled();
  });
  it('rejects combined project and operation selections before reads', () => {
    expect(() =>
      resolveWorkspaceScope(viewer, { project_id: 'project-a', operation_id: 'op-a' }, deps)
    ).toThrow();
    expect(deps.readProject).not.toHaveBeenCalled();
  });
  it('rejects a mismatched operation record and inaccessible tier', () => {
    vi.mocked(deps.readOperation).mockReturnValueOnce({
      operation_id: 'op-a',
      organization_id: 'org-b',
      tenant_slug: 'tenant-a',
      tier: 'confidential',
    } as OrganizationOperationRecord);
    expect(() =>
      resolveWorkspaceScope(
        viewer,
        { tenant_slug: 'tenant-a', organization_id: 'org-a', operation_id: 'op-a' },
        deps
      )
    ).toThrow();
    expect(() => resolveWorkspaceScope(viewer, { tier: 'personal' }, deps)).toThrow();
  });
});

describe('resource sensitivity boundary', () => {
  it('never guesses an unknown resource tier for a public-only viewer without a tier query', () => {
    const scope = resolveWorkspaceScope(
      { tenantSlugs: 'all', organizationIds: 'all', projectIds: 'all', tierAccess: ['public'] },
      {},
      deps
    );
    expect(workspaceScopeMatchesResource(scope, {})).toBe(false);
    expect(workspaceScopeMatchesResource(scope, { tier: 'confidential' })).toBe(false);
    expect(workspaceScopeMatchesResource(scope, { tier: 'public' })).toBe(true);
  });
});
