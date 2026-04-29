import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const route = vi.fn();
  const ensureMissionTeamRuntimeViaSupervisor = vi.fn();
  const shutdownAllAgentRuntimes = vi.fn();
  const resolveMissionTeamPlan = vi.fn();
  const resolveMissionTeamReceiver = vi.fn();
  const buildMissionTeamView = vi.fn();
  const record = vi.fn();

  return {
    route,
    ensureMissionTeamRuntimeViaSupervisor,
    shutdownAllAgentRuntimes,
    resolveMissionTeamPlan,
    resolveMissionTeamReceiver,
    buildMissionTeamView,
    record,
  };
});

vi.mock('./a2a-bridge.js', () => ({
  a2aBridge: {
    route: mocks.route,
  },
}));

vi.mock('./agent-runtime-supervisor.js', () => ({
  ensureMissionTeamRuntimeViaSupervisor: mocks.ensureMissionTeamRuntimeViaSupervisor,
  shutdownAllAgentRuntimes: mocks.shutdownAllAgentRuntimes,
}));

vi.mock('./mission-team-plan-composer.js', () => ({
  resolveMissionTeamPlan: mocks.resolveMissionTeamPlan,
  resolveMissionTeamReceiver: mocks.resolveMissionTeamReceiver,
  buildMissionTeamView: mocks.buildMissionTeamView,
}));

vi.mock('./ledger.js', () => ({
  ledger: {
    record: mocks.record,
  },
}));

