import { describe, expect, it } from 'vitest';
import { parseMissionNextTaskRecords } from '@agent/core/mission/mission-next-task-reader';
import { fileURLToPath } from 'node:url';
import { safeReadFile } from '@agent/core/secure-io';
import {
  GENERATION_SCHEDULE_WORKER_SCRIPT,
  collectActiveMissions,
  dispatchGenerationScheduleWorker,
  runScheduleQuickAction,
} from './chronos-quick-action-helpers';

function makeCore(state: unknown, nextTasks: unknown) {
  const missionId = 'MSN-QUICK-ACTION';
  const core = {
    pathResolver: {
      active: (relativePath: string) => `/repo/active/${relativePath}`,
    },
    assertSafeRepositoryPath: (filePath: string) => filePath,
    safeExistsSync: () => true,
    safeLstat: (filePath: string) => ({
      isDirectory: () => !filePath.endsWith('.json') && !filePath.endsWith('PLAN.md'),
      isFile: () => filePath.endsWith('.json') || filePath.endsWith('PLAN.md'),
    }),
    safeReaddir: (directoryPath: string) =>
      directoryPath.endsWith('/missions/public') ? [missionId] : [],
    loadStateAtPath: (filePath: string) =>
      (filePath.endsWith('mission-state.json') && state && typeof state === 'object'
        ? state
        : null) as never,
    loadMissionNextTaskRecordsAtPath: () => parseMissionNextTaskRecords(nextTasks),
    safeExecResult: () => ({ status: 0 }),
  };
  return core;
}

describe('chronos quick action mission projection', () => {
  it('ignores primitive and array mission state', () => {
    expect(collectActiveMissions(makeCore([], []))).toEqual([]);
  });

  it('narrows mission fields before exposing a quick-action projection', () => {
    expect(
      collectActiveMissions(
        makeCore(
          {
            mission_id: 'MSN-VALID',
            status: 'active',
            tier: 'confidential',
            mission_type: 'delivery',
            git: { checkpoints: [{ id: 'checkpoint-1' }] },
            execution_mode: 'local',
            priority: 1,
            assigned_persona: 'operator',
            confidence_score: 1,
            history: [],
          },
          [{ status: 'planned' }, { status: 'completed' }]
        )
      )
    ).toEqual([
      {
        missionId: 'MSN-VALID',
        status: 'active',
        tier: 'confidential',
        missionType: 'delivery',
        checkpoints: 1,
        nextTaskCount: 2,
        planReady: true,
      },
    ]);
  });

  it('does not count malformed NEXT_TASKS entries in the quick-action projection', () => {
    const mission = collectActiveMissions(
      makeCore(
        {
          mission_id: 'MSN-MALFORMED-TASKS',
          status: 'active',
          tier: 'public',
          git: { checkpoints: [] },
        },
        [{ task_id: 'task-1', status: 'planned' }, { task_id: 42 }]
      )
    )[0];

    expect(mission?.nextTaskCount).toBe(0);
  });
});

describe('schedule quick action (D3 governed worker dispatch)', () => {
  it('runs the governed schedule CLI as SYSTEM_ROLE=generation_schedule and audits it', async () => {
    const calls: Array<{ command: string; args: string[]; env: Record<string, unknown> }> = [];
    const audits: unknown[] = [];
    const result = await dispatchGenerationScheduleWorker('tick', {
      run: async (command, args, options) => {
        calls.push({ command, args, env: options.env });
        return { stdout: '{"ticked":1}', stderr: '', status: 0 };
      },
      audit: (entry) => audits.push(entry),
    });
    expect(result).toEqual({ ticked: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('node');
    expect(calls[0]!.args).toEqual([
      GENERATION_SCHEDULE_WORKER_SCRIPT,
      '--action',
      'tick',
      '--json',
    ]);
    // A new SYSTEM_ROLE, with the launcher's own delegation and mission role cleared.
    expect(calls[0]!.env).toMatchObject({
      SYSTEM_ROLE: 'generation_schedule',
      KYBERION_DELEGATED_ROLE: '',
      MISSION_ROLE: '',
    });
    expect(audits).toEqual([{ action: 'tick', result: 'completed' }]);
  });

  it('never assumes the scheduler authority in-process and reports a failed worker', async () => {
    const audits: Array<{ result: string }> = [];
    const outcome = await runScheduleQuickAction('list', 'en', {
      run: async () => ({ stdout: '', stderr: 'boom', status: 1 }),
      audit: (entry) => audits.push(entry),
    });
    expect(outcome.status).toBe('warning');
    expect(audits).toEqual([{ action: 'list', result: 'failed', reason: 'boom' }]);
    const source = String(
      safeReadFile(fileURLToPath(new URL('./chronos-quick-action-helpers.ts', import.meta.url)), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toContain("import('@agent/core/generation-scheduler')");
  });
});

describe('schedule dispatch audit (M2)', () => {
  it('audits the viewer principal, a worker that cannot start, and a timeout as unconfirmed', async () => {
    const audits: Array<Record<string, unknown>> = [];
    const audit = (entry: Record<string, unknown>) => audits.push(entry);
    await dispatchGenerationScheduleWorker(
      'list',
      { run: async () => ({ stdout: '[]', stderr: '', status: 0 }), audit },
      'human:owner'
    );
    expect(audits[0]).toEqual({ action: 'list', result: 'completed', actor: 'human:owner' });

    await expect(
      dispatchGenerationScheduleWorker(
        'tick',
        {
          run: () => {
            throw new Error('spawn ENOENT');
          },
          audit,
        },
        'human:owner'
      )
    ).rejects.toThrow('spawn ENOENT');
    expect(audits[1]).toMatchObject({ action: 'tick', result: 'failed', actor: 'human:owner' });

    await expect(
      dispatchGenerationScheduleWorker(
        'tick',
        { run: async () => ({ stdout: '', stderr: '', status: null }), audit },
        'human:owner'
      )
    ).rejects.toThrow(/unconfirmed/);
    expect(audits[2]).toMatchObject({ result: 'error', outcome: 'unconfirmed' });
  });
});
