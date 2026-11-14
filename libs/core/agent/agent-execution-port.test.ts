import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureAgentRuntime: vi.fn(),
  askAgentRuntime: vi.fn(),
  refreshAgentRuntime: vi.fn(),
  getAgentRuntimeSnapshot: vi.fn(),
  getAgentRuntimeHandle: vi.fn(),
  appendSupervisorEvent: vi.fn(),
  getWorkItem: vi.fn(),
  listActiveWorkLeases: vi.fn(),
  auditRecord: vi.fn(),
}));

vi.mock('../governance/audit-chain.js', () => ({
  auditChain: { record: mocks.auditRecord },
}));

vi.mock('./agent-runtime-supervisor.js', () => ({
  ensureAgentRuntime: mocks.ensureAgentRuntime,
  askAgentRuntime: mocks.askAgentRuntime,
  refreshAgentRuntime: mocks.refreshAgentRuntime,
  getAgentRuntimeSnapshot: mocks.getAgentRuntimeSnapshot,
  getAgentRuntimeHandle: mocks.getAgentRuntimeHandle,
  appendSupervisorEvent: mocks.appendSupervisorEvent,
}));

vi.mock('../workforce/work-coordination.js', () => ({
  getWorkItem: mocks.getWorkItem,
  listActiveWorkLeases: mocks.listActiveWorkLeases,
}));

import {
  SupervisorAgentExecutionPort,
  getAgentExecutionPort,
  registerAgentExecutionPort,
  resetAgentExecutionPort,
  type AgentExecutionPort,
  type AgentTaskEnvelope,
} from './agent-execution-port.js';

function envelope(overrides: Partial<AgentTaskEnvelope> = {}): AgentTaskEnvelope {
  return {
    task_id: 'T-1',
    mission_id: 'MSN-PORT-1',
    agent_id: 'worker-1',
    instruction: 'do the task',
    idempotency_key: 'idem-1',
    security_scope: {
      mission_id: 'MSN-PORT-1',
      read_tiers: ['public'],
      write_tier: 'public',
      purpose: 'port test',
    },
    ...overrides,
  };
}

function runtimeMetadata(): Record<string, unknown> {
  return mocks.ensureAgentRuntime.mock.calls[0]![0].runtimeMetadata;
}

const readOnlyHandle = {
  agentId: 'worker-1',
  getRecord: () => ({ metadata: { tool_access: 'read-only' } }),
};

