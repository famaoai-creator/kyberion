import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E2E-03 Task 6: code_change missions collaborate PR-style — implement work is
 * committed to the mission micro-repo (task/<id> branch), diff.patch + PR.md
 * land under evidence/prs/, the review prompt carries the diff, and a
 * code_change plan without a review task is a planner contract violation.
 */

const mocks = vi.hoisted(() => ({
  route: vi.fn(),
  ensureMissionTeamRuntimeViaSupervisor: vi.fn(),
  resolveMissionTeamPlan: vi.fn(),
  resolveMissionTeamReceiver: vi.fn(),
  record: vi.fn(),
  emitMissionTaskEvent: vi.fn(),
}));

function makeTaskResultText(input: {
  summary: string;
  gaps?: string[];
  review_findings?: Array<{
    severity: 'must_fix' | 'should_fix' | 'nit';
    location: string;
    instruction: string;
  }>;
}): string {
  return [
    '```task_result',
    JSON.stringify({
      summary: input.summary,
      artifacts: [{ path: 'deliverables/change.md', kind: 'markdown' }],
      verification_done: ['checked'],
      gaps: input.gaps || [],
      needs: [],
      ...(input.review_findings ? { review_findings: input.review_findings } : {}),
    }),
    '```',
  ].join('\n');
}

vi.mock('../libs/core/a2a-bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../libs/core/a2a-bridge.js')>();
  return { ...actual, a2aBridge: { ...actual.a2aBridge, route: mocks.route } };
});
vi.mock('../libs/core/agent-runtime-supervisor.js', () => ({
  ensureMissionTeamRuntimeViaSupervisor: mocks.ensureMissionTeamRuntimeViaSupervisor,
}));
vi.mock('../libs/core/mission-team-plan-composer.js', () => ({
  resolveMissionTeamPlan: mocks.resolveMissionTeamPlan,
  resolveMissionTeamReceiver: mocks.resolveMissionTeamReceiver,
}));
vi.mock('../libs/core/ledger.js', () => ({ ledger: { record: mocks.record } }));
vi.mock('../libs/core/mission-task-events.js', () => ({
  emitMissionTaskEvent: mocks.emitMissionTaskEvent,
}));

const MISSION = 'MSN-CODECHG-01';

async function seedMission(options: { withReviewTask: boolean }): Promise<string> {
  const { missionDir } = await import('../libs/core/path-resolver.js');
  const { safeMkdir, safeWriteFile, safeExec } = await import('../libs/core/secure-io.js');
  const missionPath = missionDir(MISSION, 'public');
  safeMkdir(missionPath, { recursive: true });
  safeMkdir(`${missionPath}/deliverables`, { recursive: true });
  safeWriteFile(`${missionPath}/deliverables/change.md`, '# change v1');
  safeWriteFile(
    `${missionPath}/TASK_BOARD.md`,
    ['# TASK_BOARD: ' + MISSION, '', '## Status: Planning Ready', ''].join('\n')
  );
  safeWriteFile(
    `${missionPath}/mission-state.json`,
    JSON.stringify({
      mission_id: MISSION,
      tier: 'public',
      status: 'active',
      classification: { mission_class: 'code_change', risk_profile: 'standard' },
      outcome_contract: {
        outcome_id: 'outcome-1',
        requested_result: 'Ship the login change safely',
        success_criteria: ['review approves the change'],
      },
      git: { branch: 'main', start_commit: '', latest_commit: '', checkpoints: [] },
      history: [],
      relationships: {},
    })
  );
  // mission micro-repo
  safeExec('git', ['init', '-q'], { cwd: missionPath });
  safeExec('git', ['config', 'user.email', 'test@kyberion.local'], { cwd: missionPath });
  safeExec('git', ['config', 'user.name', 'kyberion-test'], { cwd: missionPath });
  safeExec('git', ['add', '-A'], { cwd: missionPath });
  safeExec('git', ['commit', '-q', '-m', 'init'], { cwd: missionPath });

  const tasks = [
    {
      task_id: 'task-1',
      status: 'planned',
      assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
      description: 'Change the code',
      deliverable: 'deliverables/change.md',
    },
    ...(options.withReviewTask
      ? [
          {
            task_id: 'task-2',
            status: 'planned',
            assigned_to: { role: 'reviewer', agent_id: 'implementation-architect' },
            description: 'Review the change',
            deliverable: 'deliverables/REVIEW-task-1.md',
            dependencies: ['task-1'],
            review_target: 'task-1',
          },
        ]
      : []),
  ];
  safeWriteFile(`${missionPath}/NEXT_TASKS.json`, JSON.stringify(tasks, null, 2));
  return missionPath;
}

