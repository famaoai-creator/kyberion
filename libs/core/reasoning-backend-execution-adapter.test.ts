import { describe, expect, it } from 'vitest';
import {
  delegateWorkItemWithReasoningBackend,
  ReasoningBackendExecutionAdapter,
} from './reasoning-backend-execution-adapter.js';
import { clearWorkCoordinationStore, createWorkItem, getWorkItem } from './work-coordination.js';

describe('ReasoningBackendExecutionAdapter', () => {
  it('maps text delegation to a typed receipt', async () => {
    const adapter = new ReasoningBackendExecutionAdapter({
      name: 'test-backend',
      delegateTask: async (instruction) => `done:${instruction}`,
    } as never);
    const receipt = await adapter.delegate({
      task_id: 'task-adapter',
      security_scope: {
        tenant_id: 'default',
        mission_id: 'M-ADAPTER',
        read_tiers: ['public'],
        write_tier: 'public',
        purpose: 'adapter test',
      },
      instruction: 'run adapter',
      idempotency_key: 'adapter-1',
    });
    expect(receipt).toMatchObject({
      status: 'succeeded',
      output: 'done:run adapter',
      provider: 'test-backend',
    });
  });

  it('combines the adapter with WorkItem lifecycle management', async () => {
    clearWorkCoordinationStore();
    const item = createWorkItem({
      itemId: 'WI-REASONING-ADAPTER',
      title: 'reasoning task',
      description: 'execute reasoning through the shared lifecycle',
      projectId: 'M-REASONING-ADAPTER',
      status: 'ready',
    });
    const receipt = await delegateWorkItemWithReasoningBackend(
      { name: 'test-backend', delegateTask: async () => 'completed' } as never,
      {
        work_item_id: item.item_id,
        task_id: 'task-reasoning',
        mission_id: 'M-REASONING-ADAPTER',
        security_scope: {
          tenant_id: 'default',
          mission_id: 'M-REASONING-ADAPTER',
          read_tiers: ['public'],
          write_tier: 'public',
          purpose: 'adapter lifecycle test',
        },
        instruction: 'complete reasoning task',
        idempotency_key: 'reasoning-adapter-1',
      }
    );
    expect(receipt.output).toBe('completed');
    expect(getWorkItem(item.item_id)?.status).toBe('done');
  });
});