describe('SupervisorAgentExecutionPort.delegate', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.ensureAgentRuntime.mockResolvedValue(readOnlyHandle);
    mocks.getAgentRuntimeHandle.mockReturnValue(readOnlyHandle);
    mocks.askAgentRuntime.mockResolvedValue('done');
    mocks.listActiveWorkLeases.mockReturnValue([]);
  });

  const audit = (result: string, extra: Record<string, unknown> = {}) =>
    expect.objectContaining({
      agentId: 'worker-1',
      action: 'agent_delegation_unclaimed',
      operation: 'delegate',
      result,
      correlationId: 'idem-1',
      metadata: {
        task_id: 'T-1',
        mission_id: 'MSN-PORT-1',
        provider: 'claude',
        tool_access: 'read-only',
        ...extra,
      },
    });
  const auditResults = () => mocks.auditRecord.mock.calls.map(([entry]) => entry.result);

  it('runs an unclaimed delegation with no binding or caller-asserted label, and records decision and outcome', async () => {
    // Everything a caller could put on the envelope to look claimed or privileged.
    const request = {
      ...envelope({
        agent_profile_id: 'reasoning-worker',
        team_role_id: 'implementer',
        authority_role_id: 'software_developer',
      }),
      lease_id: 'LEASE-FORGED',
      capability_profile: 'implementer',
      team_role: 'implementer',
    } as AgentTaskEnvelope;

    const receipt = await new SupervisorAgentExecutionPort().delegate(request);

    expect(receipt).toMatchObject({ status: 'succeeded', output: 'done' });
    expect(mocks.getWorkItem).not.toHaveBeenCalled();
    expect(Object.keys(runtimeMetadata()).sort()).toEqual([
      'execution_kind',
      'idempotency_key',
      'security_scope',
    ]);
    expect(auditResults()).toEqual(['allowed', 'completed']);
    expect(mocks.auditRecord).toHaveBeenNthCalledWith(1, audit('allowed'));
    expect(mocks.auditRecord).toHaveBeenNthCalledWith(2, audit('completed'));
    expect(mocks.auditRecord.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.ensureAgentRuntime.mock.invocationCallOrder[0]!
    );
    expect(mocks.appendSupervisorEvent).toHaveBeenCalledWith({
      decision: 'agent_delegation_unclaimed',
      agent_id: 'worker-1',
      task_id: 'T-1',
      mission_id: 'MSN-PORT-1',
      requested_by: 'agent_execution_port',
      provider: 'claude',
      tool_access: 'read-only',
      idempotency_key: 'idem-1',
    });
    // No claim, so the runtime is launched read-only (the lifecycle refuses a
    // provider that cannot be).
    expect(mocks.ensureAgentRuntime.mock.calls[0]![0].toolAccess).toBe('read-only');
  });

  it.each([
    ['a different runtime instance', { agentId: 'worker-1', getRecord: readOnlyHandle.getRecord }],
    [
      'a runtime that is not read-only',
      { agentId: 'worker-1', getRecord: () => ({ metadata: {} }) },
    ],
    ['no runtime', null],
  ])(
    'refuses to send an unclaimed instruction to %s found at ask time',
    async (_label, current) => {
      mocks.getAgentRuntimeHandle.mockReturnValue(current);

      const receipt = await new SupervisorAgentExecutionPort().delegate(envelope());

      expect(receipt.status).toBe('failed');
      expect(receipt.error).toContain('[AGENT_RUNTIME_TOOL_MODE_CHANGED]');
      expect(mocks.askAgentRuntime).not.toHaveBeenCalled();
      expect(auditResults()).toEqual(['allowed', 'failed']);
    }
  );

  it('records a failed outcome with the error code only when the unclaimed run fails', async () => {
    mocks.askAgentRuntime.mockRejectedValue(
      new Error('[RUNTIME_SCOPE_MISMATCH] secret provider detail')
    );

    const receipt = await new SupervisorAgentExecutionPort().delegate(envelope());

    expect(receipt.status).toBe('failed');
    expect(auditResults()).toEqual(['allowed', 'failed']);
    expect(mocks.auditRecord).toHaveBeenNthCalledWith(
      2,
      audit('failed', { error_code: 'RUNTIME_SCOPE_MISMATCH' })
    );
    expect(JSON.stringify(mocks.auditRecord.mock.calls)).not.toContain('secret provider detail');
  });

  it.each([
    ['a different scope mission', { mission_id: 'MSN-OTHER' }],
    ['a scope mission but no request mission', { mission_id: undefined }],
  ])(
    'refuses an unclaimed delegation with %s and records the denial',
    async (_label, overrides) => {
      const receipt = await new SupervisorAgentExecutionPort().delegate(envelope(overrides));

      expect(receipt.status).toBe('failed');
      expect(receipt.error).toContain('[AGENT_TASK_MISSION_MISMATCH]');
      expect(mocks.ensureAgentRuntime).not.toHaveBeenCalled();
      expect(mocks.askAgentRuntime).not.toHaveBeenCalled();
      expect(mocks.appendSupervisorEvent).not.toHaveBeenCalled();
      expect(mocks.auditRecord).toHaveBeenCalledTimes(1);
      expect(mocks.auditRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'agent_delegation_unclaimed',
          result: 'denied',
          metadata: {
            task_id: 'T-1',
            mission_id: overrides.mission_id,
            provider: 'claude',
            tool_access: 'read-only',
            error_code: 'AGENT_TASK_MISSION_MISMATCH',
          },
        })
      );
    }
  );

  it('keeps the claimed path: binding comes from the WorkItem lease, and no unclaimed event', async () => {
    mocks.getWorkItem.mockReturnValue({
      item_id: 'WI-1',
      status: 'in_progress',
      lease_id: 'LEASE-1',
      claimed_by_peer_id: 'worker-1',
      context: { mission_id: 'MSN-PORT-1', task_id: 'T-1' },
      metadata: { team_role: 'implementer' },
    });
    mocks.listActiveWorkLeases.mockReturnValue([
      { item_id: 'WI-1', lease_id: 'LEASE-1', holder_peer_id: 'worker-1' },
    ]);

    const receipt = await new SupervisorAgentExecutionPort().delegate(
      envelope({ work_item_id: 'WI-1', team_role_id: 'implementer' })
    );

    expect(receipt.status).toBe('succeeded');
    expect(runtimeMetadata()).toMatchObject({
      work_item_id: 'WI-1',
      lease_id: 'LEASE-1',
      task_id: 'T-1',
      capability_profile: 'implementer',
      team_role: 'implementer',
      // A claimed task keeps the role labels its envelope names.
      team_role_id: 'implementer',
    });
    // A claimed runtime gets governed task tools, not the read-only mode.
    expect(mocks.ensureAgentRuntime.mock.calls[0]![0].toolAccess).toBeUndefined();
    expect(mocks.appendSupervisorEvent).not.toHaveBeenCalled();
    expect(mocks.auditRecord).not.toHaveBeenCalled();
  });

  it('keeps the claimed path: a claim held by another worker is refused', async () => {
    mocks.getWorkItem.mockReturnValue({
      item_id: 'WI-1',
      status: 'in_progress',
      lease_id: 'LEASE-1',
      claimed_by_peer_id: 'someone-else',
      context: { mission_id: 'MSN-PORT-1', task_id: 'T-1' },
    });
    mocks.listActiveWorkLeases.mockReturnValue([
      { item_id: 'WI-1', lease_id: 'LEASE-1', holder_peer_id: 'someone-else' },
    ]);

    const receipt = await new SupervisorAgentExecutionPort().delegate(
      envelope({ work_item_id: 'WI-1' })
    );

    expect(receipt.status).toBe('failed');
    expect(receipt.error).toContain('[TASK_TOOL_BINDING]');
    expect(mocks.ensureAgentRuntime).not.toHaveBeenCalled();
  });
});

describe('agent execution port seam', () => {
  afterEach(() => resetAgentExecutionPort());

  it('keeps the supervisor fallback when no provider is registered', () => {
    expect(getAgentExecutionPort().constructor.name).toBe('SupervisorAgentExecutionPort');
  });

  it('rejects a second sole provider', () => {
    const first: AgentExecutionPort = {
      delegate: async () => ({
        execution_kind: 'agent_delegation',
        task_id: 't',
        agent_id: 'a',
        status: 'submitted',
      }),
    };
    const second: AgentExecutionPort = {
      delegate: async () => ({
        execution_kind: 'agent_delegation',
        task_id: 't',
        agent_id: 'b',
        status: 'submitted',
      }),
    };
    registerAgentExecutionPort(first);
    expect(() => registerAgentExecutionPort(second)).toThrow(/already registered/);
  });
});