describe.sequential('code_change PR collaboration (E2E-03 Task 6)', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    process.env.MISSION_ROLE = 'mission_controller';
    const { clearWorkCoordinationStore, setWorkCoordinationNamespace } =
      await import('../libs/core/work-coordination.js');
    setWorkCoordinationNamespace('code-change-pr');
    clearWorkCoordinationStore();

    mocks.ensureMissionTeamRuntimeViaSupervisor.mockResolvedValue({
      runtime_plan: { mission_id: MISSION, assignments: [] },
    });
    mocks.resolveMissionTeamPlan.mockReturnValue({
      mission_id: MISSION,
      mission_type: 'code_change',
      assignments: [],
    });
    mocks.resolveMissionTeamReceiver.mockReturnValue({
      agent_id: 'implementation-architect',
      model_hint: { tier: 'small', effort: 'low', model_id: 'openai:gpt-5.4-mini' },
    });
  });

  afterEach(async () => {
    const { missionDir } = await import('../libs/core/path-resolver.js');
    const { safeExistsSync, safeRmSync } = await import('../libs/core/secure-io.js');
    const { clearWorkCoordinationStore, clearWorkCoordinationNamespace } =
      await import('../libs/core/work-coordination.js');
    const missionPath = missionDir(MISSION, 'public');
    if (safeExistsSync(missionPath)) safeRmSync(missionPath);
    clearWorkCoordinationStore();
    clearWorkCoordinationNamespace();
  });

  it('publishes diff.patch + PR.md on implement completion and injects the diff into review', async () => {
    const missionPath = await seedMission({ withReviewTask: true });
    const { safeWriteFile, safeReadFile, safeExistsSync, safeExec } =
      await import('../libs/core/secure-io.js');

    mocks.route.mockImplementation(async (envelope: any) => {
      const taskId = String(envelope?.payload?.context?.task_id || '');
      if (taskId === 'task-1') {
        // implement work mutates the micro-repo worktree
        safeWriteFile(`${missionPath}/deliverables/change.md`, '# change v2 with fix');
        return { payload: { text: makeTaskResultText({ summary: 'Changed the code.' }) } };
      }
      return {
        payload: {
          text: makeTaskResultText({ summary: 'Looks good.', review_findings: [] }),
        },
      };
    });

    const { dispatchMissionNextTasks } =
      await import('../libs/core/mission-orchestration-worker.js');
    await dispatchMissionNextTasks(MISSION);

    const diffPath = `${missionPath}/evidence/prs/task-1/diff.patch`;
    const prPath = `${missionPath}/evidence/prs/task-1/PR.md`;
    expect(safeExistsSync(diffPath)).toBe(true);
    expect(safeExistsSync(prPath)).toBe(true);
    const diff = safeReadFile(diffPath, { encoding: 'utf8' }) as string;
    expect(diff).toContain('change v2 with fix');
    const pr = safeReadFile(prPath, { encoding: 'utf8' }) as string;
    expect(pr).toContain('Changed the code.');
    expect(pr).toContain('- Branch: task/task-1');
    expect(pr).toContain('deliverables/change.md');

    const branches = String(
      safeExec('git', ['branch', '--list', 'task/task-1'], { cwd: missionPath })
    );
    expect(branches).toContain('task/task-1');

    // reviewer prompt carries the diff
    const reviewPrompt = mocks.route.mock.calls
      .map((call) => String((call[0] as any)?.payload?.text || ''))
      .find((prompt) => prompt.includes('Diff under review'));
    expect(reviewPrompt).toBeTruthy();
    expect(reviewPrompt).toContain('change v2 with fix');

    // every dispatch prompt carries the mission goal (本来の目的), not just the task wording
    const firstPrompt = String((mocks.route.mock.calls[0][0] as any)?.payload?.text || '');
    expect(firstPrompt).toContain('## Mission goal');
    expect(firstPrompt).toContain('Ship the login change safely');
    expect(firstPrompt).toContain('review approves the change');
  });

  it('blocks a code_change plan without a review task as a planner contract violation', async () => {
    await seedMission({ withReviewTask: false });
    mocks.route.mockResolvedValue({
      payload: { text: makeTaskResultText({ summary: 'should not run' }) },
    });

    const { dispatchMissionNextTasks } =
      await import('../libs/core/mission-orchestration-worker.js');
    await expect(dispatchMissionNextTasks(MISSION)).rejects.toThrow(
      /code_change missions require at least one reviewer\/qa task/
    );
    expect(mocks.route).not.toHaveBeenCalled();
  });
});
