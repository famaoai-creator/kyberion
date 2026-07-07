import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E2E-03 Task 5 (MO-07 minimal activation): high-risk implement tasks run as
 * best-of-2 + judge; normal tasks stay single-shot.
 */

const mocks = vi.hoisted(() => ({
  route: vi.fn(),
  ensureMissionTeamRuntimeViaSupervisor: vi.fn(),
  resolveMissionTeamPlan: vi.fn(),
  resolveMissionTeamReceiver: vi.fn(),
  record: vi.fn(),
  emitMissionTaskEvent: vi.fn(),
}));

function makeTaskResultText(summary: string): string {
  return [
    '```task_result',
    JSON.stringify({
      summary,
      artifacts: [{ path: 'deliverables/out.md', kind: 'markdown' }],
      verification_done: ['checked'],
      gaps: [],
      needs: [],
    }),
    '```',
  ].join('\n');
}

vi.mock('../libs/core/a2a-bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../libs/core/a2a-bridge.js')>();
  return {
    ...actual,
    a2aBridge: { ...actual.a2aBridge, route: mocks.route },
  };
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

const MISSION = 'MSN-BESTOF-01';

async function seedMission(risk: string): Promise<void> {
  const { missionDir } = await import('../libs/core/path-resolver.js');
  const { safeMkdir, safeWriteFile } = await import('../libs/core/secure-io.js');
  const missionPath = missionDir(MISSION, 'public');
  safeMkdir(missionPath, { recursive: true });
  safeMkdir(`${missionPath}/deliverables`, { recursive: true });
  safeWriteFile(`${missionPath}/deliverables/out.md`, '# out');
  safeWriteFile(
    `${missionPath}/TASK_BOARD.md`,
    ['# TASK_BOARD: ' + MISSION, '', '## Status: Planning Ready', ''].join('\n')
  );
  safeWriteFile(
    `${missionPath}/NEXT_TASKS.json`,
    JSON.stringify(
      [
        {
          task_id: 'task-1',
          status: 'planned',
          assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
          description: 'Implement the risky change',
          deliverable: 'deliverables/out.md',
          risk,
        },
      ],
      null,
      2
    )
  );
}

describe.sequential('best-of-2 + judge (E2E-03 Task 5)', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    process.env.MISSION_ROLE = 'mission_controller';
    delete process.env.KYBERION_BEST_OF_N;
    const { clearWorkCoordinationStore, setWorkCoordinationNamespace } =
      await import('../libs/core/work-coordination.js');
    setWorkCoordinationNamespace('best-of-n-judge');
    clearWorkCoordinationStore();

    mocks.ensureMissionTeamRuntimeViaSupervisor.mockResolvedValue({
      runtime_plan: { mission_id: MISSION, assignments: [] },
    });
    mocks.resolveMissionTeamPlan.mockReturnValue({
      mission_id: MISSION,
      mission_type: 'product_development',
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
    delete process.env.KYBERION_BEST_OF_N;
  });

  it('runs two candidates + judge for high-risk tasks and adopts the winner', async () => {
    await seedMission('high');
    mocks.route.mockImplementation(async (envelope: any) => {
      const prompt = String(envelope?.payload?.text || '');
      if (prompt.includes('independent judge')) {
        return {
          payload: {
            text: JSON.stringify({
              winner: 'B',
              rationale: 'B handles edge cases',
              merge_hints: ['keep A error message wording'],
            }),
          },
        };
      }
      if (prompt.includes('best-of-N candidate A')) {
        return { payload: { text: makeTaskResultText('Candidate A minimal implementation.') } };
      }
      if (prompt.includes('best-of-N candidate B')) {
        return { payload: { text: makeTaskResultText('Candidate B robust implementation.') } };
      }
      return { payload: { text: makeTaskResultText('unexpected single-shot call') } };
    });

    const { dispatchMissionNextTasks } =
      await import('../libs/core/mission-orchestration-worker.js');
    const { missionDir } = await import('../libs/core/path-resolver.js');
    const { safeReadFile, safeExistsSync } = await import('../libs/core/secure-io.js');

    await dispatchMissionNextTasks(MISSION);

    expect(mocks.route).toHaveBeenCalledTimes(3);
    const stored = JSON.parse(
      safeReadFile(`${missionDir(MISSION, 'public')}/NEXT_TASKS.json`, {
        encoding: 'utf8',
      }) as string
    );
    expect(stored[0].last_result.summary).toContain('Candidate B robust implementation.');

    const loserPath = `${missionDir(MISSION, 'public')}/evidence/alternatives/task-1-candidate-A.json`;
    expect(safeExistsSync(loserPath)).toBe(true);
    const loser = JSON.parse(safeReadFile(loserPath, { encoding: 'utf8' }) as string);
    expect(loser.winner).toBe('B');
    expect(loser.task_result.summary).toContain('Candidate A minimal implementation.');

    const judgeEvents = mocks.emitMissionTaskEvent.mock.calls
      .map((call) => call[0])
      .filter((event: any) => event.decision === 'best_of_judged');
    expect(judgeEvents).toHaveLength(1);
    expect(judgeEvents[0].payload.winner).toBe('B');
  });

  it('keeps normal-risk tasks single-shot', async () => {
    await seedMission('medium');
    mocks.route.mockResolvedValue({ payload: { text: makeTaskResultText('Single shot result.') } });

    const { dispatchMissionNextTasks } =
      await import('../libs/core/mission-orchestration-worker.js');
    await dispatchMissionNextTasks(MISSION);
    expect(mocks.route).toHaveBeenCalledTimes(1);
  });

  it('KYBERION_BEST_OF_N=0 disables best-of even for high risk', async () => {
    process.env.KYBERION_BEST_OF_N = '0';
    await seedMission('high');
    mocks.route.mockResolvedValue({ payload: { text: makeTaskResultText('Single shot result.') } });

    const { dispatchMissionNextTasks } =
      await import('../libs/core/mission-orchestration-worker.js');
    await dispatchMissionNextTasks(MISSION);
    expect(mocks.route).toHaveBeenCalledTimes(1);
  });
});
