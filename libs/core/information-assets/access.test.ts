import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  current: {
    tenantBound: true,
    tenantSlug: 'acme',
    organizationId: 'org-a',
    executionIdentity: {} as { projectId?: string },
  },
  binding: {} as Record<string, unknown>,
  org: { status: 'active', tenant_slug: 'acme', organization_id: 'org-a' },
  project: { status: 'active', tenant_slug: 'acme', organization_id: 'org-a' },
}));
vi.mock('../foundation/execution-scope.js', () => ({ currentExecutionScope: () => state.current }));
vi.mock('../organization/organization-operating-model-persistence.js', () => ({
  loadOrganizationOperationalState: () => state.org,
}));
vi.mock('../project/project-registry.js', () => ({ loadProjectRecord: () => state.project }));
vi.mock('../service/service-binding-registry.js', () => ({
  loadServiceBindingRecord: () => state.binding,
}));
vi.mock('../organization/organization-people-access.js', () => ({
  authorizeOrganizationPeople: async (a: unknown) => a,
}));
vi.mock('../authority.js', () => ({
  withExecutionContext: (_r: unknown, action: () => unknown) => action(),
}));
import {
  assertCurrentInformationAssetScope,
  assertInformationAssetParents,
  assertInformationAssetBinding,
} from './access.js';
import type { InformationAssetLocation } from './types.js';
const scope = { tenant_slug: 'acme', organization_id: 'org-a' };
const location = {
  scope,
  binding_id: 'binding-a',
  service_id: 'github',
} as InformationAssetLocation;
describe('information asset authorization boundaries', () => {
  beforeEach(() => {
    state.current.executionIdentity = {};
    state.org.status = 'active';
    state.project.organization_id = 'org-a';
    state.binding = {
      tenant_slug: 'acme',
      owner_kind: 'organization',
      owner_ref: 'acme',
      service_id: 'github',
      allowed_actions: ['list'],
      approval_policy: { list: 'allowed' },
      secret_refs: ['never-project'],
    };
  });
  it('requires the current tenant and organization, and cannot widen a project actor', () => {
    expect(() => assertCurrentInformationAssetScope(scope)).not.toThrow();
    expect(() => assertCurrentInformationAssetScope({ ...scope, tenant_slug: 'other' })).toThrow();
    expect(() =>
      assertCurrentInformationAssetScope({ ...scope, organization_id: 'other' })
    ).toThrow();
    state.current.executionIdentity = { projectId: 'project-a' };
    expect(() => assertCurrentInformationAssetScope(scope)).toThrow();
    expect(() =>
      assertCurrentInformationAssetScope({ ...scope, project_id: 'project-a' })
    ).not.toThrow();
  });
  it('checks active canonical parent relationships', () => {
    expect(() =>
      assertInformationAssetParents({ ...scope, project_id: 'project-a' })
    ).not.toThrow();
    state.project.organization_id = 'other';
    expect(() => assertInformationAssetParents({ ...scope, project_id: 'project-a' })).toThrow();
    state.org.status = 'archived';
    expect(() => assertInformationAssetParents(scope)).toThrow();
  });
  it('uses tenant binding ownership and explicit allowed policy on every capture', () => {
    expect(() => assertInformationAssetBinding(location, 'list')).not.toThrow();
    state.binding.owner_ref = 'org-a';
    expect(() => assertInformationAssetBinding(location, 'list')).toThrow();
    state.binding.owner_ref = 'acme';
    state.binding.approval_policy = { list: 'approval_required' };
    expect(() => assertInformationAssetBinding(location, 'list')).toThrow();
    state.binding.approval_policy = {};
    expect(() => assertInformationAssetBinding(location, 'list')).toThrow();
  });
  it('rejects organization bindings for a project and mismatched service', () => {
    expect(() =>
      assertInformationAssetBinding(
        { ...location, scope: { ...scope, project_id: 'project-a' } },
        'list'
      )
    ).toThrow();
    expect(() =>
      assertInformationAssetBinding({ ...location, service_id: 'gmail' }, 'list')
    ).toThrow();
  });
});
