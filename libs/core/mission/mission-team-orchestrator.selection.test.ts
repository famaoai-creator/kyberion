import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpawnOptions } from '../agent/agent-lifecycle.js';
import type { MissionTeamAssignment } from './mission-team-plan-composer.js';

const mocks = vi.hoisted(() => ({
  loadPlan: vi.fn(),
  readDispatch: vi.fn(),
  reserve: vi.fn(),
  staff: vi.fn(),
  ensureRuntime: vi.fn(),
  getHandle: vi.fn(),
  daemonEnsure: vi.fn(),
  stop: vi.fn(),
  createAdapter: vi.fn(),
  boot: vi.fn(),
  ask: vi.fn(),
  shutdown: vi.fn(),
}));
vi.mock('./mission-team-plan-composer.js', async () => ({
  ...(await vi.importActual<typeof import('./mission-team-plan-composer.js')>(
    './mission-team-plan-composer.js'
  )),
  loadMissionTeamPlan: mocks.loadPlan,
}));
vi.mock('./mission-team-selection.js', () => ({
  readMissionTeamSelectionDispatch: mocks.readDispatch,
  reserveMissionTeamSelectionDispatch: mocks.reserve,
}));
vi.mock('./mission-team-binding.js', async () => ({
  ...(await vi.importActual<typeof import('./mission-team-binding.js')>(
    './mission-team-binding.js'
  )),
  staffMissionTeamRoles: mocks.staff,
}));
vi.mock('../agent/agent-runtime-port.js', async () => ({
  ...(await vi.importActual<typeof import('../agent/agent-runtime-port.js')>(
    '../agent/agent-runtime-port.js'
  )),
  ensureAgentRuntime: mocks.ensureRuntime,
}));
vi.mock('../agent/agent-runtime-supervisor.js', () => ({
  ensureAgentRuntime: mocks.ensureRuntime,
  getAgentRuntimeHandle: mocks.getHandle,
  appendSupervisorEvent: vi.fn(),
  askAgentRuntime: vi.fn(),
  stopAgentRuntime: mocks.stop,
  refreshAgentRuntime: vi.fn(),
}));
vi.mock('../agent/agent-runtime-supervisor-client.js', () => ({
  ensureAgentRuntimeViaDaemon: mocks.daemonEnsure,
  toSupervisorEnsurePayload: (input: unknown) => input,
  createSupervisorBackedAgentHandle: vi.fn(),
  askAgentRuntimeViaDaemon: vi.fn(),
  shutdownAgentRuntimeViaDaemon: mocks.stop,
  refreshAgentRuntimeViaDaemon: vi.fn(),
}));
vi.mock('../provider/provider-discovery.js', async () => ({
  ...(await vi.importActual<typeof import('../provider/provider-discovery.js')>(
    '../provider/provider-discovery.js'
  )),
  discoverProviders: () => [
    {
      provider: 'codex',
      installed: true,
      healthy: true,
      version: 'test',
      protocol: 'exec',
      models: ['exact'],
      capabilities: [],
      modelCapabilities: { exact: ['code'] },
    },
  ],
}));
vi.mock('../agent/agent-manifest.js', async () => ({
  ...(await vi.importActual<typeof import('../agent/agent-manifest.js')>(
    '../agent/agent-manifest.js'
  )),
  getAgentManifest: (agentId: string) => ({
    agentId,
    provider: 'codex',
    modelId: 'exact',
    systemPrompt: 'test agent',
    capabilities: ['code'],
    trustRequired: 0,
  }),
  validateRequirements: () => ({ ok: true, reasons: [] }),
  resolveAgentSelectionHints: () => ({ provider: 'codex', modelId: 'exact' }),
}));
vi.mock('../agent/agent-exec-adapter-bridge.js', async () => ({
  ...(await vi.importActual<typeof import('../agent/agent-exec-adapter-bridge.js')>(
    '../agent/agent-exec-adapter-bridge.js'
  )),
  hasAgentExecAdapter: async () => true,
  createAgentExecAdapter: mocks.createAdapter,
}));
vi.mock('../agent/agent-identity.js', async () => ({
  ...(await vi.importActual<typeof import('../agent/agent-identity.js')>(
    '../agent/agent-identity.js'
  )),
  ensureAgentIdentityBestEffort: () => ({
    nhi_id: 'kyberion://agent/test/selection-prewarm-agent',
    recorded: false,
  }),
  bindAgentRuntimeInstanceBestEffort: vi.fn(),
  releaseAgentRuntimeInstanceBestEffort: vi.fn(),
}));

import { agentLifecycle } from '../agent/agent-lifecycle.js';
import { agentRegistry } from '../agent/agent-registry.js';
import { a2aBridge, _resetA2ABridgeForTests } from '../mesh/a2a-bridge.js';
import { ensureMissionTeamRuntime } from './mission-team-orchestrator.js';

