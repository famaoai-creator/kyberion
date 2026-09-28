import { describe, expect, it } from 'vitest';
import { buildWorkGraph } from './work-graph.js';
import type { WorkItem } from './work-coordination.js';

function item(
  itemId: string,
  taskId: string,
  status: WorkItem['status'],
  dependencies: string[] = []
): WorkItem {
  return {
    item_id: itemId,
    title: taskId,
    description: taskId,
    status,
    priority: 'normal',
    source: 'local',
    source_ref: `mission:M1:${taskId}`,
    project_id: 'M1',
    labels: [],
    dependencies,
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    metadata: { task_id: taskId },
  };
}

describe('work graph projection', () => {
  it('resolves task-id dependencies and exposes ready successors', () => {
    const graph = buildWorkGraph(
      [item('i1', 'prepare', 'done'), item('i2', 'ship', 'ready', ['prepare'])],
      'M1'
    );
    expect(graph.valid).toBe(true);
    expect(graph.edges).toEqual([{ from_item_id: 'i1', to_item_id: 'i2', dependency: 'prepare' }]);
    expect(graph.ready_item_ids).toEqual(['i2']);
  });

  it('diagnoses missing and blocked dependencies', () => {
    const graph = buildWorkGraph(
      [item('i1', 'ship', 'ready', ['missing']), item('i2', 'qa', 'ready', ['ship'])],
      'M1'
    );
    expect(graph.valid).toBe(false);
    expect(graph.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['missing_dependency']);
    expect(graph.ready_item_ids).toEqual([]);
    const blocked = buildWorkGraph(
      [item('i1', 'ship', 'blocked'), item('i2', 'qa', 'ready', ['ship'])],
      'M1'
    );
    expect(blocked.blocked_item_ids).toEqual(['i1', 'i2']);
  });

  it('detects dependency cycles', () => {
    const graph = buildWorkGraph(
      [item('i1', 'a', 'ready', ['b']), item('i2', 'b', 'ready', ['a'])],
      'M1'
    );
    expect(graph.diagnostics.some((diagnostic) => diagnostic.code === 'cycle')).toBe(true);
    expect(graph.valid).toBe(false);
  });
});
