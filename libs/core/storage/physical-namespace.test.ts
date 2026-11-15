import { describe, expect, it } from 'vitest';
import {
  partitionedScopedPath,
  physicalScopeNamespace,
  physicalScopedPath,
  isTenantPhysicalNamespacePath,
} from './physical-namespace.js';
import { PARTITIONED_RUNTIME_STATE_ROOTS, tenantRuntimePartitionOf } from '../storage-layout.js';

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

  it('keeps personal owner and full entity lineage distinct from system and other owners', () => {
    const scope = {
      tier: 'personal' as const,
      nhi_id: 'user:alice',
      tenant_slug: 'acme',
      organization_id: 'org',
      project_id: 'project',
      mission_id: 'MSN-A',
      task_id: 'task',
    };
    const alice = physicalScopedPath('base', scope, 'entry.json');
    expect(alice).toMatch(
      /^base\/personal\/acme\/owners\/[a-f0-9]{64}\/organizations\/org\/projects\/project\/missions\/MSN-A\/tasks\/task\/entry.json$/
    );
    expect(alice).not.toBe(
      physicalScopedPath('base', { ...scope, nhi_id: 'user:bob' }, 'entry.json')
    );
    expect(partitionedScopedPath('base', scope, 'entry.json')).toBe(alice);
    expect(() => physicalScopedPath('base', { tier: 'personal' }, 'entry.json')).toThrow(
      'PERSONAL_SCOPE_OWNER_REQUIRED'
    );
  });
});

describe('partitionedScopedPath (registered <root>/<tier>/<tenant> layout)', () => {
  const root = PARTITIONED_RUNTIME_STATE_ROOTS.api_verification;

  it('places tenant scopes under <tier>/<tenant> with the entity namespace below it', () => {
    const relative = partitionedScopedPath(
      root,
      { tier: 'confidential', tenant_slug: 'acme', organization_id: 'org-a', project_id: 'p1' },
      'anthropic.json'
    );
    expect(relative).toBe(
      `${root}/confidential/acme/organizations/org-a/projects/p1/anthropic.json`
    );
    // Unlike physicalScopedPath, the registry can classify it for offboarding/backup.
    expect(tenantRuntimePartitionOf(relative)).toMatchObject({
      key: 'api_verification',
      tier: 'confidential',
      tenant: 'acme',
    });
    expect(
      tenantRuntimePartitionOf(
        physicalScopedPath(root, { tier: 'confidential', tenant_slug: 'acme' }, 'anthropic.json')
      )
    ).toBeUndefined();
  });

  it('places untenanted scopes under system/', () => {
    expect(partitionedScopedPath(root, { scope_kind: 'system', tier: 'public' }, 'x.json')).toBe(
      `${root}/system/x.json`
    );
  });
});