const missionId = 'MSN-SELECTION-PREWARM-TEST';
const agentId = 'selection-prewarm-agent';
const selection = {
  mode: 'fixed' as const,
  agent_id: agentId,
  provider: 'codex',
  model_id: 'exact',
};
const assignment: MissionTeamAssignment = {
  team_role: 'planner',
  required: true,
  status: 'assigned',
  agent_id: agentId,
  provider: 'codex',
  modelId: 'exact',
  required_capabilities: ['code'],
  notes: 'test',
  authority_role: null,
  delegation_contract: null,
  requested_selection: selection,
  selection_resolution: { source: 'requested', reason: 'test' },
};
function taskPayload() {
  return {
    context: {
      mission_id: missionId,
      team_role: 'planner',
      execution_mode: 'task',
      provider: 'codex',
      provider_model_id: 'exact',
      requested_selection: selection,
      required_capabilities: ['code'],
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('KYBERION_AGENT_RUNTIME_BACKEND', 'pipe');
  vi.stubEnv('KYBERION_TASK_MODEL_ROUTING', 'advisory');
  _resetA2ABridgeForTests();
  mocks.loadPlan.mockReturnValue({
    mission_id: missionId,
    tier: 'public',
    assignments: [assignment],
  });
  mocks.readDispatch.mockReturnValue(assignment);
  mocks.reserve.mockReturnValue(assignment);
  mocks.staff.mockImplementation(() => ({ plan: mocks.loadPlan(), promoted: [], unfilled: [] }));
  mocks.getHandle.mockImplementation((id: string) => agentLifecycle.getHandle(id) || null);
  mocks.ensureRuntime.mockImplementation((options: SpawnOptions) => agentLifecycle.spawn(options));
  mocks.daemonEnsure.mockRejectedValue(new Error('offline'));
  mocks.boot.mockResolvedValue(undefined);
  mocks.ask.mockResolvedValue({ text: 'exact answer', stopReason: 'completed' });
  mocks.shutdown.mockResolvedValue(undefined);
  mocks.createAdapter.mockResolvedValue({
    boot: mocks.boot,
    ask: mocks.ask,
    shutdown: mocks.shutdown,
  });
});
afterEach(async () => {
  await agentLifecycle.shutdown(agentId);
  _resetA2ABridgeForTests();
  vi.unstubAllEnvs();
});

describe('explicit mission prewarm to A2A lifecycle integration', () => {
  it('adopts a canonically owned prewarmed runtime through lifecycle without restarting its adapter', async () => {
    const prewarm = await ensureMissionTeamRuntime({
      missionId,
      runtimeOwnerId: 'agent-runtime-supervisor:request-test',
      runtimeOwnerType: 'agent-runtime-supervisor',
    });
    expect(prewarm.assignments[0]?.runtime_status).toBe('spawned');
    expect(mocks.ensureRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeOwnerId: missionId,
        runtimeOwnerType: 'mission',
        runtimeMetadata: expect.objectContaining({
          team_role: 'planner',
          execution_mode: 'task',
          requested_runtime_owner_id: 'agent-runtime-supervisor:request-test',
        }),
      })
    );
    const prewarmedHandle = agentLifecycle.getHandle(agentId);
    expect(prewarmedHandle).toBeDefined();
    const handle = await a2aBridge.ensureAgent(agentId, undefined, taskPayload());
    expect(handle).toBe(prewarmedHandle);
    expect(await handle.ask('execute task')).toBe('exact answer');
    expect(mocks.ensureRuntime).toHaveBeenCalledTimes(2);
    expect(mocks.boot).toHaveBeenCalledOnce();
    expect(mocks.createAdapter).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'codex', modelId: 'exact' })
    );
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.shutdown).not.toHaveBeenCalled();
  });

  it('does not let an already-ready record bypass conflicting explicit ownership', async () => {
    await agentLifecycle.spawn({
      agentId,
      provider: 'codex',
      modelId: 'exact',
      missionId,
      runtimeOwnerId: 'another-runtime-owner',
      runtimeOwnerType: 'mission',
      runtimeMetadata: {
        requested_selection: selection,
        required_capabilities: ['code'],
        team_role: 'planner',
        execution_mode: 'task',
      },
    });
    expect(agentRegistry.get(agentId)?.status).toBe('ready');
    const prewarm = await ensureMissionTeamRuntime(missionId);
    expect(prewarm.assignments[0]).toMatchObject({
      runtime_status: 'failed',
      error: expect.stringContaining('RUNTIME_CONFLICT'),
    });
    expect(mocks.ensureRuntime).toHaveBeenCalledOnce();
    await expect(a2aBridge.ensureAgent(agentId, undefined, taskPayload())).rejects.toThrow(
      /RUNTIME_CONFLICT/
    );
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.shutdown).not.toHaveBeenCalled();
    expect(mocks.boot).toHaveBeenCalledOnce();
  });

  it('validates explicit role ownership separately when roles share an exact actor target', async () => {
    mocks.loadPlan.mockReturnValue({
      mission_id: missionId,
      tier: 'public',
      assignments: [assignment, { ...assignment, team_role: 'reviewer' }],
    });
    const result = await ensureMissionTeamRuntime(missionId);
    expect(result.assignments.map((entry) => entry.runtime_status)).toEqual(['spawned', 'failed']);
    expect(result.assignments[1]?.error).toContain('RUNTIME_CONFLICT');
    expect(mocks.ensureRuntime).toHaveBeenCalledTimes(2);
    expect(mocks.boot).toHaveBeenCalledOnce();
    expect(mocks.shutdown).not.toHaveBeenCalled();
  });
});
