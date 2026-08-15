import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentExecutionPort } from './agent-execution-port.js';
import { logger } from './core.js';
import {
  clearWorkCoordinationStore,
  claimWorkItem,
  createWorkItem,
  getWorkItem,
  listActiveWorkLeases,
  releaseWorkItem,
  setWorkCoordinationNamespace,
  updateWorkItem,
} from './work-coordination.js';
import {
  CoordinatedAgentExecutionPort,
  delegateCoordinatedCliSubagentTask,
  delegateCoordinatedAgentTask,
} from './coordinated-agent-execution-port.js';

describe('CoordinatedAgentExecutionPort', () => {
  beforeEach(() => {
    setWorkCoordinationNamespace(`coordinated-agent-execution-port-test-${process.pid}`);
    clearWorkCoordinationStore();
  });

  afterEach(() => {
    clearWorkCoordinationStore();
    setWorkCoordinationNamespace(null);
  });

  it('claims and closes a work item around agent-runtime execution', async () => {
    clearWorkCoordinationStore();
    const item = createWorkItem({
      itemId: 'WI-COORDINATED-001',
      title: 'coordinated task',
      description: 'run through the shared execution boundary',
      projectId: 'MSN-COORDINATED-001',
      status: 'ready',
    });
    const delegatePort: AgentExecutionPort = {
      delegate: vi.fn(async () => ({
        execution_kind: 'agent_delegation' as const,
        task_id: 'task-1',
        agent_id: 'agent-1',
        runtime_id: 'runtime-1',
        provider: 'codex-cli',
        model_id: 'gpt-5.6-luna',
        native_subagent: { threadId: 'thread-1', turnId: 'turn-1' },
        status: 'succeeded' as const,
        output: 'done',
      })),
    };
    const port = new CoordinatedAgentExecutionPort(delegatePort);

    const receipt = await port.delegate({
      work_item_id: item.item_id,
      task_id: 'task-1',
      mission_id: 'MSN-COORDINATED-001',
      agent_id: 'agent-1',
      security_scope: {
        tenant_id: 'default',
        mission_id: 'MSN-COORDINATED-001',
        read_tiers: ['public'],
        write_tier: 'public',
        purpose: 'coordinated execution test',
      },
      instruction: 'execute the task',
      idempotency_key: 'coord-1',
    });

    expect(receipt.work_item_id).toBe(item.item_id);
    expect(receipt.runtime_id).toBe('runtime-1');
    expect(receipt.provider).toBe('codex-cli');
    expect(receipt.model_id).toBe('gpt-5.6-luna');
    expect(receipt.native_subagent).toMatchObject({ threadId: 'thread-1' });
    const stored = getWorkItem(item.item_id);
    expect(stored?.attempts?.[0]?.metadata).toMatchObject({
      attempt_id: expect.any(String),
      provider: 'codex-cli',
      model_id: 'gpt-5.6-luna',
      native_subagent: { threadId: 'thread-1', turnId: 'turn-1' },
    });
    expect(stored?.status).toBe('done');
    expect(listActiveWorkLeases()).toHaveLength(0);
    expect(delegatePort.delegate).toHaveBeenCalledTimes(1);
  });

  it('offers a convenience entry point that keeps WorkItem coordination enabled', async () => {
    clearWorkCoordinationStore();
    const item = createWorkItem({
      itemId: 'WI-COORDINATED-002',
      title: 'convenience task',
      description: 'run through the convenience boundary',
      projectId: 'MSN-COORDINATED-002',
      status: 'ready',
    });
    const receipt = await delegateCoordinatedAgentTask(
      {
        work_item_id: item.item_id,
        task_id: 'task-2',
        mission_id: 'MSN-COORDINATED-002',
        security_scope: {
          tenant_id: 'default',
          mission_id: 'MSN-COORDINATED-002',
          read_tiers: ['public'],
          write_tier: 'public',
          purpose: 'convenience execution test',
        },
        instruction: 'execute the task',
        idempotency_key: 'coord-2',
      },
      {
        delegate: async (request) => ({
          execution_kind: 'agent_delegation' as const,
          task_id: request.task_id,
          agent_id: 'agent-2',
          status: 'succeeded' as const,
          output: 'done',
        }),
      },
      'test-convenience-agent'
    );
    expect(receipt.work_item_id).toBe(item.item_id);
    expect(getWorkItem(item.item_id)?.status).toBe('done');
  });

  it('keeps CLI subagent execution on the shared attempt and lease boundary', async () => {
    clearWorkCoordinationStore();
    const item = createWorkItem({
      itemId: 'WI-COORDINATED-CLI',
      title: 'CLI lifecycle task',
      description: 'run the native CLI subagent through coordination',
      projectId: 'MSN-COORDINATED-CLI',
      status: 'ready',
    });
    const receipt = await delegateCoordinatedCliSubagentTask(
      {
        work_item_id: item.item_id,
        task_id: 'task-cli',
        mission_id: 'MSN-COORDINATED-CLI',
        success_status: 'done',
        security_scope: {
          tenant_id: 'default',
          mission_id: 'MSN-COORDINATED-CLI',
          read_tiers: ['public'],
          write_tier: 'public',
          purpose: 'CLI lifecycle test',
        },
        instruction: 'execute the CLI task',
        idempotency_key: 'coord-cli',
      },
      async () => ({
        execution_kind: 'agent_delegation' as const,
        task_id: 'task-cli',
        agent_id: 'cli-agent',
        provider: 'codex-cli',
        model_id: 'gpt-5.6-luna',
        native_subagent: { mode: 'native-subagent', model: 'gpt-5.6-luna' },
        status: 'succeeded' as const,
        output_ref: `${item.item_id}:result`,
        output: 'done',
      }),
      'cli-agent'
    );

    const stored = getWorkItem(item.item_id);
    expect(receipt.attempt_id).toEqual(stored?.metadata?.attempt_id);
    expect(stored?.attempts?.[0]?.attempt_id).toEqual(expect.any(String));
    expect(stored).toMatchObject({
      status: 'done',
      metadata: {
        work_item_id: item.item_id,
        attempt_id: expect.any(String),
        output_ref: `${item.item_id}:result`,
        lease_status: 'released',
        execution_status: 'succeeded',
      },
    });
    expect(stored?.attempts?.map((attempt) => attempt.status)).toEqual(['released']);
    expect(listActiveWorkLeases()).toHaveLength(0);
  });

  it('closes against the latest leased version after an observability metadata bump', async () => {
    const item = createWorkItem({
      itemId: 'WI-COORDINATED-VERSION-BUMP',
      title: 'version bump task',
      description: 'runtime metadata changes while the provider is running',
      projectId: 'MSN-COORDINATED-VERSION-BUMP',
      status: 'ready',
    });
    const port = new CoordinatedAgentExecutionPort({
      delegate: vi.fn(async () => {
        const claimed = getWorkItem(item.item_id);
        expect(claimed?.status).toBe('in_progress');
        updateWorkItem({
          itemId: item.item_id,
          expectedVersion: claimed?.version,
          metadata: { runtime_observation: 'provider response received' },
        });
        return {
          execution_kind: 'agent_delegation' as const,
          task_id: 'task-version-bump',
          agent_id: 'agent-version-bump',
          status: 'succeeded' as const,
          output: 'done',
        };
      }),
    });

    await expect(
      port.delegate({
        work_item_id: item.item_id,
        task_id: 'task-version-bump',
        mission_id: 'MSN-COORDINATED-VERSION-BUMP',
        security_scope: {
          tenant_id: 'default',
          mission_id: 'MSN-COORDINATED-VERSION-BUMP',
          read_tiers: ['public'],
          write_tier: 'public',
          purpose: 'version bump test',
        },
        instruction: 'execute the task',
        idempotency_key: 'coord-version-bump',
      })
    ).resolves.toMatchObject({ status: 'succeeded' });

    expect(getWorkItem(item.item_id)).toMatchObject({
      status: 'done',
      metadata: { runtime_observation: 'provider response received' },
    });
    expect(listActiveWorkLeases()).toHaveLength(0);
  });

  it('fails closed when the lease is transferred before the original worker closes the item', async () => {
    const item = createWorkItem({
      itemId: 'WI-COORDINATED-LEASE-TRANSFER',
      title: 'lease transfer task',
      description: 'the provider returns after another worker owns the lease',
      projectId: 'MSN-COORDINATED-LEASE-TRANSFER',
      status: 'ready',
    });
    let transferredLeaseId: string | undefined;
    const port = new CoordinatedAgentExecutionPort({
      delegate: vi.fn(async () => {
        const claimed = getWorkItem(item.item_id);
        expect(claimed).toMatchObject({
          status: 'in_progress',
          lease_id: expect.any(String),
        });
        const released = releaseWorkItem({
          itemId: item.item_id,
          leaseId: claimed?.lease_id as string,
          actorPeerId: 'coordinated-agent-execution-port',
          nextStatus: 'ready',
          expectedVersion: claimed?.version,
        });
        const transferred = claimWorkItem({
          itemId: item.item_id,
          actorPeerId: 'replacement-agent',
          purpose: 'take over the transferred provider task',
          expectedVersion: released.item.version,
          idempotencyKey: 'coord-lease-transfer-replacement',
        });
        transferredLeaseId = transferred.lease.lease_id;
        return {
          execution_kind: 'agent_delegation' as const,
          task_id: 'task-lease-transfer',
          agent_id: 'agent-lease-transfer',
          status: 'succeeded' as const,
          output: 'late provider response',
        };
      }),
    });

    await expect(
      port.delegate({
        work_item_id: item.item_id,
        task_id: 'task-lease-transfer',
        mission_id: 'MSN-COORDINATED-LEASE-TRANSFER',
        security_scope: {
          tenant_id: 'default',
          mission_id: 'MSN-COORDINATED-LEASE-TRANSFER',
          read_tiers: ['public'],
          write_tier: 'public',
          purpose: 'lease transfer test',
        },
        instruction: 'execute the task',
        idempotency_key: 'coord-lease-transfer',
      })
    ).rejects.toThrow(/version conflict/i);

    expect(transferredLeaseId).toEqual(expect.any(String));
    expect(getWorkItem(item.item_id)).toMatchObject({
      status: 'in_progress',
      lease_id: transferredLeaseId,
      claimed_by_peer_id: 'replacement-agent',
    });
    expect(listActiveWorkLeases()).toHaveLength(1);
  });

  it('keeps review-required work items in review after successful execution', async () => {
    clearWorkCoordinationStore();
    const item = createWorkItem({
      itemId: 'WI-COORDINATED-REVIEW',
      title: 'review task',
      description: 'execute then review',
      projectId: 'MSN-COORDINATED-REVIEW',
      status: 'ready',
    });
    await delegateCoordinatedAgentTask(
      {
        work_item_id: item.item_id,
        task_id: 'task-review',
        mission_id: 'MSN-COORDINATED-REVIEW',
        success_status: 'review',
        security_scope: {
          tenant_id: 'default',
          mission_id: 'MSN-COORDINATED-REVIEW',
          read_tiers: ['public'],
          write_tier: 'public',
          purpose: 'review transition test',
        },
        instruction: 'execute review task',
        idempotency_key: 'coord-review',
      },
      {
        delegate: async (request) =>
          ({
            execution_kind: 'agent_delegation',
            task_id: request.task_id,
            agent_id: 'agent-review',
            status: 'succeeded',
            output: 'done',
          }) as const,
      }
    );
    expect(getWorkItem(item.item_id)?.status).toBe('review');
  });

  it('logs a structured error and blocks the work item when the delegate throws (e.g. sandbox failure)', async () => {
    clearWorkCoordinationStore();
    const item = createWorkItem({
      itemId: 'WI-COORDINATED-SANDBOX-THROW',
      title: 'sandbox failure task',
      description: 'provider CLI subagent rejects due to a sandbox restriction',
      projectId: 'MSN-COORDINATED-SANDBOX-THROW',
      status: 'ready',
    });
    const loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const port = new CoordinatedAgentExecutionPort({
      delegate: vi.fn(async () => {
        throw new Error('sandbox denied: permission to spawn provider CLI was refused');
      }),
    });

    await expect(
      port.delegate({
        work_item_id: item.item_id,
        task_id: 'task-sandbox-throw',
        mission_id: 'MSN-COORDINATED-SANDBOX-THROW',
        security_scope: {
          tenant_id: 'default',
          mission_id: 'MSN-COORDINATED-SANDBOX-THROW',
          read_tiers: ['public'],
          write_tier: 'public',
          purpose: 'sandbox failure test',
        },
        instruction: 'execute the task',
        idempotency_key: 'coord-sandbox-throw',
      })
    ).rejects.toThrow('sandbox denied');

    expect(loggerErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('sandbox denied: permission to spawn provider CLI was refused')
    );
    expect(getWorkItem(item.item_id)).toMatchObject({
      status: 'blocked',
      metadata: expect.objectContaining({
        result: expect.objectContaining({
          error: expect.stringContaining('sandbox denied'),
        }),
      }),
    });
    loggerErrorSpy.mockRestore();
  });

  it('logs a structured error when the delegate returns a failed receipt without throwing', async () => {
    clearWorkCoordinationStore();
    const item = createWorkItem({
      itemId: 'WI-COORDINATED-SANDBOX-RECEIPT',
      title: 'sandbox failure receipt task',
      description: 'provider CLI subagent returns a failed receipt instead of throwing',
      projectId: 'MSN-COORDINATED-SANDBOX-RECEIPT',
      status: 'ready',
    });
    const loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const port = new CoordinatedAgentExecutionPort({
      delegate: vi.fn(async (request) => ({
        execution_kind: 'agent_delegation' as const,
        task_id: request.task_id,
        agent_id: 'agent-sandbox',
        status: 'failed' as const,
        error: 'sandbox denied: no Bash/shell execution tool available in this session',
      })),
    });

    const receipt = await port.delegate({
      work_item_id: item.item_id,
      task_id: 'task-sandbox-receipt',
      mission_id: 'MSN-COORDINATED-SANDBOX-RECEIPT',
      security_scope: {
        tenant_id: 'default',
        mission_id: 'MSN-COORDINATED-SANDBOX-RECEIPT',
        read_tiers: ['public'],
        write_tier: 'public',
        purpose: 'sandbox failure receipt test',
      },
      instruction: 'execute the task',
      idempotency_key: 'coord-sandbox-receipt',
    });

    expect(receipt.status).toBe('failed');
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('sandbox denied: no Bash/shell execution tool available')
    );
    expect(getWorkItem(item.item_id)?.status).toBe('blocked');
    loggerErrorSpy.mockRestore();
  });
});
