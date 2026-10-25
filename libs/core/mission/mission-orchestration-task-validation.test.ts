import { describe, expect, it } from 'vitest';
import { validatePlannedNextTasks } from './mission-orchestration-task-validation.js';

describe('goal-driven task drive contract', () => {
  it('preserves owner-authored tool grants across validation and progress round trips', () => {
    for (const approval of [true, false]) {
      const raw = [
        {
          task_id: 'T-GRANTS',
          source_edit_paths: ['libs/core/example.ts'],
          source_edit_requires_approval: approval,
          allowed_pipelines: ['pipelines/baseline-check.json'],
        },
      ];
      const validated = validatePlannedNextTasks(raw, 'MSN-GRANTS');
      const rewritten = JSON.parse(
        JSON.stringify(validated.map((task) => ({ ...task, status: 'completed' })))
      );
      expect(validatePlannedNextTasks(rewritten, 'MSN-GRANTS')[0]).toMatchObject({
        ...raw[0],
        status: 'completed',
      });
    }
  });

  it.each([
    { source_edit_paths: 'libs/core/example.ts' },
    { source_edit_paths: [123] },
    { source_edit_paths: ['knowledge/personal/secret.md'] },
    { source_edit_paths: ['libs/../secret'] },
    { source_edit_requires_approval: 'false' },
    { allowed_pipelines: ['../unsafe.json'] },
    { allowed_pipelines: ['pipelines/../unsafe.json'] },
    { allowed_pipelines: true },
  ])('rejects malformed tool grants without widening authority: %j', (grant) => {
    expect(() =>
      validatePlannedNextTasks([{ task_id: 'T-GRANTS', ...grant }], 'MSN-GRANTS')
    ).toThrow();
  });
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
