import { afterEach, describe, expect, it } from 'vitest';
import {
  getAgentExecutionPort,
  registerAgentExecutionPort,
  resetAgentExecutionPort,
  type AgentExecutionPort,
} from './agent-execution-port.js';

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
