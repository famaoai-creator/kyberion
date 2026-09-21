import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const loadMissionTeamPlan = vi.fn();
  const loadAgentProfileIndex = vi.fn();
  const get = vi.fn();
  const ensureAgentRuntime = vi.fn();
  const ensureAgentRuntimeViaDaemon = vi.fn();
  const staffMissionTeamRoles = vi.fn();

  return {
    loadMissionTeamPlan,
    loadAgentProfileIndex,
    get,
    ensureAgentRuntime,
    ensureAgentRuntimeViaDaemon,
    staffMissionTeamRoles,
  };
});

vi.mock('../libs/core/mission-team-plan-composer.js', () => ({
  loadMissionTeamPlan: mocks.loadMissionTeamPlan,
  loadAgentProfileIndex: mocks.loadAgentProfileIndex,
}));

// TC-02: staffing standby roles is the binding layer's job; the orchestrator
// only asks for it and then materializes what came back staffed.
vi.mock('../libs/core/mission-team-binding.js', () => ({
  staffMissionTeamRoles: mocks.staffMissionTeamRoles,
}));

vi.mock('../libs/core/agent-registry.js', () => ({
  agentRegistry: {
    get: mocks.get,
  },
}));

vi.mock('../libs/core/agent-runtime-supervisor.js', () => ({
  ensureAgentRuntime: mocks.ensureAgentRuntime,
}));

vi.mock('../libs/core/agent-runtime-supervisor-client.js', () => ({
  ensureAgentRuntimeViaDaemon: mocks.ensureAgentRuntimeViaDaemon,
}));

