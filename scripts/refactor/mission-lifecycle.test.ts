import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  pathResolver,
  safeExec,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
  transitionStatus,
} from '@agent/core';
import { finishMission } from './mission-lifecycle.js';

const missionId = 'MSN-LIFECYCLE-GATE-001';
const missionPath = pathResolver.missionDir(missionId, 'public');

function prepareMissionState(status: 'completed' | 'distilling' = 'completed'): void {
  const latestCommit = safeExec('git', ['rev-parse', 'HEAD'], {
    cwd: pathResolver.rootDir(),
  }).trim();
  if (!safeExistsSync(missionPath)) safeMkdir(missionPath, { recursive: true });
  safeWriteFile(
    `${missionPath}/mission-state.json`,
    JSON.stringify(
      {
        mission_id: missionId,
        tier: 'public',
        status,
        execution_mode: 'local',
        priority: 1,
        assigned_persona: 'tester',
        confidence_score: 1,
        git: {
          branch: 'test',
          start_commit: 'abc123',
          latest_commit: latestCommit,
          checkpoints: [],
        },
        history: [],
        context: {},
      },
      null,
      2
    )
  );
}

beforeEach(() => {
  if (!safeExistsSync(missionPath)) safeMkdir(missionPath, { recursive: true });
  process.env.MISSION_ROLE = 'mission_controller';
  process.env.KYBERION_PERSONA = 'worker';
});

afterEach(() => {
  safeRmSync(missionPath, { recursive: true, force: true });
});

describe('mission lifecycle finish gate', () => {
  it('keeps a mission in validating when pending tasks remain, then realigns on repeated failure', async () => {
    prepareMissionState('completed');
    safeWriteFile(
      `${missionPath}/NEXT_TASKS.json`,
      JSON.stringify(
        [
          {
            task_id: 'task-1',
            status: 'planned',
            assigned_to: { role: 'operator', agent_id: 'implementation-architect' },
            description: 'Close out the mission',
            deliverable: 'evidence/closeout.md',
            target_path: 'evidence/closeout.md',
          },
        ],
        null,
        2
      )
    );

    const args = {
      archiveDir: pathResolver.rootResolve('active/shared/tmp/mission-archives'),
      agentRuntimeEventPath: `${missionPath}/runtime-events.jsonl`,
      getGitHash: (cwd: string) => safeExec('git', ['rev-parse', 'HEAD'], { cwd }).trim(),
      sealMission: async () => undefined,
      syncProjectLedgerIfLinked: async () => undefined,
      transitionStatus,
    };

    await finishMission(missionId, false, args);
    let state = JSON.parse(
      safeReadFile(`${missionPath}/mission-state.json`, { encoding: 'utf8' }) as string
    );
    expect(state.status).toBe('validating');
    expect(state.context.mission_finish_gate_failure_count).toBe(1);

    await finishMission(missionId, false, args);
    state = JSON.parse(
      safeReadFile(`${missionPath}/mission-state.json`, { encoding: 'utf8' }) as string
    );
    expect(state.status).toBe('active');
    expect(state.context.mission_finish_gate_failure_count).toBe(2);
    expect(state.context.mission_finish_gate_last_reason).toContain('Pending tasks remain');
    expect(safeExistsSync(`${missionPath}/gates`)).toBe(true);
    const gateFiles = safeReaddir(`${missionPath}/gates`);
    expect(gateFiles.some((name: string) => name.startsWith('finish-exit-'))).toBe(true);
  });
});