describe('mission-orchestration-worker', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.MISSION_ROLE = 'mission_controller';
  });

  afterEach(async () => {
    const { missionDir } = await import('./path-resolver.js');
    const { safeExistsSync, safeRmSync } = await import('./secure-io.js');
    const missionPath = missionDir('MSN-FOLLOWUP', 'public');
    if (safeExistsSync(missionPath)) safeRmSync(missionPath);
  });

  it('dispatches planned next tasks and marks them requested', async () => {
    const { missionDir } = await import('./path-resolver.js');
    const { safeWriteFile, safeReadFile } = await import('./secure-io.js');
    const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');

    const missionPath = missionDir('MSN-FOLLOWUP', 'public');
    safeWriteFile(`${missionPath}/NEXT_TASKS.json`, JSON.stringify([
      {
        task_id: 'task-1',
        status: 'planned',
        assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
        description: 'Implement the deck',
        deliverable: 'deliverables/presentation.html',
      },
      {
        task_id: 'task-2',
        status: 'planned',
        assigned_to: { role: 'reviewer', agent_id: 'implementation-architect' },
        description: 'Review the deck',
        deliverable: 'Reviewed deliverables',
      },
    ], null, 2));
    safeWriteFile(`${missionPath}/TASK_BOARD.md`, [
      '# TASK_BOARD: MSN-FOLLOWUP',
      '',
      '## Status: Planning Ready',
      '',
      '### 🛠️ Execution Phase',
      '- [x] Step 1: Research and Strategy',
      '- [ ] Step 2: Implementation',
      '- [ ] Step 3: Validation',
      '',
    ].join('\n'));

    mocks.ensureMissionTeamRuntimeViaSupervisor.mockResolvedValue({
      runtime_plan: {
        mission_id: 'MSN-FOLLOWUP',
        assignments: [],
      },
    });
    mocks.resolveMissionTeamPlan.mockReturnValue({ mission_id: 'MSN-FOLLOWUP', mission_type: 'product_development' });
    mocks.buildMissionTeamView.mockReturnValue({ planner: 'nerve-agent' });
    mocks.resolveMissionTeamReceiver
      .mockReturnValueOnce({ agent_id: 'implementation-architect' })
      .mockReturnValueOnce({ agent_id: 'implementation-architect' });
    mocks.route.mockResolvedValue({
      payload: { text: 'accepted' },
    });

    const dispatched = await dispatchMissionNextTasks('MSN-FOLLOWUP');

    expect(mocks.ensureMissionTeamRuntimeViaSupervisor).toHaveBeenCalledWith(expect.objectContaining({
      missionId: 'MSN-FOLLOWUP',
      teamRoles: ['implementer', 'reviewer'],
    }));
    expect(mocks.route).toHaveBeenCalledTimes(2);
    expect(dispatched).toEqual([
      { task_id: 'task-1', team_role: 'implementer', agent_id: 'implementation-architect' },
      { task_id: 'task-2', team_role: 'reviewer', agent_id: 'implementation-architect' },
    ]);

    const stored = JSON.parse(safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string);
    expect(stored.map((task: any) => task.status)).toEqual(['requested', 'requested']);

    const taskBoard = safeReadFile(`${missionPath}/TASK_BOARD.md`, { encoding: 'utf8' }) as string;
    expect(taskBoard).toContain('## Status: Execution Ready');
    expect(taskBoard).toContain('- [~] Step 2: Implementation');
    expect(mocks.record).toHaveBeenCalledWith('MISSION_FOLLOWUP_DISPATCHED', expect.objectContaining({
      mission_id: 'MSN-FOLLOWUP',
      dispatched_task_count: 2,
    }));
  });

  it('reconciles accepted task outcomes into the task board and ledger', async () => {
    const { missionDir } = await import('./path-resolver.js');
    const { safeWriteFile, safeReadFile } = await import('./secure-io.js');
    const { reconcileMissionProgress } = await import('./mission-orchestration-worker.js');

    const missionPath = missionDir('MSN-FOLLOWUP', 'public');
    safeWriteFile(`${missionPath}/NEXT_TASKS.json`, JSON.stringify([
      {
        task_id: 'task-1',
        status: 'accepted',
        assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
        description: 'Implement the deck',
        deliverable: 'deliverables/presentation.html',
      },
    ], null, 2));
    safeWriteFile(`${missionPath}/TASK_BOARD.md`, [
      '# TASK_BOARD: MSN-FOLLOWUP',
      '',
      '## Status: Execution Ready',
      '',
      '### 🛠️ Execution Phase',
      '- [x] Step 1: Research and Strategy',
      '- [~] Step 2: Implementation',
      '- [ ] Step 3: Validation',
      '',
    ].join('\n'));

    reconcileMissionProgress('MSN-FOLLOWUP');

    const taskBoard = safeReadFile(`${missionPath}/TASK_BOARD.md`, { encoding: 'utf8' }) as string;
    expect(taskBoard).toContain('## Status: Review Accepted');
    expect(taskBoard).toContain('- [x] Step 2: Implementation');
    expect(taskBoard).toContain('- [x] Step 3: Validation');
    expect(mocks.record).toHaveBeenCalledWith('MISSION_TASK_OUTCOMES_RECONCILED', expect.objectContaining({
      mission_id: 'MSN-FOLLOWUP',
      accepted_count: 1,
    }));
  });

  it('persists planner packets into PLAN.md and NEXT_TASKS.json', async () => {
    const { missionDir } = await import('./path-resolver.js');
    const { safeReadFile } = await import('./secure-io.js');
    const { persistPlanningPacket } = await import('./mission-orchestration-worker.js');

    const missionPath = missionDir('MSN-FOLLOWUP', 'public');
    persistPlanningPacket('MSN-FOLLOWUP', {
      mission_id: 'MSN-FOLLOWUP',
      summary: 'Collect active mission state',
      plan_markdown: '# PLAN\n\n## Objective\nCollect active mission state\n',
      next_tasks: [
        {
          task_id: 'task-1',
          team_role: 'operator',
          description: 'Collect current mission registry',
          deliverable: 'artifacts/current-missions.md',
        },
      ],
    });

    const plan = safeReadFile(`${missionPath}/PLAN.md`, { encoding: 'utf8' }) as string;
    const nextTasks = JSON.parse(safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string);

    expect(plan).toContain('# PLAN');
    expect(nextTasks).toEqual([
      {
        task_id: 'task-1',
        status: 'planned',
        assigned_to: { role: 'operator' },
        description: 'Collect current mission registry',
        deliverable: 'artifacts/current-missions.md',
        target_path: undefined,
      },
    ]);
  });

  it('blocks delegated tasks when preflight path policy fails', async () => {
    const { missionDir } = await import('./path-resolver.js');
    const { safeWriteFile, safeReadFile } = await import('./secure-io.js');
    const { dispatchMissionNextTasks } = await import('./mission-orchestration-worker.js');

    const missionPath = missionDir('MSN-FOLLOWUP', 'public');
    safeWriteFile(`${missionPath}/NEXT_TASKS.json`, JSON.stringify([
      {
        task_id: 'task-blocked',
        status: 'planned',
        assigned_to: { role: 'implementer', agent_id: 'implementation-architect' },
        description: 'Attempt disallowed write',
        target_path: 'knowledge/public/architecture/disallowed.md',
        deliverable: 'knowledge/public/architecture/disallowed.md',
      },
    ], null, 2));
    safeWriteFile(`${missionPath}/TASK_BOARD.md`, [
      '# TASK_BOARD: MSN-FOLLOWUP',
      '',
      '## Status: Planning Ready',
      '',
      '### 🛠️ Execution Phase',
      '- [x] Step 1: Research and Strategy',
      '- [ ] Step 2: Implementation',
      '- [ ] Step 3: Validation',
      '',
    ].join('\n'));

    mocks.ensureMissionTeamRuntimeViaSupervisor.mockResolvedValue({
      runtime_plan: {
        mission_id: 'MSN-FOLLOWUP',
        assignments: [],
      },
    });
    mocks.resolveMissionTeamPlan.mockReturnValue({ mission_id: 'MSN-FOLLOWUP', mission_type: 'product_development' });
    mocks.buildMissionTeamView.mockReturnValue({ planner: 'nerve-agent' });
    mocks.resolveMissionTeamReceiver.mockReturnValue({
      agent_id: 'implementation-architect',
      authority_role: 'ecosystem_architect',
      delegation_contract: {
        ownership_scope: 'bounded implementation',
        allowed_delegate_team_roles: [],
        escalation_parent_team_role: 'planner',
        required_scope_classes: ['codebase_core'],
        resolved_scope_classes: ['codebase_core'],
        allowed_write_scopes: ['libs/core/', 'scripts/'],
      },
    });

    const dispatched = await dispatchMissionNextTasks('MSN-FOLLOWUP');

    expect(dispatched).toEqual([]);
    expect(mocks.route).not.toHaveBeenCalled();

    const stored = JSON.parse(safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string);
    expect(stored[0]?.status).toBe('blocked');
  });
});
