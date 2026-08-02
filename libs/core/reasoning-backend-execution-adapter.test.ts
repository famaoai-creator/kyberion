import { describe, expect, it } from 'vitest';
import { ReasoningBackendExecutionAdapter } from './reasoning-backend-execution-adapter.js';

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
});
