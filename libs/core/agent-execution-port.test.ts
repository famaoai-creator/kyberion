import { describe, expect, it } from 'vitest';
import { SupervisorAgentExecutionPort, type AgentTaskEnvelope } from './agent-execution-port.js';

describe('AgentExecutionPort', () => {
  it('rejects an invalid task envelope before resolving a runtime', async () => {
    const request = {
      task_id: '',
      mission_id: 'MSN-1',
      agent_id: 'agent-1',
      security_scope: {
        tenant_id: 'tenant-a',
        mission_id: 'MSN-1',
        read_tiers: ['public'],
        write_tier: 'public',
        purpose: 'test',
      },
      instruction: 'Inspect the task.',
      idempotency_key: 'task-1',
    } satisfies AgentTaskEnvelope;

    await expect(new SupervisorAgentExecutionPort().delegate(request)).rejects.toThrow(
      '[AGENT_TASK_INVALID]'
    );
  });
});
