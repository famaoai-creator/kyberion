import type {
  AgentExecutionPort,
  AgentExecutionReceipt,
  AgentTaskEnvelope,
} from './agent-execution-port.js';
import type { ReasoningBackend } from './reasoning-backend.js';
import {
  delegateCoordinatedAgentTask,
  type CoordinatedAgentExecutionReceipt,
  type CoordinatedAgentTaskEnvelope,
} from './coordinated-agent-execution-port.js';

/** Adapts the legacy text delegateTask contract to the typed execution port. */
export class ReasoningBackendExecutionAdapter implements AgentExecutionPort {
  constructor(
    private readonly backend: ReasoningBackend,
    private readonly signal?: AbortSignal
  ) {}

  async delegate(request: AgentTaskEnvelope): Promise<AgentExecutionReceipt> {
    const startedAt = new Date().toISOString();
    try {
      const output = await this.backend.delegateTask(
        request.instruction,
        request.context_refs?.join('\n'),
        { signal: this.signal }
      );
      return {
        execution_kind: 'agent_delegation',
        task_id: request.task_id,
        agent_id: request.agent_id || `task-agent-${request.task_id}`,
        provider: this.backend.name,
        status: 'succeeded',
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        output_ref: `${request.task_id}:result`,
        output,
      };
    } catch (error) {
      return {
        execution_kind: 'agent_delegation',
        task_id: request.task_id,
        agent_id: request.agent_id || `task-agent-${request.task_id}`,
        provider: this.backend.name,
        status: 'failed',
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

/** Execute a legacy reasoning delegation while preserving WorkItem lifecycle. */
export function delegateWorkItemWithReasoningBackend(
  backend: ReasoningBackend,
  request: CoordinatedAgentTaskEnvelope,
  actorPeerId?: string,
  signal?: AbortSignal
): Promise<CoordinatedAgentExecutionReceipt> {
  return delegateCoordinatedAgentTask(
    request,
    new ReasoningBackendExecutionAdapter(backend, signal),
    actorPeerId
  );
}
