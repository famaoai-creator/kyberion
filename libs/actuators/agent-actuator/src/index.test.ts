import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const resolveMissionTeamPlan = vi.fn();
  const getMissionTeamAssignment = vi.fn();
  const ensureMissionTeamRuntimeViaSupervisor = vi.fn();
  const enqueueMissionTeamPrewarmRequest = vi.fn();
  const startAgentRuntimeSupervisorForRequest = vi.fn();

  return {
    resolveMissionTeamPlan,
    getMissionTeamAssignment,
    ensureMissionTeamRuntimeViaSupervisor,
    enqueueMissionTeamPrewarmRequest,
    startAgentRuntimeSupervisorForRequest,
  };
});

vi.mock('@agent/core', () => ({
  logger: { info: vi.fn(), error: vi.fn() },
  createStandardYargs: () => ({
    option() {
      return this;
    },
    parseSync() {
      return { input: 'input.json' };
    },
  }),
  agentRegistry: {
    get: vi.fn(),
    updateStatus: vi.fn(),
    touch: vi.fn(),
    list: vi.fn(() => []),
    getHealthSnapshot: vi.fn(() => ({ total: 0, ready: 0, busy: 0, error: 0 })),
  },
  agentLifecycle: {
    spawn: vi.fn(),
    shutdown: vi.fn(),
    shutdownAll: vi.fn(),
    getMediator: vi.fn(),
    listSnapshots: vi.fn(() => []),
    getSnapshot: vi.fn(),
    refreshContext: vi.fn(),
    restart: vi.fn(),
  },
  a2aBridge: {
    route: vi.fn(),
  },
  resolveMissionTeamPlan: mocks.resolveMissionTeamPlan,
  getMissionTeamAssignment: mocks.getMissionTeamAssignment,
  ensureMissionTeamRuntimeViaSupervisor: mocks.ensureMissionTeamRuntimeViaSupervisor,
  enqueueMissionTeamPrewarmRequest: mocks.enqueueMissionTeamPrewarmRequest,
  startAgentRuntimeSupervisorForRequest: mocks.startAgentRuntimeSupervisorForRequest,
  safeReadFile: vi.fn(),
}));

describe('agent-actuator team composition actions', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('returns a mission team plan for team_plan', async () => {
    const plan = {
      mission_id: 'MSN-TEAM',
      mission_type: 'development',
      tier: 'public',
      template: 'development',
      generated_at: '2026-03-16T00:00:00.000Z',
      assignments: [],
    };
    mocks.resolveMissionTeamPlan.mockReturnValue(plan);

    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'team_plan',
      params: {
        missionId: 'MSN-TEAM',
      },
    } as any);

    expect(mocks.resolveMissionTeamPlan).toHaveBeenCalledWith({ missionId: 'MSN-TEAM' });
    expect(result).toEqual({ status: 'ok', missionId: 'MSN-TEAM', plan });
  });

  it('returns a resolved assignment for team_role', async () => {
    const plan = {
      mission_id: 'MSN-TEAM',
      mission_type: 'development',
      tier: 'public',
      template: 'development',
      generated_at: '2026-03-16T00:00:00.000Z',
      assignments: [],
    };
    const assignment = {
      team_role: 'owner',
      required: true,
      status: 'assigned',
      agent_id: 'nerve-agent',
      authority_role: 'mission_controller',
      provider: 'codex',
      modelId: 'gpt-5',
      required_capabilities: ['planning'],
      notes: 'matched',
    };
    mocks.resolveMissionTeamPlan.mockReturnValue(plan);
    mocks.getMissionTeamAssignment.mockReturnValue(assignment);

    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'team_role',
      params: {
        missionId: 'MSN-TEAM',
        teamRole: 'owner',
      },
    } as any);

    expect(mocks.getMissionTeamAssignment).toHaveBeenCalledWith(plan, 'owner');
    expect(result).toEqual({ status: 'ok', missionId: 'MSN-TEAM', assignment });
  });

  it('stuffs a mission team into runtime instances for staff_mission', async () => {
    const runtimePlan = {
      request_id: 'AR-1',
      mission_id: 'MSN-TEAM',
      requested_by: 'agent_actuator',
      created_at: '2026-03-16T00:00:00.000Z',
      completed_at: '2026-03-16T00:00:10.000Z',
      runtime_plan: {
        mission_id: 'MSN-TEAM',
        assignments: [
          { team_role: 'owner', runtime_status: 'spawned' },
        ],
      },
    };
    mocks.ensureMissionTeamRuntimeViaSupervisor.mockResolvedValue(runtimePlan);

    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'staff_mission',
      params: {
        missionId: 'MSN-TEAM',
      },
    } as any);

    expect(mocks.ensureMissionTeamRuntimeViaSupervisor).toHaveBeenCalledWith(expect.objectContaining({
      missionId: 'MSN-TEAM',
      requestedBy: 'agent_actuator',
    }));
    expect(result).toEqual({ status: 'ok', missionId: 'MSN-TEAM', runtimePlan: runtimePlan.runtime_plan });
  });

  it('queues mission prewarm through the supervisor', async () => {
    mocks.enqueueMissionTeamPrewarmRequest.mockReturnValue({
      request_id: 'AR-1',
      mission_id: 'MSN-TEAM',
      team_roles: ['planner'],
    });

    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'prewarm_mission',
      params: {
        missionId: 'MSN-TEAM',
      },
    } as any);

    expect(mocks.enqueueMissionTeamPrewarmRequest).toHaveBeenCalledWith(expect.objectContaining({
      missionId: 'MSN-TEAM',
      requestedBy: 'agent_actuator',
    }));
    expect(mocks.startAgentRuntimeSupervisorForRequest).toHaveBeenCalledWith(expect.objectContaining({
      request_id: 'AR-1',
    }));
    expect(result).toEqual({
      status: 'queued',
      missionId: 'MSN-TEAM',
      requestId: 'AR-1',
      teamRoles: ['planner'],
    });
  });
});
