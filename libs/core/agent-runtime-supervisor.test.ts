import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const ensureMissionTeamRuntime = vi.fn();
  const spawnManagedProcess = vi.fn();

  return {
    ensureMissionTeamRuntime,
    spawnManagedProcess,
  };
});

vi.mock('./mission-team-orchestrator.js', () => ({
  ensureMissionTeamRuntime: mocks.ensureMissionTeamRuntime,
}));

vi.mock('./managed-process.js', () => ({
  spawnManagedProcess: mocks.spawnManagedProcess,
}));

describe('agent-runtime-supervisor', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.MISSION_ROLE = 'mission_controller';
  });

  it('writes a prewarm request artifact', async () => {
    const {
      enqueueMissionTeamPrewarmRequest,
      getAgentRuntimeEnsureRequestPath,
      loadMissionTeamPrewarmRequest,
    } = await import('./agent-runtime-supervisor.js');

    const request = enqueueMissionTeamPrewarmRequest({
      missionId: 'MSN-PREWARM',
      teamRoles: ['planner'],
      requestedBy: 'test',
      reason: 'unit test',
    });

    const reloaded = loadMissionTeamPrewarmRequest(getAgentRuntimeEnsureRequestPath(request.request_id));
    expect(reloaded.mission_id).toBe('MSN-PREWARM');
    expect(reloaded.team_roles).toEqual(['planner']);
    expect(reloaded.requested_by).toBe('test');
  });

  it('processes a queued request and writes a result artifact', async () => {
    mocks.ensureMissionTeamRuntime.mockResolvedValue({
      mission_id: 'MSN-PREWARM',
      assignments: [
        {
          team_role: 'planner',
          required: true,
          status: 'assigned',
          agent_id: 'nerve-agent',
          runtime_status: 'spawned',
        },
      ],
    });

    const {
      enqueueMissionTeamPrewarmRequest,
      processMissionTeamPrewarmRequest,
      getAgentRuntimeEnsureResultPath,
    } = await import('./agent-runtime-supervisor.js');
    const { safeExistsSync, safeReadFile } = await import('./secure-io.js');

    const request = enqueueMissionTeamPrewarmRequest({
      missionId: 'MSN-PREWARM',
      teamRoles: ['planner'],
      requestedBy: 'test',
    });
    const requestPath = (await import('./agent-runtime-supervisor.js')).getAgentRuntimeEnsureRequestPath(request.request_id);
    const result = await processMissionTeamPrewarmRequest(requestPath);

    expect(mocks.ensureMissionTeamRuntime).toHaveBeenCalledWith({
      missionId: 'MSN-PREWARM',
      teamRoles: ['planner'],
    });
    expect(result.runtime_plan.assignments).toHaveLength(1);

    const resultPath = getAgentRuntimeEnsureResultPath(request.request_id);
    expect(safeExistsSync(resultPath)).toBe(true);
    const stored = JSON.parse(safeReadFile(resultPath, { encoding: 'utf8' }) as string);
    expect(stored.request_id).toBe(request.request_id);
  });

  it('starts a detached supervisor process for a queued request', async () => {
    const {
      enqueueMissionTeamPrewarmRequest,
      startAgentRuntimeSupervisorForRequest,
    } = await import('./agent-runtime-supervisor.js');

    const request = enqueueMissionTeamPrewarmRequest({
      missionId: 'MSN-PREWARM',
      requestedBy: 'test',
    });
    startAgentRuntimeSupervisorForRequest(request);

    expect(mocks.spawnManagedProcess).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: expect.stringContaining(request.request_id),
      command: 'node',
      args: ['dist/scripts/run_agent_runtime_supervisor.js', '--request', expect.stringContaining(`${request.request_id}.json`)],
    }));
  });
});
