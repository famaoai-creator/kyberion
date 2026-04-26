import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { compileSchemaFromPath, pathResolver } from '@agent/core';

const mocks = vi.hoisted(() => {
  const resolveMissionTeamPlan = vi.fn();
  const getMissionTeamAssignment = vi.fn();
  const ensureMissionTeamRuntimeViaSupervisor = vi.fn();
  const enqueueMissionTeamPrewarmRequest = vi.fn();
  const startAgentRuntimeSupervisorForRequest = vi.fn();
  const askAgentRuntime = vi.fn();
  const ensureAgentRuntime = vi.fn();
  const ensureAgentRuntimeViaDaemon = vi.fn();
  const askAgentRuntimeViaDaemon = vi.fn();
  const getAgentRuntimeStatusViaDaemon = vi.fn();
  const listAgentRuntimesViaDaemon = vi.fn();
  const shutdownAgentRuntimeViaDaemon = vi.fn();
  const refreshAgentRuntimeViaDaemon = vi.fn();
  const restartAgentRuntimeViaDaemon = vi.fn();
  const stopAgentRuntime = vi.fn();
  const listAgentRuntimeSnapshots = vi.fn();
  const getAgentRuntimeSnapshot = vi.fn();
  const refreshAgentRuntime = vi.fn();
  const restartAgentRuntime = vi.fn();

  return {
    resolveMissionTeamPlan,
    getMissionTeamAssignment,
    ensureMissionTeamRuntimeViaSupervisor,
    enqueueMissionTeamPrewarmRequest,
    startAgentRuntimeSupervisorForRequest,
    askAgentRuntime,
    ensureAgentRuntime,
    ensureAgentRuntimeViaDaemon,
    askAgentRuntimeViaDaemon,
    getAgentRuntimeStatusViaDaemon,
    listAgentRuntimesViaDaemon,
    shutdownAgentRuntimeViaDaemon,
    refreshAgentRuntimeViaDaemon,
    restartAgentRuntimeViaDaemon,
    stopAgentRuntime,
    listAgentRuntimeSnapshots,
    getAgentRuntimeSnapshot,
    refreshAgentRuntime,
    restartAgentRuntime,
  };
});
const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

vi.mock('@agent/core', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
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
    a2aBridge: {
      route: vi.fn(),
    },
    resolveMissionTeamPlan: mocks.resolveMissionTeamPlan,
    getMissionTeamAssignment: mocks.getMissionTeamAssignment,
    ensureMissionTeamRuntimeViaSupervisor: mocks.ensureMissionTeamRuntimeViaSupervisor,
    enqueueMissionTeamPrewarmRequest: mocks.enqueueMissionTeamPrewarmRequest,
    startAgentRuntimeSupervisorForRequest: mocks.startAgentRuntimeSupervisorForRequest,
    askAgentRuntime: mocks.askAgentRuntime,
    ensureAgentRuntime: mocks.ensureAgentRuntime,
    ensureAgentRuntimeViaDaemon: mocks.ensureAgentRuntimeViaDaemon,
    askAgentRuntimeViaDaemon: mocks.askAgentRuntimeViaDaemon,
    getAgentRuntimeStatusViaDaemon: mocks.getAgentRuntimeStatusViaDaemon,
    listAgentRuntimesViaDaemon: mocks.listAgentRuntimesViaDaemon,
    shutdownAgentRuntimeViaDaemon: mocks.shutdownAgentRuntimeViaDaemon,
    refreshAgentRuntimeViaDaemon: mocks.refreshAgentRuntimeViaDaemon,
    restartAgentRuntimeViaDaemon: mocks.restartAgentRuntimeViaDaemon,
    stopAgentRuntime: mocks.stopAgentRuntime,
    listAgentRuntimeSnapshots: mocks.listAgentRuntimeSnapshots,
    getAgentRuntimeSnapshot: mocks.getAgentRuntimeSnapshot,
    refreshAgentRuntime: mocks.refreshAgentRuntime,
    restartAgentRuntime: mocks.restartAgentRuntime,
    shutdownAllAgentRuntimes: vi.fn(),
    safeReadFile: vi.fn(),
  };
});

describe('agent-actuator team composition actions', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.listAgentRuntimesViaDaemon.mockResolvedValue([]);
    mocks.ensureAgentRuntimeViaDaemon.mockRejectedValue(new Error('offline'));
    mocks.askAgentRuntimeViaDaemon.mockRejectedValue(new Error('offline'));
    mocks.getAgentRuntimeStatusViaDaemon.mockRejectedValue(new Error('offline'));
    mocks.shutdownAgentRuntimeViaDaemon.mockRejectedValue(new Error('offline'));
    mocks.refreshAgentRuntimeViaDaemon.mockRejectedValue(new Error('offline'));
    mocks.restartAgentRuntimeViaDaemon.mockRejectedValue(new Error('offline'));
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

  it('emits agent actions that satisfy the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.join(pathResolver.rootDir(), 'schemas/agent-action.schema.json'));

    expect(
      validate({
        action: 'spawn',
        params: {
          agentId: 'agent-1',
          missionId: 'MSN-TEAM',
        },
      }),
      JSON.stringify(validate.errors || []),
    ).toBe(true);

    expect(
      validate({
        action: 'team_plan',
        params: {
          missionId: 'MSN-TEAM',
        },
      }),
      JSON.stringify(validate.errors || []),
    ).toBe(true);
  });

  it('rejects unsupported agent actions', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.join(pathResolver.rootDir(), 'schemas/agent-action.schema.json'));

    expect(
      validate({
        action: 'unsupported',
        params: {},
      }),
    ).toBe(false);
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

  it('prefers supervisor daemon for spawn and ask when available', async () => {
    mocks.ensureAgentRuntimeViaDaemon.mockResolvedValue({
      agent_id: 'agent-x',
      provider: 'gemini',
      model_id: 'gemini-2.5-flash',
      status: 'ready',
    });
    mocks.askAgentRuntimeViaDaemon.mockResolvedValue({ text: 'daemon response' });
    const agentRegistry = (await import('@agent/core')).agentRegistry as any;
    agentRegistry.get.mockReturnValue({ status: 'ready' });

    const { handleAction } = await import('./index.js');
    const spawned = await handleAction({
      action: 'spawn',
      params: {
        agentId: 'agent-x',
        provider: 'gemini',
      },
    } as any);
    const asked = await handleAction({
      action: 'ask',
      params: {
        agentId: 'agent-x',
        query: 'hello',
      },
    } as any);

    expect(mocks.ensureAgentRuntimeViaDaemon).toHaveBeenCalledTimes(1);
    expect(mocks.ensureAgentRuntime).not.toHaveBeenCalled();
    expect(spawned).toEqual({ status: 'spawned', agent: expect.objectContaining({ agent_id: 'agent-x' }) });
    expect(mocks.askAgentRuntimeViaDaemon).toHaveBeenCalledWith({
      agentId: 'agent-x',
      prompt: 'hello',
      requestedBy: 'agent_actuator',
    });
    expect(asked).toEqual({ status: 'ok', agentId: 'agent-x', response: 'daemon response' });
  });
});
