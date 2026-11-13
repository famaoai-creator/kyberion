import type { AgentProvider } from './agent-registry.js';
import type { AgentContextMode } from '../contracts/context-boundary.js';
import {
  appendSupervisorEvent,
  askAgentRuntime,
  ensureAgentRuntime,
  getAgentRuntimeSnapshot,
  refreshAgentRuntime,
} from './agent-runtime-supervisor.js';
import {
  validateContextSecurityScope,
  type ContextSecurityScope,
} from '../governance/context-security-scope.js';
import type { EventScopeInput } from '../event/event-scope.js';
import { nowIso } from '../foundation/time.js';
import { auditChain } from '../governance/audit-chain.js';
import { coreSeamCatalog, createSeam, createSeamLifecycle } from '../seam.js';
import { getWorkItem, listActiveWorkLeases } from '../workforce/work-coordination.js';
import { resolveDelegationCapabilityProfile } from '../workforce/subagent-capability-profiles.js';

export interface AgentTaskEnvelope {
  /**
   * Optional canonical WorkItem; lease/profile authority is always re-derived
   * server-side. Without it the delegation is unclaimed: it gets no task tool
   * binding, lease or capability profile, and is recorded as
   * `agent_delegation_unclaimed`.
   */
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

/** Execution states of a receipt (not messages); see `coordination-act-map.ts`. */
export const AGENT_EXECUTION_RECEIPT_STATUSES = Object.freeze([
  'submitted',
  'running',
  'succeeded',
  'failed',
  'canceled',
] as const);
export type AgentExecutionReceiptStatus = (typeof AGENT_EXECUTION_RECEIPT_STATUSES)[number];

export interface AgentExecutionReceipt {
  execution_kind: 'agent_delegation';
  task_id: string;
  agent_id: string;
  runtime_id?: string;
  provider?: string;
  model_id?: string;
  /** Provider-native execution proof, when the task used a native subagent surface. */
  native_subagent?: Record<string, unknown>;
  status: AgentExecutionReceiptStatus;
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
    // Audit trail of a delegation that has no WorkItem claim: the decision
    // (allowed / denied) and, once it ran, the outcome (completed / failed).
    const recordUnclaimed = (
      result: 'allowed' | 'denied' | 'completed' | 'failed',
      reason: string,
      errorCode?: string
    ) =>
      auditChain.record({
        agentId,
        action: 'agent_delegation_unclaimed',
        operation: 'delegate',
        result,
        reason,
        correlationId: request.idempotency_key,
        metadata: {
          task_id: request.task_id,
          mission_id: request.mission_id,
          provider: request.provider || 'claude',
          ...(errorCode ? { error_code: errorCode } : {}),
        },
      });
    let unclaimedAllowed = false;
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
      } else {
        // Unclaimed: nothing in the envelope can stand in for a claim, so no
        // work item, lease, capability profile or caller-asserted role label
        // reaches the runtime record. The mission the caller names must be
        // the mission its scope names (a valid security scope always names
        // one).
        if (request.mission_id !== request.security_scope.mission_id) {
          recordUnclaimed(
            'denied',
            `Task ${request.task_id} names a mission its security scope does not`,
            'AGENT_TASK_MISSION_MISMATCH'
          );
          throw new Error(
            `[AGENT_TASK_MISSION_MISMATCH] Unclaimed delegation names mission ${request.mission_id ?? 'none'} but its security scope names ${request.security_scope.mission_id}`
          );
        }
        recordUnclaimed('allowed', `Task ${request.task_id} delegated without a WorkItem claim`);
        unclaimedAllowed = true;
        appendSupervisorEvent({
          decision: 'agent_delegation_unclaimed',
          agent_id: agentId,
          task_id: request.task_id,
          mission_id: request.mission_id,
          requested_by: 'agent_execution_port',
          provider: request.provider || 'claude',
          idempotency_key: request.idempotency_key,
        });
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
          // Role labels are the caller's claims; only a claimed task keeps them.
          ...(taskBinding
            ? {
                agent_profile_id: request.agent_profile_id,
                team_role_id: request.team_role_id,
                authority_role_id: request.authority_role_id,
              }
            : {}),
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
      if (unclaimedAllowed)
        recordUnclaimed('completed', `Unclaimed delegation of task ${request.task_id} completed`);
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
      if (unclaimedAllowed) {
        // Only a leading `[CODE]` is recorded: provider error text stays out.
        const message = error instanceof Error ? error.message : String(error);
        recordUnclaimed(
          'failed',
          `Unclaimed delegation of task ${request.task_id} failed`,
          message.match(/^\[([A-Z][A-Z0-9_]*)\]/u)?.[1]
        );
      }
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
const agentExecutionPortLifecycle = createSeamLifecycle(agentExecutionPortSeam);

export function registerAgentExecutionPort(port: AgentExecutionPort): () => void {
  return agentExecutionPortLifecycle.register('default', port, {
    provenance: 'builtin',
    source: 'agent-execution-port',
  });
}

export function resetAgentExecutionPort(): void {
  agentExecutionPortLifecycle.reset();
}

export function getAgentExecutionPort(): AgentExecutionPort {
  return agentExecutionPortSeam.getOptional() ?? new SupervisorAgentExecutionPort();
}
