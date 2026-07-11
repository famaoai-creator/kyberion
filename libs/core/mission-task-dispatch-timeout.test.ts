import { describe, expect, it } from 'vitest';
import {
  cascadeBlockedDependents,
  resolveTaskDispatchTimeoutMs,
} from './mission-orchestration-worker.js';

// MO-03 Task 2.3: scope-derived dispatch budgets and the blocked cascade.
describe('task dispatch timeout (MO-03)', () => {
  it('derives the budget from estimated_scope with an explicit override', () => {
    expect(resolveTaskDispatchTimeoutMs({ estimated_scope: 'S' })).toBe(10 * 60 * 1000);
    expect(resolveTaskDispatchTimeoutMs({})).toBe(30 * 60 * 1000); // default M
    expect(resolveTaskDispatchTimeoutMs({ estimated_scope: 'L' })).toBe(60 * 60 * 1000);
    expect(resolveTaskDispatchTimeoutMs({ estimated_scope: 'S', timeout_ms: 1234 })).toBe(1234);
  });

  it('cascades blocked status through transitive dependents', () => {
    const tasks = [
      { task_id: 'a', status: 'blocked', dependencies: [] },
      { task_id: 'b', status: 'planned', dependencies: ['a'] },
      { task_id: 'c', status: 'planned', dependencies: ['b'] },
      { task_id: 'd', status: 'planned', dependencies: [] },
      { task_id: 'e', status: 'completed', dependencies: ['a'] },
    ] as never[];

    const cascaded = cascadeBlockedDependents(tasks as never);
    expect(cascaded.sort()).toEqual(['b', 'c']);
    const byId = new Map(
      (tasks as Array<{ task_id: string; status: string }>).map((t) => [t.task_id, t.status])
    );
    expect(byId.get('b')).toBe('blocked');
    expect(byId.get('c')).toBe('blocked');
    expect(byId.get('d')).toBe('planned'); // independent task untouched
    expect(byId.get('e')).toBe('completed'); // terminal states untouched
  });

  it('returns empty when nothing is blocked', () => {
    const tasks = [
      { task_id: 'a', status: 'planned', dependencies: [] },
      { task_id: 'b', status: 'planned', dependencies: ['a'] },
    ] as never[];
    expect(cascadeBlockedDependents(tasks as never)).toEqual([]);
  });
});
