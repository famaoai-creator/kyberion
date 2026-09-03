import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeReaddir, safeRmSync, safeWriteFile } from './secure-io.js';

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

  it('rejects an invalid prewarm request before queueing it', async () => {
    const { enqueueMissionTeamPrewarmRequest } = await import('./agent-runtime-supervisor.js');
    const requestDir = pathResolver.shared('coordination/agent-runtime/requests');
    safeMkdir(requestDir, { recursive: true });
    const before = safeReaddir(requestDir);

    expect(() =>
      enqueueMissionTeamPrewarmRequest({
        missionId: 'MSN-PREWARM',
        teamRoles: [''],
        requestedBy: 'test',
        scope: { scope_kind: 'mission', tier: 'public', mission_id: 'MSN-PREWARM' },
      })
    ).toThrow(/Invalid catalog agent-runtime-ensure-request/);
    expect(safeReaddir(requestDir)).toEqual(before);
  });

  it('rejects request artifacts outside the supervisor request queue', async () => {
    const { loadMissionTeamPrewarmRequest } = await import('./agent-runtime-supervisor.js');
    const outsidePath = pathResolver.shared('coordination/agent-runtime/other/request.json');
    expect(() => loadMissionTeamPrewarmRequest(outsidePath)).toThrow('[AGENT_RUNTIME_QUEUE_SCOPE]');
  });

  it('rejects malformed persisted requests before runtime orchestration', async () => {
    const { getAgentRuntimeEnsureRequestPath, loadMissionTeamPrewarmRequest } =
      await import('./agent-runtime-supervisor.js');
    const requestPath = getAgentRuntimeEnsureRequestPath(`AR-MALFORMED-${process.pid}`);
    safeWriteFile(
      requestPath,
      JSON.stringify({
        request_id: path.basename(requestPath, '.json'),
        mission_id: 'MSN-PREWARM',
        scope: { scope_kind: 'mission', tier: 'public', mission_id: 'MSN-PREWARM' },
        team_roles: ['planner', 42],
        requested_by: 'test',
        created_at: '2026-09-03T00:00:00.000Z',
      })
    );
    try {
      expect(() => loadMissionTeamPrewarmRequest(requestPath)).toThrow(
        /Invalid catalog agent-runtime-ensure-request/
      );
    } finally {
      safeRmSync(requestPath, { force: true });
    }
  });

  it('rejects unknown persisted scope fields at the catalog boundary', async () => {
    const { getAgentRuntimeEnsureRequestPath, loadMissionTeamPrewarmRequest } =
      await import('./agent-runtime-supervisor.js');
    const requestPath = getAgentRuntimeEnsureRequestPath(`AR-SCOPE-${process.pid}`);
    safeWriteFile(
      requestPath,
      JSON.stringify({
        request_id: path.basename(requestPath, '.json'),
        mission_id: 'MSN-PREWARM',
        scope: {
          scope_kind: 'mission',
          tier: 'public',
          mission_id: 'MSN-PREWARM',
          tenant: 'unexpected',
        },
        requested_by: 'test',
        created_at: '2026-09-03T00:00:00.000Z',
      })
    );
    try {
      expect(() => loadMissionTeamPrewarmRequest(requestPath)).toThrow(
        /Invalid catalog agent-runtime-ensure-request/
      );
    } finally {
      safeRmSync(requestPath, { force: true });
    }
  });

  it('rejects a request path that is a directory', async () => {
    const { getAgentRuntimeEnsureRequestPath, loadMissionTeamPrewarmRequest } =
      await import('./agent-runtime-supervisor.js');
    const requestPath = getAgentRuntimeEnsureRequestPath(`AR-DIRECTORY-${process.pid}`);
    safeMkdir(requestPath, { recursive: true });
    try {
      expect(() => loadMissionTeamPrewarmRequest(requestPath)).toThrow(
        '[AGENT_RUNTIME_REQUEST] request must be a regular file'
      );
    } finally {
      safeRmSync(requestPath, { recursive: true, force: true });
    }
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
          authority_role: null,
          delegation_contract: null,
          provider: 'stub',
          modelId: null,
          required_capabilities: [],
          notes: '',
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

  it('rejects result artifacts with unknown fields', async () => {
    const { getAgentRuntimeEnsureResultPath, loadMissionTeamPrewarmResultAtPath } =
      await import('./agent-runtime-supervisor.js');
    const { safeRmSync, safeWriteFile } = await import('./secure-io.js');
    const resultPath = getAgentRuntimeEnsureResultPath(`AR-RESULT-${process.pid}`);
    safeWriteFile(
      resultPath,
      JSON.stringify({
        request_id: 'AR-OTHER',
        mission_id: 'MSN-PREWARM',
        scope: { scope_kind: 'mission', tier: 'public', mission_id: 'MSN-PREWARM' },
        requested_by: 'test',
        created_at: '2026-09-03T00:00:00.000Z',
        completed_at: '2026-09-03T00:00:01.000Z',
        runtime_plan: { mission_id: 'MSN-PREWARM', assignments: [] },
        unexpected: true,
      })
    );
    try {
      expect(() => loadMissionTeamPrewarmResultAtPath(resultPath, 'AR-RESULT-123')).toThrow(
        'Invalid catalog agent-runtime-ensure-result'
      );
    } finally {
      safeRmSync(resultPath, { force: true });
    }
  });

  it('rejects a result whose request id does not match the result filename', async () => {
    const { getAgentRuntimeEnsureResultPath, loadMissionTeamPrewarmResultAtPath } =
      await import('./agent-runtime-supervisor.js');
    const { safeRmSync, safeWriteFile } = await import('./secure-io.js');
    const resultPath = getAgentRuntimeEnsureResultPath(`AR-RESULT-BINDING-${process.pid}`);
    safeWriteFile(
      resultPath,
      JSON.stringify({
        request_id: 'AR-OTHER',
        mission_id: 'MSN-PREWARM',
        scope: { scope_kind: 'mission', tier: 'public', mission_id: 'MSN-PREWARM' },
        requested_by: 'test',
        created_at: '2026-09-03T00:00:00.000Z',
        completed_at: '2026-09-03T00:00:01.000Z',
        runtime_plan: { mission_id: 'MSN-PREWARM', assignments: [] },
      })
    );
    try {
      expect(() => loadMissionTeamPrewarmResultAtPath(resultPath, 'AR-RESULT-BINDING-123')).toThrow(
        '[AGENT_RUNTIME_RESULT_SCOPE_MISMATCH]'
      );
    } finally {
      safeRmSync(resultPath, { force: true });
    }
  });

  it('rejects a result whose runtime plan crosses the mission binding', async () => {
    const { getAgentRuntimeEnsureResultPath, loadMissionTeamPrewarmResultAtPath } =
      await import('./agent-runtime-supervisor.js');
    const { safeRmSync, safeWriteFile } = await import('./secure-io.js');
    const requestId = `AR-RESULT-SCOPE-${process.pid}`;
    const resultPath = getAgentRuntimeEnsureResultPath(requestId);
    safeWriteFile(
      resultPath,
      JSON.stringify({
        request_id: requestId,
        mission_id: 'MSN-PREWARM',
        scope: { scope_kind: 'mission', tier: 'public', mission_id: 'MSN-PREWARM' },
        requested_by: 'test',
        created_at: '2026-09-03T00:00:00.000Z',
        completed_at: '2026-09-03T00:00:01.000Z',
        runtime_plan: { mission_id: 'MSN-OTHER', assignments: [] },
      })
    );
    try {
      expect(() => loadMissionTeamPrewarmResultAtPath(resultPath, requestId)).toThrow(
        '[AGENT_RUNTIME_RESULT_SCOPE_MISMATCH]'
      );
    } finally {
      safeRmSync(resultPath, { force: true });
    }
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
