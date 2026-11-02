import { describe, expect, it } from 'vitest';
import {
  missionBlueprintHasErrors,
  validateMissionBlueprint,
} from './mission-blueprint-validation.js';

const validTask = {
  task_id: 't1',
  status: 'planned',
  deliverable: 'evidence/out.json',
  acceptance_criteria: 'done',
};

describe('validateMissionBlueprint', () => {
  it('accepts a valid task list', () => {
    const messages = validateMissionBlueprint([
      validTask,
      { ...validTask, task_id: 't2', dependencies: ['t1'] },
    ]);
    expect(messages).toEqual([]);
  });

  it('rejects non-array payloads', () => {
    const messages = validateMissionBlueprint({ tasks: [] });
    expect(messages).toEqual([
      expect.objectContaining({ severity: 'error', code: 'MISSION_TASKS_NOT_ARRAY' }),
    ]);
  });

  it('flags missing and duplicate task_ids', () => {
    const messages = validateMissionBlueprint([{ status: 'planned' }, validTask, validTask]);
    const codes = messages.map((m) => m.code);
    expect(codes).toContain('MISSION_TASK_ID_REQUIRED');
    expect(codes).toContain('MISSION_TASK_ID_DUPLICATE');
    expect(missionBlueprintHasErrors(messages)).toBe(true);
  });

  it('flags unknown dependency targets', () => {
    const messages = validateMissionBlueprint([
      validTask,
      { ...validTask, task_id: 't2', dependencies: ['ghost'] },
    ]);
    expect(messages).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'MISSION_DEPENDENCY_MISSING',
        subject_id: 't2',
      }),
    ]);
  });

  it('detects dependency cycles', () => {
    const messages = validateMissionBlueprint([
      { ...validTask, task_id: 'a', dependencies: ['c'] },
      { ...validTask, task_id: 'b', dependencies: ['a'] },
      { ...validTask, task_id: 'c', dependencies: ['b'] },
    ]);
    const cycle = messages.find((m) => m.code === 'MISSION_DEPENDENCY_CYCLE');
    expect(cycle).toBeDefined();
    expect(cycle?.severity).toBe('error');
    expect(cycle?.message).toContain('->');
    expect(missionBlueprintHasErrors(messages)).toBe(true);
  });

  it('does not flag a diamond dependency graph', () => {
    const messages = validateMissionBlueprint([
      validTask,
      { ...validTask, task_id: 'b', dependencies: ['t1'] },
      { ...validTask, task_id: 'c', dependencies: ['t1'] },
      { ...validTask, task_id: 'd', dependencies: ['b', 'c'] },
    ]);
    expect(messages.filter((m) => m.severity === 'error')).toEqual([]);
  });

  it('collects all errors instead of throwing on the first', () => {
    const messages = validateMissionBlueprint([
      { status: 'bogus' },
      { task_id: 'x', dependencies: ['nope'] },
    ]);
    const codes = new Set(messages.map((m) => m.code));
    expect(codes.has('MISSION_TASK_ID_REQUIRED')).toBe(true);
    expect(codes.has('MISSION_TASK_STATUS_INVALID')).toBe(true);
    expect(codes.has('MISSION_DEPENDENCY_MISSING')).toBe(true);
    expect(codes.has('MISSION_DELIVERABLE_MISSING')).toBe(true);
  });

  it('warns on missing deliverable and acceptance_criteria', () => {
    const messages = validateMissionBlueprint([{ task_id: 'w', status: 'planned' }]);
    expect(messages).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'MISSION_DELIVERABLE_MISSING' }),
      expect.objectContaining({ severity: 'warning', code: 'MISSION_ACCEPTANCE_MISSING' }),
    ]);
    expect(missionBlueprintHasErrors(messages)).toBe(false);
  });
});
