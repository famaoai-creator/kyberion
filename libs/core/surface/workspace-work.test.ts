import { describe, expect, it } from 'vitest';
import { workspaceWorkItemVisible, type WorkspaceWorkReaders } from './workspace-work.js';
import type { WorkItem } from '../workforce/work-coordination-types.js';
import type { ResolvedWorkspaceScope } from './workspace-scope.js';
import { dotAdmissionScopeHash } from '../dot/dot-admission-identity.js';

const scope: ResolvedWorkspaceScope = {
  tenantSlugs: ['tenant-a'],
  organizationIds: 'all',
  projectIds: 'all',
  tierAccess: ['public'],
  selection: { kind: 'tenant', tenant_slug: 'tenant-a', tier: 'public' },
};
const item = (context: WorkItem['context']) =>
  ({ item_id: 'item', title: 'Hidden unless verified', context }) as WorkItem;
const project = {
  project_id: 'p',
  organization_id: 'o',
  tenant_slug: 'tenant-a',
  tier: 'public' as const,
};
const lookup: WorkspaceWorkReaders = {
  project: () => project,
  mission: () => project,
  organization: () => null,
};
describe('workspace work privacy', () => {
  it('does not assign public tier from a visible namesake of an untyped confidential organization', () => {
    const work = item({ tenant_slug: 'tenant-a', organization_id: 'o' });
    expect(
      workspaceWorkItemVisible(work, scope, {
        ...lookup,
        organization: (_id, tier) => ({ organization_id: 'o', tenant_slug: 'tenant-a', tier }),
      })
    ).toBe(false);
  });
  it('uses frozen dot admission for operation work instead of an editable metadata label', () => {
    const source = {
      dot_id: 'dot-weekly',
      scope: { tier: 'public' as const, tenant_slug: 'tenant-a', organization_id: 'o' },
      work_binding: { operation_id: 'weekly' },
    };
    const work = {
      ...item({ tenant_slug: 'tenant-a', organization_id: 'o' }),
      metadata: { dot_id: source.dot_id, action_ref: 'action-1', operation_id: 'weekly' },
    };
    const selected: ResolvedWorkspaceScope = {
      ...scope,
      selection: {
        ...scope.selection,
        kind: 'operation',
        organization_id: 'o',
        operation_id: 'weekly',
      },
    };
    const ports: WorkspaceWorkReaders = {
      ...lookup,
      dot: () => source,
      admission: () => ({ scope_hash: dotAdmissionScopeHash(source) }),
      organization: () => source.scope,
    };
    expect(workspaceWorkItemVisible(work, selected, ports)).toBe(true);
    expect(workspaceWorkItemVisible(work, selected, { ...ports, admission: () => null })).toBe(
      false
    );
    expect(
      workspaceWorkItemVisible(work, selected, {
        ...ports,
        dot: () => ({ ...source, scope: { ...source.scope, tier: 'confidential' } }),
      })
    ).toBe(false);
  });
  it('does not treat an authorized tenant as permission for a confidential project', () => {
    const work = item({ tenant_slug: 'tenant-a', organization_id: 'o', project_id: 'p' });
    expect(workspaceWorkItemVisible(work, scope, lookup)).toBe(true);
    expect(
      workspaceWorkItemVisible(work, scope, {
        ...lookup,
        project: () => ({ ...project, tier: 'confidential' }),
      })
    ).toBe(false);
  });
  it('withholds untyped/unresolvable owners instead of guessing public', () => {
    expect(workspaceWorkItemVisible(item({ tenant_slug: 'tenant-a' }), scope, lookup)).toBe(false);
    expect(
      workspaceWorkItemVisible(item({ tenant_slug: 'tenant-a', project_id: 'p' }), scope, {
        ...lookup,
        project: () => null,
      })
    ).toBe(false);
  });
  it('requires both project and mission tier and matching parents', () => {
    const work = item({
      tenant_slug: 'tenant-a',
      organization_id: 'o',
      project_id: 'p',
      mission_id: 'MSN-X',
    });
    expect(
      workspaceWorkItemVisible(work, scope, {
        ...lookup,
        mission: () => ({ ...project, tier: 'personal' }),
      })
    ).toBe(false);
    expect(
      workspaceWorkItemVisible(work, scope, {
        ...lookup,
        mission: () => ({ ...project, tenant_slug: 'tenant-b' }),
      })
    ).toBe(false);
    expect(workspaceWorkItemVisible(work, scope, { ...lookup, mission: () => null })).toBe(false);
  });
  it('does not expose sibling owners or an org queue as operation-specific work', () => {
    const restricted = { ...scope, projectIds: ['p-allowed'] };
    expect(
      workspaceWorkItemVisible(
        item({ tenant_slug: 'tenant-a', project_id: 'p' }),
        restricted,
        lookup
      )
    ).toBe(false);
    expect(
      workspaceWorkItemVisible(
        item({ tenant_slug: 'tenant-a', project_id: 'p' }),
        { ...scope, selection: { ...scope.selection, kind: 'operation', operation_id: 'daily' } },
        lookup
      )
    ).toBe(false);
  });
});
