import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as pathResolver from '../path-resolver.js';
import { safeMkdir, safeReadFile, safeRmSync } from '../secure-io.js';
import { writeMissionNextTasks } from './mission-lifecycle-completion.js';

const missionId = 'MSN-BOARD-VALIDATION-TEST';
const missionPath = pathResolver.missionDir(missionId, 'public');

function boardOnDisk(): Array<Record<string, unknown>> {
  return JSON.parse(
    String(safeReadFile(nodePath.join(missionPath, 'NEXT_TASKS.json'), { encoding: 'utf8' }))
  ) as Array<Record<string, unknown>>;
}

function captureStderr() {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  return { lines, restore: () => spy.mockRestore() };
}

const validTask = {
  task_id: 't1',
  status: 'planned',
  deliverable: 'evidence/t1.md',
  acceptance_criteria: ['done'],
};

let previousMissionRole: string | undefined;
let previousPersona: string | undefined;

beforeEach(() => {
  previousMissionRole = process.env.MISSION_ROLE;
  previousPersona = process.env.KYBERION_PERSONA;
  process.env.MISSION_ROLE = 'mission_controller';
  process.env.KYBERION_PERSONA = 'board-validation-test-actor';
  safeRmSync(missionPath, { recursive: true, force: true });
  safeMkdir(missionPath, { recursive: true });
});

afterEach(() => {
  safeRmSync(missionPath, { recursive: true, force: true });
  if (previousMissionRole === undefined) delete process.env.MISSION_ROLE;
  else process.env.MISSION_ROLE = previousMissionRole;
  if (previousPersona === undefined) delete process.env.KYBERION_PERSONA;
  else process.env.KYBERION_PERSONA = previousPersona;
});

describe('blueprint validation at the NEXT_TASKS write boundary', () => {
  it('surfaces a dependency cycle without blocking the write', () => {
    const stderr = captureStderr();
    let written: boolean;
    try {
      written = writeMissionNextTasks(missionPath, [
        { ...validTask, task_id: 'a', dependencies: ['b'] },
        { ...validTask, task_id: 'b', dependencies: ['a'] },
      ]);
    } finally {
      stderr.restore();
    }
    expect(written).toBe(true);
    const output = stderr.lines.join('');
    expect(output).toContain('MISSION_DEPENDENCY_CYCLE');
    expect(output).toContain('not blocked');
    expect(boardOnDisk()).toHaveLength(2);
  });

  it('surfaces duplicate task ids without blocking the write', () => {
    const stderr = captureStderr();
    try {
      expect(writeMissionNextTasks(missionPath, [validTask, { ...validTask }])).toBe(true);
    } finally {
      stderr.restore();
    }
    expect(stderr.lines.join('')).toContain('MISSION_TASK_ID_DUPLICATE');
    expect(boardOnDisk()).toHaveLength(2);
  });

  it('surfaces a missing dependency reference without blocking the write', () => {
    const stderr = captureStderr();
    try {
      expect(
        writeMissionNextTasks(missionPath, [
          validTask,
          { ...validTask, task_id: 't2', dependencies: ['ghost'] },
        ])
      ).toBe(true);
    } finally {
      stderr.restore();
    }
    expect(stderr.lines.join('')).toContain('MISSION_DEPENDENCY_MISSING');
  });

  it('emits no blueprint violations for a valid board', () => {
    const stderr = captureStderr();
    try {
      expect(
        writeMissionNextTasks(missionPath, [
          validTask,
          { ...validTask, task_id: 't2', dependencies: ['t1'] },
        ])
      ).toBe(true);
    } finally {
      stderr.restore();
    }
    const output = stderr.lines.join('');
    expect(output).not.toContain('blueprint');
    expect(output).not.toContain('MISSION_');
    expect(boardOnDisk()).toHaveLength(2);
  });

  it('keeps warning-severity findings off the advisory surface', () => {
    const stderr = captureStderr();
    try {
      expect(writeMissionNextTasks(missionPath, [{ task_id: 'w', status: 'planned' }])).toBe(true);
    } finally {
      stderr.restore();
    }
    // Missing deliverable/acceptance_criteria are warnings: debug-level only.
    expect(stderr.lines.join('')).not.toContain('MISSION_DELIVERABLE_MISSING');
  });
});
