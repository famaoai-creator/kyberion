import { describe, expect, it } from 'vitest';
import { summarizeNextTasks } from './mission-progress';

describe('mission progress next-task summary', () => {
  it('counts a superseded task as closed, apart from completed and pending', () => {
    expect(
      summarizeNextTasks([
        { task_id: 'old', status: 'superseded' },
        { task_id: 'new', status: 'completed' },
        { task_id: 'after', status: 'planned' },
        { task_id: 'implicit' },
      ])
    ).toEqual({
      nextTasksTotal: 4,
      nextTasksPending: 2,
      nextTasksCompleted: 1,
      nextTasksSuperseded: 1,
    });
  });
});