describe('mission-team-orchestrator', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.ensureAgentRuntimeViaDaemon.mockRejectedValue(new Error('offline'));
    mocks.staffMissionTeamRoles.mockImplementation(() => ({
      plan: mocks.loadMissionTeamPlan(),
      promoted: [],
      unfilled: [],
    }));
  });

  it('spawns assigned agents that are not already ready', async () => {
    mocks.loadMissionTeamPlan.mockReturnValue({
      mission_id: 'MSN-TEAM',
      assignments: [
        {
          team_role: 'owner',
          required: true,
          status: 'assigned',
          agent_id: 'nerve-agent',
          provider: 'gemini',
          modelId: 'gemini-2.5-pro',
          required_capabilities: ['reasoning'],
        },
        {
          team_role: 'reviewer',
          required: true,
          status: 'unfilled',
          agent_id: null,
        },
      ],
    });
    mocks.loadAgentProfileIndex.mockReturnValue({
      'nerve-agent': {
        provider: 'gemini',
        modelId: 'gemini-2.5-pro',
        capabilities: ['reasoning'],
      },
    });
    mocks.get.mockReturnValue(undefined);
    mocks.ensureAgentRuntimeViaDaemon.mockResolvedValue({});

    const { ensureMissionTeamRuntime } = await import('@agent/core/mission-team-orchestrator');
    const result = await ensureMissionTeamRuntime('MSN-TEAM');

    expect(mocks.ensureAgentRuntimeViaDaemon).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'nerve-agent',
        provider: 'gemini',
        missionId: 'MSN-TEAM',
      })
    );
    expect(mocks.ensureAgentRuntime).not.toHaveBeenCalled();
    expect(
      result.assignments.find((entry: any) => entry.team_role === 'owner')?.runtime_status
    ).toBe('spawned');
    expect(
      result.assignments.find((entry: any) => entry.team_role === 'reviewer')?.runtime_status
    ).toBe('unfilled');
  });

  it('marks already ready agents without respawning', async () => {
    mocks.loadMissionTeamPlan.mockReturnValue({
      mission_id: 'MSN-TEAM',
      assignments: [
        {
          team_role: 'owner',
          required: true,
          status: 'assigned',
          agent_id: 'nerve-agent',
        },
      ],
    });
    mocks.loadAgentProfileIndex.mockReturnValue({});
    mocks.get.mockReturnValue({ status: 'ready' });

    const { ensureMissionTeamRuntime } = await import('@agent/core/mission-team-orchestrator');
    const result = await ensureMissionTeamRuntime('MSN-TEAM');

    expect(mocks.ensureAgentRuntime).not.toHaveBeenCalled();
    expect(result.assignments[0].runtime_status).toBe('already_ready');
  });

  it('spawns each assigned agent only once even when multiple roles share the same agent', async () => {
    mocks.loadMissionTeamPlan.mockReturnValue({
      mission_id: 'MSN-TEAM',
      assignments: [
        {
          team_role: 'owner',
          required: true,
          status: 'assigned',
          agent_id: 'nerve-agent',
          provider: 'gemini',
          modelId: 'gemini-2.5-pro',
          required_capabilities: ['reasoning'],
        },
        {
          team_role: 'planner',
          required: true,
          status: 'assigned',
          agent_id: 'nerve-agent',
          provider: 'gemini',
          modelId: 'gemini-2.5-pro',
          required_capabilities: ['reasoning'],
        },
        {
          team_role: 'tester',
          required: true,
          status: 'assigned',
          agent_id: 'nerve-agent',
          provider: 'gemini',
          modelId: 'gemini-2.5-pro',
          required_capabilities: ['reasoning'],
        },
      ],
    });
    mocks.loadAgentProfileIndex.mockReturnValue({
      'nerve-agent': {
        provider: 'gemini',
        modelId: 'gemini-2.5-pro',
        capabilities: ['reasoning'],
      },
    });
    mocks.get.mockReturnValue(undefined);
    mocks.ensureAgentRuntimeViaDaemon.mockResolvedValue({});

    const { ensureMissionTeamRuntime } = await import('@agent/core/mission-team-orchestrator');
    const result = await ensureMissionTeamRuntime('MSN-TEAM');

    expect(mocks.ensureAgentRuntimeViaDaemon).toHaveBeenCalledTimes(1);
    expect(mocks.ensureAgentRuntime).not.toHaveBeenCalled();
    expect(result.assignments.map((entry: any) => entry.runtime_status)).toEqual([
      'spawned',
      'spawned',
      'spawned',
    ]);
  });

  it('can ensure only selected team roles', async () => {
    mocks.loadMissionTeamPlan.mockReturnValue({
      mission_id: 'MSN-TEAM',
      assignments: [
        {
          team_role: 'owner',
          required: true,
          status: 'assigned',
          agent_id: 'nerve-agent',
          provider: 'gemini',
          modelId: 'gemini-2.5-pro',
          required_capabilities: ['reasoning'],
        },
        {
          team_role: 'planner',
          required: true,
          status: 'assigned',
          agent_id: 'nerve-agent',
          provider: 'gemini',
          modelId: 'gemini-2.5-pro',
          required_capabilities: ['reasoning'],
        },
        {
          team_role: 'implementer',
          required: true,
          status: 'assigned',
          agent_id: 'implementation-architect',
          provider: 'gemini',
          modelId: 'gemini-2.5-pro',
          required_capabilities: ['implementation'],
        },
      ],
    });
    mocks.loadAgentProfileIndex.mockReturnValue({
      'nerve-agent': {
        provider: 'gemini',
        modelId: 'gemini-2.5-pro',
        capabilities: ['reasoning'],
      },
      'implementation-architect': {
        provider: 'gemini',
        modelId: 'gemini-2.5-pro',
        capabilities: ['implementation'],
      },
    });
    mocks.get.mockReturnValue(undefined);
    mocks.ensureAgentRuntimeViaDaemon.mockResolvedValue({});

    const { ensureMissionTeamRuntime } = await import('@agent/core/mission-team-orchestrator');
    const result = await ensureMissionTeamRuntime({
      missionId: 'MSN-TEAM',
      teamRoles: ['planner'],
    });

    expect(mocks.ensureAgentRuntimeViaDaemon).toHaveBeenCalledTimes(1);
    expect(mocks.ensureAgentRuntimeViaDaemon).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'nerve-agent',
      })
    );
    expect(mocks.ensureAgentRuntime).not.toHaveBeenCalled();
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0].team_role).toBe('planner');
    // TC-02: a role-scoped ensure is a staffing demand for exactly those roles.
    expect(mocks.staffMissionTeamRoles).toHaveBeenCalledWith(
      expect.objectContaining({ missionId: 'MSN-TEAM', teamRoles: ['planner'] })
    );
  });

  it('leaves undemanded standby roles unstaffed', async () => {
    mocks.loadMissionTeamPlan.mockReturnValue({
      mission_id: 'MSN-TEAM',
      assignments: [
        {
          team_role: 'owner',
          required: true,
          status: 'assigned',
          agent_id: 'nerve-agent',
          provider: 'gemini',
          modelId: 'gemini-2.5-pro',
          required_capabilities: ['reasoning'],
        },
        {
          team_role: 'tester',
          required: true,
          status: 'standby',
          agent_id: 'implementation-architect',
          provider: 'gemini',
          modelId: 'gemini-2.5-pro',
          required_capabilities: ['testing'],
        },
      ],
    });
    mocks.loadAgentProfileIndex.mockReturnValue({});
    mocks.get.mockReturnValue(undefined);
    mocks.ensureAgentRuntimeViaDaemon.mockResolvedValue({});

    const { ensureMissionTeamRuntime } = await import('@agent/core/mission-team-orchestrator');
    const result = await ensureMissionTeamRuntime('MSN-TEAM');

    // An unscoped ensure must not staff the whole roster.
    expect(mocks.staffMissionTeamRoles).not.toHaveBeenCalled();
    const tester = result.assignments.find((entry) => entry.team_role === 'tester');
    expect(tester?.runtime_status).toBe('standby');
    expect(mocks.ensureAgentRuntimeViaDaemon).toHaveBeenCalledTimes(1);
    expect(mocks.ensureAgentRuntimeViaDaemon).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'nerve-agent' })
    );
  });
});
