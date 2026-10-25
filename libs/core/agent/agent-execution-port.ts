import type { AgentProvider } from './agent-registry.js';
import type { AgentContextMode } from '../context-boundary.js';
import {
  askAgentRuntime,
  ensureAgentRuntime,
  getAgentRuntimeSnapshot,
  refreshAgentRuntime,
} from './agent-runtime-supervisor.js';
import {
  validateContextSecurityScope,
  type ContextSecurityScope,
} from '../context-security-scope.js';
import type { EventScopeInput } from '../event-scope.js';
import { nowIso } from '../foundation/time.js';
import { coreSeamCatalog, createSeam } from '../seam.js';
import { getWorkItem, listActiveWorkLeases } from '../workforce/work-coordination.js';
import { resolveDelegationCapabilityProfile } from '../subagent-capability-profiles.js';

export interface AgentTaskEnvelope {
  /** Optional canonical WorkItem; lease/profile authority is always re-derived server-side. */
  work_item_id?: string;
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
  context_mode?: AgentContextMode;
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
  /** Provider-native execution proof, when the task used a native subagent surface. */
  native_subagent?: Record<string, unknown>;
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
    const startedAt = nowIso();
    const agentId = request.agent_id || `task-agent-${request.task_id}`;
    try {
      let taskBinding: Record<string, unknown> | undefined;
      if (request.work_item_id) {
        const item = getWorkItem(request.work_item_id);
        const taskId = item?.context?.task_id;
        const lease = listActiveWorkLeases().find(
          (candidate) =>
            candidate.item_id === request.work_item_id && candidate.lease_id === item?.lease_id
        );
        if (
          !item ||
          item.status !== 'in_progress' ||
          !taskId ||
          taskId !== request.task_id ||
          item.context?.mission_id !== request.mission_id ||
          request.security_scope.mission_id !== request.mission_id ||
          !lease ||
          lease.holder_peer_id !== agentId ||
          item.claimed_by_peer_id !== agentId
        )
          throw new Error(
            '[TASK_TOOL_BINDING] Default API runtime requires the current worker-owned mission/task claim'
          );
        const role =
          typeof item.metadata?.team_role === 'string' ? item.metadata.team_role : undefined;
        taskBinding = {
          work_item_id: item.item_id,
          lease_id: lease.lease_id,
          task_id: taskId,
          capability_profile: role
            ? resolveDelegationCapabilityProfile({
                teamRole: role,
                purpose: item.metadata?.purpose === 'review' ? 'review' : 'implementation',
              })
            : 'explorer',
          ...(role ? { team_role: role } : {}),
        };
      }
      const handle = await ensureAgentRuntime({
        agentId,
        provider: request.provider || 'claude',
        modelId: request.model_id,
        missionId: request.mission_id,
        capabilities: request.capabilities,
        scope: {
          scope_kind: 'mission',
          tier: request.security_scope.write_tier,
          tenant_slug: request.security_scope.tenant_slug || request.security_scope.tenant_id,
          organization_id: request.security_scope.organization_id,
          project_id: request.security_scope.project_id,
          mission_id: request.security_scope.mission_id,
        } satisfies EventScopeInput,
        requestedBy: 'agent_execution_port',
        runtimeMetadata: {
          execution_kind: 'agent_delegation',
          idempotency_key: request.idempotency_key,
          security_scope: request.security_scope,
          agent_profile_id: request.agent_profile_id,
          team_role_id: request.team_role_id,
          authority_role_id: request.authority_role_id,
          ...taskBinding,
        },
      });
      if (request.context_mode === 'fresh') {
        await refreshAgentRuntime(agentId, 'agent_execution_port');
      }
      const response = await askAgentRuntime(agentId, request.instruction, 'agent_execution_port', {
        timeoutMs: request.timeout_ms,
        correlationId: request.idempotency_key,
        missionId: request.mission_id,
        scope: {
          scope_kind: 'mission',
          tier: request.security_scope.write_tier,
          tenant_slug: request.security_scope.tenant_slug || request.security_scope.tenant_id,
          organization_id: request.security_scope.organization_id,
          project_id: request.security_scope.project_id,
          mission_id: request.security_scope.mission_id,
        },
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
        completed_at: nowIso(),
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
        completed_at: nowIso(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

const agentExecutionPortSeam = createSeam<AgentExecutionPort>({
  key: 'agent-execution-port',
  multiplicity: 'sole',
  catalog: coreSeamCatalog,
  owner: 'libs/core/agent/agent-execution-port.ts',
});
let registeredDisposer: (() => void) | null = null;

export function registerAgentExecutionPort(port: AgentExecutionPort): () => void {
  registeredDisposer = agentExecutionPortSeam.register('default', port, {
    provenance: 'builtin',
    source: 'agent-execution-port',
  });
  return registeredDisposer;
}

export function resetAgentExecutionPort(): void {
  registeredDisposer?.();
  registeredDisposer = null;
}

export function getAgentExecutionPort(): AgentExecutionPort {
  return agentExecutionPortSeam.getOptional() ?? new SupervisorAgentExecutionPort();
}
