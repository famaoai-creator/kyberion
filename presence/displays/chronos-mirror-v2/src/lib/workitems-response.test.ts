import { describe, expect, it } from 'vitest';
import { parseWorkItemMutationResponse, parseWorkItemsResponse } from './workitems-response';

const item = {
  item_id: 'work-1',
  title: 'Prepare report',
  description: 'Prepare the report',
  status: 'ready',
  priority: 'high',
  source: 'mission',
  source_ref: 'mission:MSN-1',
  project_id: 'project-1',
  labels: ['mission:MSN-1'],
  dependencies: [],
  created_at: '2026-09-04T00:00:00.000Z',
  updated_at: '2026-09-04T00:00:00.000Z',
  context: { tenant_slug: 'tenant-a', mission_id: 'MSN-1' },
  metadata: { assigned_by: 'operator' },
};

const valid = {
  ok: true,
  statuses: ['backlog', 'ready', 'done'],
  items: [item],
  scope: 'work_items',
  view: 'all',
  quality: { explicit_context: 1, migrated_context: 0, missing_context: 0 },
  lineage: {
    hierarchy: ['tenant_slug', 'mission_id'],
    nodes: [{ key: 'tenant-a', kind: 'tenant_slug', id: 'tenant-a', item_count: 1 }],
    edges: [],
    total_items: 1,
    complete_chain_items: 1,
    incomplete_chain_items: 0,
    missing_by_kind: {},
  },
};

describe('work items response boundary', () => {
  it('accepts the work item projection and mutation response', () => {
    expect(parseWorkItemsResponse(valid)).toMatchObject({ ok: true, items: [item] });
    expect(parseWorkItemMutationResponse({ ok: true, item })).toEqual({ ok: true, item });
  });

  it.each([
    ['not ok', { ...valid, ok: false }],
    ['invalid status list', { ...valid, statuses: [1] }],
    ['invalid item', { ...valid, items: [{ ...item, labels: {} }] }],
    ['invalid quality', { ...valid, quality: { explicit_context: -1 } }],
    ['invalid lineage node', { ...valid, lineage: { ...valid.lineage, nodes: [{ key: 'x' }] } }],
    ['invalid mutation item', { ok: true, item: { ...item, updated_at: null } }],
    ['dangerous nested key', { ...valid, items: [{ ...item, metadata: { ['__proto__']: {} } }] }],
  ])('rejects %s', (_label, value) => {
    expect(parseWorkItemsResponse(value)).toBeUndefined();
  });
});
