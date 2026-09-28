import { describe, expect, it } from 'vitest';
import { validatePlannedNextTasks } from './mission-orchestration-task-validation.js';

describe('goal-driven task drive contract', () => {
  it('preserves an explicit manual drive only for goal-driven tasks', () => {
    expect(
      validatePlannedNextTasks(
        [{ task_id: 'T-MANUAL', goal_driven: true, drive: 'manual' }],
        'MSN-DRIVE'
      )
    ).toEqual([
      {
        task_id: 'T-MANUAL',
        dependencies: [],
        acceptance_criteria: [],
        goal_driven: true,
        drive: 'manual',
      },
    ]);
  });

  it('rejects an invalid or non-goal-driven drive declaration', () => {
    expect(() =>
      validatePlannedNextTasks([{ task_id: 'T-INVALID', drive: 'sideways' }], 'MSN-DRIVE')
    ).toThrow('drive must be automatic or manual');
    expect(() =>
      validatePlannedNextTasks([{ task_id: 'T-SINGLE', drive: 'manual' }], 'MSN-DRIVE')
    ).toThrow('drive requires goal_driven=true');
  });
});
