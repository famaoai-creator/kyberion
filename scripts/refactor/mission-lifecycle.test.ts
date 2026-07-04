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

function prepareMissionState(
  status: 'completed' | 'distilling' = 'completed',
  outcomeContract?: {
    requested_result: string;
    success_criteria: string[];
    deliverable_kind: string;
    evidence_required: boolean;
    expected_artifacts: Array<{ kind: string; storage_class: string }>;
    verification_method: 'self_check' | 'review_gate' | 'human_acceptance' | 'test';
  }
): void {
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
        ...(outcomeContract ? { outcome_contract: outcomeContract } : {}),
      },
      null,
      2
    )
  );
}

function seedMissionEvidence(fileName: string, contents: string): void {
  const evidenceDir = `${missionPath}/evidence`;
  if (!safeExistsSync(evidenceDir)) safeMkdir(evidenceDir, { recursive: true });
  safeWriteFile(`${evidenceDir}/${fileName}`, contents);
}

beforeEach(() => {
  if (!safeExistsSync(missionPath)) safeMkdir(missionPath, { recursive: true });
  process.env.MISSION_ROLE = 'mission_controller';
  process.env.KYBERION_PERSONA = 'worker';
});

afterEach(() => {
  safeRmSync(pathResolver.rootResolve(`active/shared/tmp/mission-archives/${missionId}`));
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
    const nextTasksAfterFirstFailure = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    );
    expect(
      nextTasksAfterFirstFailure.some((task: any) => task.task_id === 'repair-finish-exit')
    ).toBe(true);

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
    const nextTasksAfterSecondFailure = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    );
    expect(
      nextTasksAfterSecondFailure.filter((task: any) => task.task_id === 'repair-finish-exit')
    ).toHaveLength(1);
  });

  it('records a completion reconciliation summary when finish succeeds', async () => {
    prepareMissionState('completed', {
      requested_result: 'Mission closeout complete.',
      success_criteria: ['The closeout note is saved'],
      deliverable_kind: 'markdown',
      evidence_required: true,
      expected_artifacts: [{ kind: 'markdown', storage_class: 'mission' }],
      verification_method: 'self_check',
    });
    seedMissionEvidence('closeout.md', '# Closeout\nMission closeout complete.');
    safeWriteFile(
      `${missionPath}/NEXT_TASKS.json`,
      JSON.stringify(
        [
          {
            task_id: 'task-1',
            status: 'completed',
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

    const state = JSON.parse(
      safeReadFile(`${missionPath}/mission-state.json`, { encoding: 'utf8' }) as string
    );
    expect(state.status).toBe('archived');
    expect(state.context.mission_completion_summary).toMatchObject({
      requested_result: 'The closeout note is saved',
      satisfied: true,
      next_step: expect.stringContaining('Proceed with archival'),
    });
    expect(state.context.mission_completion_next_action).toMatchObject({
      title: 'Completion confirmed',
      satisfied: true,
      evidence_refs: expect.arrayContaining([`${missionPath}/evidence/closeout.md`]),
    });
  });

  it('creates a repair task when finish quality validation fails', async () => {
    prepareMissionState('completed', {
      requested_result: 'Mission closeout complete.',
      success_criteria: ['The closeout note is saved'],
      deliverable_kind: 'markdown',
      evidence_required: true,
      expected_artifacts: [{ kind: 'markdown', storage_class: 'mission' }],
      verification_method: 'self_check',
    });
    seedMissionEvidence('closeout.md', '# Closeout\nMission closeout complete.');
    safeWriteFile(
      `${missionPath}/NEXT_TASKS.json`,
      JSON.stringify(
        [
          {
            task_id: 'task-1',
            status: 'completed',
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
    const state = JSON.parse(
      safeReadFile(`${missionPath}/mission-state.json`, { encoding: 'utf8' }) as string
    );
    state.git.latest_commit = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    safeWriteFile(`${missionPath}/mission-state.json`, JSON.stringify(state, null, 2));

    const args = {
      archiveDir: pathResolver.rootResolve('active/shared/tmp/mission-archives'),
      agentRuntimeEventPath: `${missionPath}/runtime-events.jsonl`,
      getGitHash: (cwd: string) => safeExec('git', ['rev-parse', 'HEAD'], { cwd }).trim(),
      sealMission: async () => undefined,
      syncProjectLedgerIfLinked: async () => undefined,
      transitionStatus,
    };

    await finishMission(missionId, false, args);

    const updatedState = JSON.parse(
      safeReadFile(`${missionPath}/mission-state.json`, { encoding: 'utf8' }) as string
    );
    expect(updatedState.status).toBe('validating');
    expect(updatedState.context.mission_finish_gate_last_reason).toContain('latest_commit');
    const nextTasks = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    );
    expect(nextTasks.some((task: any) => task.task_id === 'repair-finish-quality')).toBe(true);
    expect(safeExistsSync(`${missionPath}/gates`)).toBe(true);
    const gateFiles = safeReaddir(`${missionPath}/gates`);
    expect(gateFiles.some((name: string) => name.startsWith('finish-quality-'))).toBe(true);
  });
});
