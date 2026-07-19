import type { AgentProvider } from './agent-registry.js';
import {
  askAgentRuntime,
  ensureAgentRuntime,
  getAgentRuntimeSnapshot,
} from './agent-runtime-supervisor.js';
import {
  validateContextSecurityScope,
  type ContextSecurityScope,
} from './context-security-scope.js';

export interface AgentTaskEnvelope {
  task_id: string;
  mission_id?: string;
  agent_id?: string;
  agent_profile_id?: string;
  team_role_id?: string;
  authority_role_id?: string;
  security_scope: ContextSecurityScope;
  instruction: string;
  context_refs?: string[];
  capabilities?: string[];
  timeout_ms?: number;
  idempotency_key: string;
  provider?: AgentProvider;
  model_id?: string;
}

export interface AgentExecutionReceipt {
  execution_kind: 'agent_delegation';
  task_id: string;
  agent_id: string;
  runtime_id?: string;
  provider?: string;
  model_id?: string;
  status: 'submitted' | 'running' | 'succeeded' | 'failed' | 'canceled';
  started_at?: string;
  completed_at?: string;
  output_ref?: string;
  output?: string;
  error?: string;
}

export interface AgentExecutionPort {
  delegate(request: AgentTaskEnvelope): Promise<AgentExecutionReceipt>;
}

function validateEnvelope(request: AgentTaskEnvelope): void {
  const errors = validateContextSecurityScope(request.security_scope);
  if (!request.task_id.trim()) errors.push('task_id is required');
  if (!request.instruction.trim()) errors.push('instruction is required');
  if (!request.idempotency_key.trim()) errors.push('idempotency_key is required');
  if (errors.length > 0) throw new Error(`[AGENT_TASK_INVALID] ${errors.join('; ')}`);
}

export class SupervisorAgentExecutionPort implements AgentExecutionPort {
  async delegate(request: AgentTaskEnvelope): Promise<AgentExecutionReceipt> {
    validateEnvelope(request);
    const startedAt = new Date().toISOString();
    const agentId = request.agent_id || `task-agent-${request.task_id}`;
    try {
      const handle = await ensureAgentRuntime({
        agentId,
        provider: request.provider || 'claude',
        modelId: request.model_id,
        missionId: request.mission_id,
        capabilities: request.capabilities,
        requestedBy: 'agent_execution_port',
        runtimeMetadata: {
          execution_kind: 'agent_delegation',
          idempotency_key: request.idempotency_key,
          security_scope: request.security_scope,
          agent_profile_id: request.agent_profile_id,
          team_role_id: request.team_role_id,
          authority_role_id: request.authority_role_id,
        },
      });
      const response = await askAgentRuntime(agentId, request.instruction, 'agent_execution_port', {
        timeoutMs: request.timeout_ms,
        correlationId: request.idempotency_key,
      });
      const snapshot = getAgentRuntimeSnapshot(agentId);
      return {
        execution_kind: 'agent_delegation',
        task_id: request.task_id,
        agent_id: agentId,
        runtime_id: snapshot?.agent.agentId || handle.agentId,
        provider: snapshot?.agent.provider || handle.getRecord()?.provider,
        model_id: snapshot?.agent.modelId || handle.getRecord()?.modelId,
        status: 'succeeded',
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        output_ref: `${request.task_id}:result`,
        output: response,
      };
    } catch (error) {
      return {
        execution_kind: 'agent_delegation',
        task_id: request.task_id,
        agent_id: agentId,
        status: 'failed',
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

let registeredAgentExecutionPort: AgentExecutionPort | undefined;

export function registerAgentExecutionPort(port: AgentExecutionPort): void {
  registeredAgentExecutionPort = port;
}

export function getAgentExecutionPort(): AgentExecutionPort {
  return (registeredAgentExecutionPort ||= new SupervisorAgentExecutionPort());
}
