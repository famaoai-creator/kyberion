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
});
