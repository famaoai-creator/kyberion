import { describe, expect, it } from 'vitest';
import { validateTaskSourceWorkspace } from './task-tool-grant-validation.js';
import { validatePlannedNextTasks } from '../mission/mission-next-task-validation.js';

const grant = {
  version: 1,
  baseline_commit: 'a'.repeat(40),
  source_paths: ['libs/core/example.ts'],
};
describe('ordinary source workspace binding', () => {
  it('preserves the reviewed immutable binding through task progress validation', () => {
    expect(validateTaskSourceWorkspace(grant)).toEqual(grant);
    expect(
      validatePlannedNextTasks([{ task_id: 'implement', source_workspace: grant }], 'MSN-X')[0]
        .source_workspace
    ).toEqual(grant);
  });
  it.each([
    { ...grant, baseline_commit: 'main' },
    { ...grant, baseline_commit: 'A'.repeat(40) },
    { ...grant, version: 2 },
    { ...grant, source_paths: [] },
    { ...grant, source_paths: ['active/shared/tmp/source.ts'] },
    { ...grant, source_paths: ['libs/../private.ts'] },
    { ...grant, source_paths: Array.from({ length: 65 }, (_, n) => `libs/${n}.ts`) },
    { ...grant, command: 'publish' },
  ])('rejects malformed or broadened binding %#', (value) => {
    expect(() => validateTaskSourceWorkspace(value)).toThrow('TASK_SOURCE_WORKSPACE_INVALID');
  });
});
