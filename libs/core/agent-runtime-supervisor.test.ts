import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';

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
      scope: { scope_kind: 'mission', tier: 'public', mission_id: 'MSN-PREWARM' },
      reason: 'unit test',
    });

    const reloaded = loadMissionTeamPrewarmRequest(
      getAgentRuntimeEnsureRequestPath(request.request_id)
    );
    expect(reloaded.mission_id).toBe('MSN-PREWARM');
    expect(reloaded.scope).toEqual({
      scope_kind: 'mission',
      tier: 'public',
      mission_id: 'MSN-PREWARM',
    });
    expect(reloaded.team_roles).toEqual(['planner']);
    expect(reloaded.requested_by).toBe('test');
  });

  it('rejects request artifacts outside the supervisor request queue', async () => {
    const { loadMissionTeamPrewarmRequest } = await import('./agent-runtime-supervisor.js');
    const outsidePath = pathResolver.shared('coordination/agent-runtime/other/request.json');
    expect(() => loadMissionTeamPrewarmRequest(outsidePath)).toThrow('[AGENT_RUNTIME_QUEUE_SCOPE]');
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
      scope: { scope_kind: 'mission', tier: 'public', mission_id: 'MSN-PREWARM' },
    });
    const requestPath = (
      await import('./agent-runtime-supervisor.js')
    ).getAgentRuntimeEnsureRequestPath(request.request_id);
    const result = await processMissionTeamPrewarmRequest(requestPath);

    expect(mocks.ensureMissionTeamRuntime).toHaveBeenCalledWith({
      missionId: 'MSN-PREWARM',
      teamRoles: ['planner'],
      scope: { scope_kind: 'mission', tier: 'public', mission_id: 'MSN-PREWARM' },
      runtimeOwnerId: expect.stringMatching(/^agent-runtime-supervisor:/),
      runtimeOwnerType: 'agent-runtime-supervisor',
    });
    expect(result.runtime_plan.assignments).toHaveLength(1);

    const resultPath = getAgentRuntimeEnsureResultPath(request.request_id);
    expect(safeExistsSync(resultPath)).toBe(true);
    const stored = JSON.parse(safeReadFile(resultPath, { encoding: 'utf8' }) as string);
    expect(stored.request_id).toBe(request.request_id);
  });

  it('starts a detached supervisor process for a queued request', async () => {
    const { enqueueMissionTeamPrewarmRequest, startAgentRuntimeSupervisorForRequest } =
      await import('./agent-runtime-supervisor.js');

    const request = enqueueMissionTeamPrewarmRequest({
      missionId: 'MSN-PREWARM',
      requestedBy: 'test',
      scope: { scope_kind: 'mission', tier: 'public', mission_id: 'MSN-PREWARM' },
    });
    startAgentRuntimeSupervisorForRequest(request);

    expect(mocks.spawnManagedProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceId: expect.stringContaining(request.request_id),
        command: 'node',
        args: [
          'dist/scripts/run_agent_runtime_supervisor.js',
          '--request',
          expect.stringContaining(`${request.request_id}.json`),
        ],
      })
    );
  });

  it('estimates usage when a provider exposes an empty placeholder usage object', async () => {
    const { resolveRuntimeTokenUsage } = await import('./agent-runtime-supervisor.js');
    expect(
      resolveRuntimeTokenUsage({
        reportedInputTokens: 0,
        reportedOutputTokens: 0,
        promptChars: 40,
        responseChars: 20,
      })
    ).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      usageEstimated: true,
      usageStatus: 'estimated',
    });
  });

  it('preserves non-zero provider usage as actual usage', async () => {
    const { resolveRuntimeTokenUsage } = await import('./agent-runtime-supervisor.js');
    expect(
      resolveRuntimeTokenUsage({
        reportedInputTokens: 14,
        reportedOutputTokens: 6,
        promptChars: 40,
        responseChars: 20,
      })
    ).toEqual({
      inputTokens: 14,
      outputTokens: 6,
      usageEstimated: false,
      usageStatus: 'actual',
    });
  });
});
