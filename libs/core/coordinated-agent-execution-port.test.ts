import { describe, expect, it, vi } from 'vitest';
import type { AgentExecutionPort } from './agent-execution-port.js';
import { clearWorkCoordinationStore, createWorkItem, getWorkItem } from './work-coordination.js';
import {
  CoordinatedAgentExecutionPort,
  delegateCoordinatedAgentTask,
} from './coordinated-agent-execution-port.js';

describe('CoordinatedAgentExecutionPort', () => {
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
    expect(getWorkItem(item.item_id)?.status).toBe('done');
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
