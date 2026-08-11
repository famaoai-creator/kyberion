import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentExecutionPort } from './agent-execution-port.js';
import {
  clearWorkCoordinationStore,
  createWorkItem,
  getWorkItem,
  listActiveWorkLeases,
  setWorkCoordinationNamespace,
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
});
