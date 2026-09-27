import { describe, expect, it } from 'vitest';
import { buildWorkVisibilityProjection, resolveWorkItemContext } from './work-visibility.js';
import type { WorkItem } from './work-coordination.js';

function item(partial: Partial<WorkItem>): WorkItem {
  return {
    item_id: 'w1',
    title: 'task',
    description: 'task',
    status: 'ready',
    priority: 'normal',
    source: 'local',
    source_ref: 'w1',
    project_id: 'PROJECT-A',
    labels: [],
    dependencies: [],
    version: 1,
    created_at: '2026-08-04T00:00:00Z',
    updated_at: '2026-08-04T00:00:00Z',
    ...partial,
  };
}

describe('work-visibility', () => {
  it('resolves explicit context before legacy labels', () => {
    const resolved = resolveWorkItemContext(
      item({
        labels: ['mission:LEGACY'],
        context: { mission_id: 'MSN-EXPLICIT', tenant_slug: 'default' },
      })
    );
    expect(resolved).toMatchObject({
      mission_id: 'MSN-EXPLICIT',
      tenant_slug: 'default',
      source: 'explicit',
    });
  });

  it('makes legacy project-only work visible in the work-items and operations scopes', () => {
    const projection = buildWorkVisibilityProjection({
      items: [item({ labels: [] })],
      viewer: { tenantSlugs: 'all' },
      scope: 'operations',
      view: 'active',
    });
    expect(projection.items).toHaveLength(1);
    expect(projection.items[0]?.context.project_id).toBe('PROJECT-A');
    expect(projection.quality.migrated_context).toBe(0);
    expect(projection.quality.missing_context).toBe(0);
  });

  it('keeps terminal work in history but out of the home scope', () => {
    const items = [item({ item_id: 'active' }), item({ item_id: 'done', status: 'done' })];
    expect(
      buildWorkVisibilityProjection({
        items,
        viewer: { tenantSlugs: 'all' },
        scope: 'home',
      }).items.map((x) => x.item_id)
    ).toEqual(['active']);
    expect(
      buildWorkVisibilityProjection({
        items,
        viewer: { tenantSlugs: 'all' },
        view: 'history',
      }).items.map((x) => x.item_id)
    ).toEqual(['done']);
  });

  it('requires a viewer tenant scope and fails closed for an unauthorized tenant query', () => {
    const items = [
      item({ item_id: 'allowed', context: { tenant_slug: 'tenant-a' } }),
      item({ item_id: 'blocked', context: { tenant_slug: 'tenant-b' } }),
    ];
    expect(
      buildWorkVisibilityProjection({ items, viewer: { tenantSlugs: ['tenant-a'] } }).items.map(
        (entry) => entry.item_id
      )
    ).toEqual(['allowed']);
    expect(() =>
      buildWorkVisibilityProjection({
        items,
        viewer: { tenantSlugs: ['tenant-a'] },
        tenantSlug: 'tenant-b',
      })
    ).toThrow(/not authorized/);
  });

  it('projects the canonical scope lineage and reports missing links', () => {
    const projection = buildWorkVisibilityProjection({
      items: [
        item({
          context: {
            tenant_slug: 'tenant-a',
            organization_id: 'org-a',
            project_id: 'PROJECT-A',
            mission_id: 'MSN-A',
            task_id: 'TASK-A',
            work_shape: 'solution_project',
          },
        }),
        item({
          item_id: 'missing-org',
          context: {
            tenant_slug: 'tenant-a',
            project_id: 'PROJECT-A',
            work_shape: 'routine_operation',
          },
        }),
      ],
      viewer: { tenantSlugs: 'all' },
    });

    expect(projection.lineage).toMatchObject({
      hierarchy: ['tenant_slug', 'organization_id', 'project_id', 'mission_id', 'task_id'],
      total_items: 2,
      complete_chain_items: 1,
      incomplete_chain_items: 1,
      missing_by_kind: {
        tenant_slug: 0,
        organization_id: 1,
        project_id: 0,
        mission_id: 1,
        task_id: 1,
      },
    });
    expect(projection.lineage.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'tenant_slug:tenant-a', to: 'organization_id:org-a' }),
        expect.objectContaining({ from: 'organization_id:org-a', to: 'project_id:PROJECT-A' }),
      ])
    );
    expect(projection.lineage.edges).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'tenant_slug:tenant-a', to: 'project_id:PROJECT-A' }),
      ])
    );
  });
});
