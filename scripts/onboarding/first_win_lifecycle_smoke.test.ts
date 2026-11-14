import { describe, expect, it, vi } from 'vitest';
import {
  buildFirstWinLifecycleLivePlan,
  findFirstWinLifecycleLiveConflicts,
  runFirstWinLifecycleLive,
  validateFirstWinLifecycleLiveOptions,
} from './first_win_lifecycle_smoke.js';

describe('First-Win lifecycle live acceptance guard', () => {
  it('requires an explicit identity, confirmation token, and write gate', () => {
    expect(
      validateFirstWinLifecycleLiveOptions({
        identityFile: '',
        runId: 'x',
        confirm: '',
        allowWrites: undefined,
      })
    ).toEqual([
      '--identity is required for live acceptance; the fixture is dry-run only',
      "--run-id must contain 3-64 letters, numbers, '.', '_' or '-'",
      '--confirm-live must equal FIRST-WIN-LIFECYCLE-LIVE',
      'KYBERION_FIRST_WIN_LIVE=1 is required for live acceptance',
    ]);
  });

  it('builds isolated governed identifiers from the supplied run id', () => {
    expect(
      buildFirstWinLifecycleLivePlan({
        identityFile: 'customer/demo/identity.json',
        runId: '20260809-a',
      })
    ).toEqual({
      identityFile: 'customer/demo/identity.json',
      runId: '20260809-a',
      organizationId: 'ORG-FIRST-WIN-20260809-A',
      projectId: 'PRJ-FIRST-WIN-20260809-A',
      missionId: 'MSN-FIRST-WIN-20260809-A',
      projectPath: 'active/shared/tmp/first-win-lifecycle/20260809-a',
    });
  });

  it('does not execute a write when the live guard is not satisfied', () => {
    const runner = vi.fn();
    const report = runFirstWinLifecycleLive(
      {
        identityFile: 'customer/demo/identity.json',
        runId: '20260809-a',
        confirm: '',
        allowWrites: undefined,
      },
      runner as never
    );

    expect(report.status).toBe('failed');
    expect(report.stages[0]?.detail).toContain('live guard rejected');
    expect(runner).not.toHaveBeenCalled();
  });

  it('stops before the next write when the first live stage fails', () => {
    const runner = vi.fn(() => ({ status: 1, stdout: '', stderr: 'onboarding failed' }));
    const report = runFirstWinLifecycleLive(
      {
        identityFile: 'knowledge/public/templates/onboarding/identity.example.json',
        runId: '20260809-a',
        confirm: 'FIRST-WIN-LIFECYCLE-LIVE',
        allowWrites: '1',
      },
      runner as never
    );

    expect(report.status).toBe('failed');
    expect(report.stages).toHaveLength(1);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('returns a failed JSON report when the identity preflight throws', () => {
    const report = runFirstWinLifecycleLive(
      {
        identityFile: 'knowledge/public/templates/onboarding/identity.example.json',
        runId: '20260809-a',
        confirm: 'FIRST-WIN-LIFECYCLE-LIVE',
        allowWrites: '1',
      },
      vi.fn(() => {
        throw new Error('policy denied');
      }) as never
    );

    expect(report.status).toBe('failed');
    expect(report.stages[0]?.detail).toContain('raised an exception');
  });

  it('rejects reused governed identifiers before invoking any writer', () => {
    const plan = buildFirstWinLifecycleLivePlan({
      identityFile: 'knowledge/public/templates/onboarding/identity.example.json',
      runId: '20260809-c',
    });
    const runner = vi.fn();
    const report = runFirstWinLifecycleLive(
      {
        identityFile: plan.identityFile,
        runId: plan.runId,
        confirm: 'FIRST-WIN-LIFECYCLE-LIVE',
        allowWrites: '1',
      },
      runner as never,
      {
        organization: vi.fn(() => ({ organization_id: plan.organizationId }) as never),
      }
    );

    expect(report.status).toBe('failed');
    expect(report.stages[0]?.detail).toContain('run-id collision');
    expect(report.stages[0]?.detail).toContain(plan.organizationId);
    expect(runner).not.toHaveBeenCalled();
  });

  it('reports every conflicting live resource in the preflight result', () => {
    const plan = buildFirstWinLifecycleLivePlan({
      identityFile: 'knowledge/public/templates/onboarding/identity.example.json',
      runId: '20260809-d',
    });

    expect(
      findFirstWinLifecycleLiveConflicts(plan, {
        organization: vi.fn(() => ({ organization_id: plan.organizationId }) as never),
        project: vi.fn(() => ({ project_id: plan.projectId }) as never),
        mission: vi.fn(() => ({ mission_id: plan.missionId }) as never),
        projectPath: vi.fn(() => true),
      })
    ).toEqual([
      `organization ${plan.organizationId} already exists`,
      `project ${plan.projectId} already exists`,
      `mission ${plan.missionId} already exists`,
      `project path ${plan.projectPath} already exists`,
    ]);
  });
});

describe('First-Win lifecycle live acceptance runner', () => {
  it('executes the governed lifecycle sequence and reports the run id', () => {
    const identityFile = 'knowledge/public/templates/onboarding/identity.example.json';
    const plan = buildFirstWinLifecycleLivePlan({
      identityFile,
      runId: '20260809-a',
    });
    const runner = vi.fn((command: string, args: string[]) => {
      if (args.some((arg) => arg.endsWith('onboarding_apply.js'))) {
        return {
          status: 0,
          stdout: JSON.stringify({ status: 'complete', agent_id: 'KYBERION-PRIME' }),
        };
      }
      if (args.some((arg) => arg.endsWith('organization_operating_model.js'))) {
        return { status: 0, stdout: JSON.stringify({ mode: 'apply', saved_paths: ['state'] }) };
      }
      if (args.some((arg) => arg.endsWith('project_controller.js'))) {
        return { status: 0, stdout: JSON.stringify({ project_id: plan.projectId }) };
      }
      if (args.includes('pipelines/first-win-lifecycle-weekly.json')) {
        return { status: 0, stdout: JSON.stringify({ status: 'passed' }) };
      }
      if (args.includes('create')) {
        return { status: 0, stdout: `Mission ${plan.missionId} initialized in personal tier.` };
      }
      if (args.includes('start')) {
        return { status: 0, stdout: `Mission ${plan.missionId} is now ACTIVE.` };
      }
      if (args.includes('verify')) {
        return { status: 0, stdout: `Mission ${plan.missionId} verification complete.` };
      }
      if (args.includes('distill')) {
        return { status: 0, stdout: `Wisdom distilled for ${plan.missionId}.` };
      }
      if (args.includes('finish')) {
        return { status: 0, stdout: `Mission ${plan.missionId} archived and finalized.` };
      }
      return { status: 0, stdout: `completed ${plan.missionId}` };
    });
    const missionStatuses = ['planned', 'active', 'distilling', 'completed', 'archived'];
    const missionState = vi.fn(
      () =>
        ({
          mission_id: plan.missionId,
          status: missionStatuses.shift(),
        }) as never
    );

    const report = runFirstWinLifecycleLive(
      {
        identityFile,
        runId: '20260809-a',
        confirm: 'FIRST-WIN-LIFECYCLE-LIVE',
        allowWrites: '1',
      },
      runner as never,
      { missionState }
    );

    expect(report).toMatchObject({ mode: 'live', run_id: '20260809-a', status: 'passed' });
    expect(report.stages.some((stage) => stage.detail.startsWith('mission finished'))).toBe(true);
    expect(runner).toHaveBeenCalled();
    expect(runner.mock.calls.some(([, args]) => args.includes('--dry-run'))).toBe(false);
    expect(
      runner.mock.calls
        .filter(([, args]) => args.includes('dist/scripts/mission_controller.js'))
        .map(([, args]) => args[1])
    ).toEqual(['create', 'start', 'verify', 'distill', 'finish']);
  });

  it('rejects a zero-exit mission error instead of reporting live success', () => {
    const identityFile = 'knowledge/public/templates/onboarding/identity.example.json';
    const runner = vi.fn((command: string, args: string[]) => {
      if (args.some((arg) => arg.endsWith('onboarding_apply.js')))
        return {
          status: 0,
          stdout: JSON.stringify({ status: 'complete', agent_id: 'KYBERION-PRIME' }),
        };
      if (args.some((arg) => arg.endsWith('organization_operating_model.js')))
        return { status: 0, stdout: JSON.stringify({ mode: 'apply', saved_paths: ['state'] }) };
      if (args.some((arg) => arg.endsWith('project_controller.js')))
        return { status: 0, stdout: JSON.stringify({ project_id: 'PRJ-FIRST-WIN-20260809-B' }) };
      if (args.includes('create'))
        return {
          status: 0,
          stdout: 'Mission MSN-FIRST-WIN-20260809-B initialized in personal tier.',
        };
      if (args.includes('start'))
        return { status: 0, stdout: 'Mission MSN-FIRST-WIN-20260809-B is now ACTIVE.' };
      if (args.includes('verify'))
        return { status: 0, stdout: 'Mission MSN-FIRST-WIN-20260809-B verification complete.' };
      if (args.includes('distill'))
        return {
          status: 0,
          stdout: '❌ Cannot distill mission MSN-FIRST-WIN-20260809-B (status: active).',
        };
      return { status: 0, stdout: 'Mission MSN-FIRST-WIN-20260809-B archived and finalized.' };
    });
    const missionStatuses = ['planned', 'active', 'distilling'];
    const missionState = vi.fn(
      () =>
        ({
          mission_id: 'MSN-FIRST-WIN-20260809-B',
          status: missionStatuses.shift(),
        }) as never
    );

    const report = runFirstWinLifecycleLive(
      {
        identityFile,
        runId: '20260809-b',
        confirm: 'FIRST-WIN-LIFECYCLE-LIVE',
        allowWrites: '1',
      },
      runner as never,
      { missionState }
    );

    expect(report.status).toBe('failed');
    expect(report.stages.at(-1)?.detail).toContain('mission distilled');
    expect(runner.mock.calls.some(([, args]) => args.includes('finish'))).toBe(false);
  });
});
