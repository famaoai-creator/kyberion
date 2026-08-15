import { describe, expect, it } from 'vitest';
import {
  physicalScopeNamespace,
  physicalScopedPath,
  isTenantPhysicalNamespacePath,
} from './physical-namespace.js';

describe('physical namespace', () => {
  it('keeps system records at the unqualified system root', () => {
    expect(physicalScopeNamespace({ scope_kind: 'system', tier: 'public' })).toBe('');
    expect(
      physicalScopedPath(
        'active/shared/runtime/example',
        { scope_kind: 'system', tier: 'public' },
        'x.json'
      )
    ).toBe('active/shared/runtime/example/x.json');
  });

  it('encodes tenant and entity lineage in the physical path', () => {
    const scope = {
      scope_kind: 'mission' as const,
      tier: 'confidential' as const,
      tenant_slug: 'tenant-a',
      organization_id: 'org-a',
      project_id: 'project-a',
      mission_id: 'MSN-A',
    };
    expect(physicalScopeNamespace(scope)).toBe(
      'tenants/tenant-a/organizations/org-a/projects/project-a/missions/MSN-A'
    );
    expect(isTenantPhysicalNamespacePath(physicalScopedPath('base', scope, 'record.json'))).toBe(
      true
    );
  });

  it('rejects path-like entity identifiers', () => {
    expect(() =>
      physicalScopeNamespace({
        scope_kind: 'tenant',
        tier: 'confidential',
        tenant_slug: 'tenant-a',
        organization_id: '../other-tenant',
      })
    ).toThrow(/SCOPE_CONTEXT_INVALID|PHYSICAL_NAMESPACE_SEGMENT_INVALID/);
  });
});
