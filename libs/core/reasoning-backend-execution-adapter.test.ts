import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  delegateWorkItemWithReasoningBackend,
  ReasoningBackendExecutionAdapter,
} from './reasoning-backend-execution-adapter.js';
import {
  clearWorkCoordinationStore,
  createWorkItem,
  getWorkItem,
  setWorkCoordinationNamespace,
} from './work-coordination.js';

describe('ReasoningBackendExecutionAdapter', () => {
  beforeEach(() => {
    setWorkCoordinationNamespace(`reasoning-backend-execution-adapter-test-${process.pid}`);
    clearWorkCoordinationStore();
  });

  afterEach(() => {
    clearWorkCoordinationStore();
    setWorkCoordinationNamespace(null);
  });

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

  it('preserves native adopter proof and explicit model identity without legacy delegation', async () => {
    const delegateTask = async () => {
      throw new Error('legacy delegateTask must not be called');
    };
    const adapter = new ReasoningBackendExecutionAdapter({
      name: 'backend-name',
      model: 'backend-model',
      delegateTask,
      getNativeSubagentAdopter: () => ({
        id: 'native-adopter',
        dispatch: async () => 'native-output',
        getInfo: () => ({
          provider: 'native-provider',
          model: 'native-model',
          threadId: 'thread-1',
        }),
      }),
    } as never);
    const receipt = await adapter.delegate({
      task_id: 'native-task',
      model_id: 'explicit-model',
      security_scope: {
        tenant_id: 'default',
        mission_id: 'M-NATIVE',
        read_tiers: ['public'],
        write_tier: 'public',
        purpose: 'native adapter test',
      },
      instruction: 'run native',
      idempotency_key: 'native-1',
    });
    expect(receipt).toMatchObject({
      status: 'succeeded',
      output: 'native-output',
      provider: 'native-provider',
      model_id: 'explicit-model',
      native_subagent: {
        adopter_id: 'native-adopter',
        threadId: 'thread-1',
      },
    });
  });

  it('captures provider-native identity published after dispatch', async () => {
    let dispatched = false;
    const adapter = new ReasoningBackendExecutionAdapter({
      name: 'backend-name',
      delegateTask: async () => 'legacy-output',
      getNativeSubagentAdopter: () => ({
        id: 'late-native-adopter',
        dispatch: async () => {
          dispatched = true;
          return 'native-output';
        },
        getInfo: () =>
          dispatched
            ? {
                provider: 'native-provider',
                model: 'native-model',
                threadId: 'thread-after-dispatch',
              }
            : null,
      }),
    } as never);

    const receipt = await adapter.delegate({
      task_id: 'late-native-task',
      security_scope: {
        tenant_id: 'default',
        mission_id: 'M-LATE-NATIVE',
        read_tiers: ['public'],
        write_tier: 'public',
        purpose: 'late native adapter test',
      },
      instruction: 'run late native',
      idempotency_key: 'late-native-1',
    });

    expect(receipt).toMatchObject({
      provider: 'native-provider',
      model_id: 'native-model',
      native_subagent: { adopter_id: 'late-native-adopter', threadId: 'thread-after-dispatch' },
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
