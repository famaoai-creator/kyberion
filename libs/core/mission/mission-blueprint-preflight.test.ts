import { afterEach, describe, expect, it } from 'vitest';
import { WorkCoordinationError } from '../workforce/work-coordination-error.js';
import {
  assertMissionBlueprintPreflight,
  missionBlueprintPreflightEnforced,
} from './mission-blueprint-preflight.js';

// W6: blocking blueprint preflight at the planner commit seam
// (persistPlanningPacket calls assertMissionBlueprintPreflight before any
// artifact is written). Opt-in via KYBERION_MISSION_BLUEPRINT_ENFORCE; the
// flag unset is a pure no-op so staged/partial board writes everywhere keep
// today's advisory-only behavior.

const savedEnforce = process.env.KYBERION_MISSION_BLUEPRINT_ENFORCE;

afterEach(() => {
  if (savedEnforce === undefined) delete process.env.KYBERION_MISSION_BLUEPRINT_ENFORCE;
  else process.env.KYBERION_MISSION_BLUEPRINT_ENFORCE = savedEnforce;
});

const task = (taskId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  task_id: taskId,
  status: 'planned',
  description: `deliver ${taskId}`,
  deliverable: `out/${taskId}.md`,
  acceptance_criteria: [`${taskId} exists`],
  dependencies: [],
  ...extra,
});

const cyclicBoard = [task('a', { dependencies: ['b'] }), task('b', { dependencies: ['a'] })];

describe('mission blueprint preflight (W6)', () => {
  describe('flag unset — advisory-only (default preserved)', () => {
    it('is not enforced and does not inspect the board', () => {
      delete process.env.KYBERION_MISSION_BLUEPRINT_ENFORCE;
      expect(missionBlueprintPreflightEnforced()).toBe(false);
      // Even a cyclic board passes untouched: staged/partial writes rely on
      // this default.
      expect(assertMissionBlueprintPreflight('MSN-T1', cyclicBoard)).toEqual([]);
      expect(assertMissionBlueprintPreflight('MSN-T1', 'not-even-an-array')).toEqual([]);
    });
  });

  describe('flag set — commit gate', () => {
    const arm = () => {
      process.env.KYBERION_MISSION_BLUEPRINT_ENFORCE = '1';
    };

    it('lets a valid board commit', () => {
      arm();
      const board = [task('a'), task('b', { dependencies: ['a'] })];
      expect(assertMissionBlueprintPreflight('MSN-T2', board)).toEqual([]);
    });

    it('refuses a cyclic board with the stable code in diagnostics', () => {
      arm();
      let thrown: unknown;
      try {
        assertMissionBlueprintPreflight('MSN-T3', cyclicBoard);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(WorkCoordinationError);
      const wcErr = thrown as WorkCoordinationError;
      expect(wcErr.code).toBe('validation_error');
      expect(wcErr.message).toContain('MISSION_DEPENDENCY_CYCLE');
      expect(wcErr.message).toContain('a -> b -> a');
      expect(Array.isArray(wcErr.details.findings)).toBe(true);
      const findings = wcErr.details.findings as Array<{ code: string }>;
      expect(findings.some((f) => f.code === 'MISSION_DEPENDENCY_CYCLE')).toBe(true);
    });

    it('refuses a dangling dependency', () => {
      arm();
      const board = [task('a', { dependencies: ['ghost'] })];
      expect(() => assertMissionBlueprintPreflight('MSN-T4', board)).toThrow(
        /MISSION_DEPENDENCY_MISSING/
      );
    });

    it('refuses a non-array blueprint', () => {
      arm();
      expect(() => assertMissionBlueprintPreflight('MSN-T5', { tasks: [] })).toThrow(
        /MISSION_TASKS_NOT_ARRAY/
      );
    });

    it('warnings stay non-blocking: missing deliverable/acceptance commit', () => {
      arm();
      const board = [
        { task_id: 'bare', status: 'planned', description: 'no deliverable', dependencies: [] },
      ];
      const findings = assertMissionBlueprintPreflight('MSN-T6', board);
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.every((f) => f.severity === 'warning')).toBe(true);
    });

    it('real-board lifecycle statuses are not false errors', () => {
      arm();
      const board = [
        task('t1', { status: 'requested' }),
        task('t2', { status: 'dispatched', dependencies: ['t1'] }),
        task('t3', { status: 'in_progress', dependencies: ['t2'] }),
        task('t4', { status: 'reviewed', dependencies: ['t3'] }),
        task('t5', { status: 'rework', dependencies: ['t4'] }),
        task('t6', { status: 'done', dependencies: ['t5'] }),
        task('t7', { status: 'accepted', dependencies: ['t6'] }),
      ];
      expect(assertMissionBlueprintPreflight('MSN-T7', board)).toEqual([]);
    });
  });
});
