import {
  claimWorkItem,
  getWorkItem,
  releaseWorkItem,
  updateWorkItem,
  type WorkItem,
  type WorkItemStatus,
} from './workforce/work-coordination.js';
import type {
  AgentExecutionPort,
  AgentExecutionReceipt,
  AgentTaskEnvelope,
} from './agent/agent-execution-port.js';
import type { ContextSecurityScope } from './context-security-scope.js';
import { resolveTenantAlias } from './context-security-scope.js';
import { getAgentExecutionPort } from './agent/agent-execution-port.js';
import { logger } from './core.js';
import {
  clampPolicyToRuntimeTier,
  currentScopeEnvelope,
  mintScopeEnvelope,
  narrowScopeEnvelope,
  runtimeScopeIdentity,
  withScopeEnvelope,
  type ScopeEnvelope,
  type ScopeNarrowRequest,
} from './scope-envelope.js';

export interface CoordinatedAgentTaskEnvelope extends AgentTaskEnvelope {
  work_item_id: string;
  success_status?: Extract<WorkItemStatus, 'done' | 'review'>;
}

export interface CoordinatedAgentExecutionReceipt extends AgentExecutionReceipt {
  work_item_id: string;
  attempt_id?: string;
}

/**
 * SC-01: the delegation dispatch boundary mints/narrows a scope envelope for
 * the child execution. With an active envelope the request's security_scope
 * is a narrow request; without one, the boundary mints from the runtime
 * scope plus the stamped dispatch contract. Delegations that cannot mint yet
 * run unenveloped (measured by the op-preflight scope stage).
 */
function delegationScopeEnvelope(request: CoordinatedAgentTaskEnvelope): ScopeEnvelope | null {
  const scope: ContextSecurityScope | undefined = request.security_scope;
  const narrowRequest: ScopeNarrowRequest = scope
    ? {
        identity: {
          tenant_slug: resolveTenantAlias(scope),
          organization_id: scope.organization_id,
          project_id: scope.project_id,
          mission_id: request.mission_id ?? scope.mission_id,
          task_id: request.task_id ?? scope.task_id,
          session_id: scope.session_id,
        },
        policy: {
          read_tiers: [...scope.read_tiers],
          write_tier: scope.write_tier,
          purpose: scope.purpose,
          external_egress: scope.external_egress,
          allowed_reasoning_backends: scope.allowed_reasoning_backends,
        },
      }
    : {};
  const active = currentScopeEnvelope();
  if (active) return narrowScopeEnvelope(active, narrowRequest);
  if (!scope) return null;
  // No active envelope: the request's security_scope is caller input, so it
  // can only ever shrink what the process itself is bound to. It may name
  // the mission/task/session the process is running, never a different
  // mission, and its policy is clamped to the process tier (no egress from
  // a request).
  const runtime = runtimeScopeIdentity();
  const declared = narrowRequest.identity ?? {};
  if (!runtime.mission_id || declared.mission_id !== runtime.mission_id) {
    logger.warn(
      `[coordinated-agent-execution-port] delegation scope is not bound to the process mission for work_item_id=${request.work_item_id} — delegation runs unenveloped | dispatch from the mission process (MISSION_ID) so the boundary can mint | requested mission=${declared.mission_id ?? 'none'} process mission=${runtime.mission_id ?? 'none'}`
    );
    return null;
  }
  const clamped = clampPolicyToRuntimeTier(
    {
      purpose: narrowRequest.policy?.purpose?.trim() || `delegate ${request.work_item_id}`,
      read_tiers: narrowRequest.policy?.read_tiers,
      write_tier: narrowRequest.policy?.write_tier,
      allowed_reasoning_backends: narrowRequest.policy?.allowed_reasoning_backends,
    },
    runtime.tier ?? 'public'
  );
  if (!clamped) {
    logger.warn(
      `[coordinated-agent-execution-port] delegation policy is above the process tier for work_item_id=${request.work_item_id} — delegation runs unenveloped | request a tier the mission process holds | process tier=${runtime.tier ?? 'public'}`
    );
    return null;
  }
  try {
    return mintScopeEnvelope({
      // Tenant/org/project come from the process scope and the mission
      // record inside mint — never from the request.
      identity: {
        mission_id: declared.mission_id,
        task_id: declared.task_id,
        session_id: declared.session_id,
      },
      policy: clamped,
    });
  } catch (error) {
    logger.warn(
      `[coordinated-agent-execution-port] scope envelope mint failed for work_item_id=${request.work_item_id} — delegation runs unenveloped | wire the dispatch boundary to mint first | ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Bridges agent-runtime/CLI delegation to Work Coordination.
 *
 * The wrapped execution port owns runtime mechanics; this adapter owns the
 * durable work-item claim and terminal status so every execution surface has
 * the same handoff/recovery semantics.
 */
export class CoordinatedAgentExecutionPort implements AgentExecutionPort {
  constructor(
    private readonly delegatePort: AgentExecutionPort,
    private readonly actorPeerId = 'coordinated-agent-execution-port'
  ) {}

  async delegate(request: CoordinatedAgentTaskEnvelope): Promise<CoordinatedAgentExecutionReceipt> {
    // Envelope mint/narrow runs before the work-item claim: a scope
    // contradiction rejects the delegation without leaving a claim open.
    const envelope = delegationScopeEnvelope(request);
    const item = getWorkItem(request.work_item_id);
    if (!item) {
      throw new Error(`[WORK_ITEM_NOT_FOUND] ${request.work_item_id}`);
    }

    const claimed = claimWorkItem({
      itemId: item.item_id,
      actorPeerId: this.actorPeerId,
      purpose: `execute ${item.item_id} via agent execution port`,
      expectedVersion: item.version,
      idempotencyKey: request.idempotency_key,
      metadata: {
        mission_id: request.mission_id,
        execution_kind: 'agent_delegation',
        work_item_id: request.work_item_id,
        security_scope: request.security_scope,
      },
    });

    const attemptId = claimed.item.current_attempt_id;
    let receipt: AgentExecutionReceipt;
    try {
      receipt = envelope
        ? await withScopeEnvelope(envelope, () => this.delegatePort.delegate(request))
        : await this.delegatePort.delegate(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        `[coordinated-agent-execution-port] delegation threw for work_item_id=${request.work_item_id} task_id=${request.task_id}: ${message}`
      );
      closeWorkItem(
        claimed.item,
        this.actorPeerId,
        'blocked',
        message,
        attemptId,
        {
          execution_kind: 'agent_delegation',
          task_id: request.task_id,
          agent_id: request.agent_id || 'unknown',
          status: 'failed',
          error: message,
        },
        request.security_scope
      );
      throw error;
    }

    if (receipt.status !== 'succeeded') {
      logger.error(
        `[coordinated-agent-execution-port] delegation failed for work_item_id=${request.work_item_id} task_id=${request.task_id} status=${receipt.status}: ${receipt.error || receipt.output || '(no error detail returned)'}`
      );
    }

    const terminalStatus =
      receipt.status === 'succeeded' ? request.success_status || 'done' : 'blocked';
    closeWorkItem(
      claimed.item,
      this.actorPeerId,
      terminalStatus,
      receipt.error || receipt.output || `agent execution ${receipt.status}`,
      attemptId,
      receipt,
      request.security_scope
    );
    return {
      ...receipt,
      work_item_id: item.item_id,
      ...(attemptId ? { attempt_id: attemptId } : {}),
    };
  }
}

export function getCoordinatedAgentExecutionPort(
  delegatePort: AgentExecutionPort = getAgentExecutionPort(),
  actorPeerId = 'coordinated-agent-execution-port'
): AgentExecutionPort {
  return new CoordinatedAgentExecutionPort(delegatePort, actorPeerId);
}

export async function delegateCoordinatedAgentTask(
  request: CoordinatedAgentTaskEnvelope,
  delegatePort?: AgentExecutionPort,
  actorPeerId?: string
): Promise<CoordinatedAgentExecutionReceipt> {
  return (await getCoordinatedAgentExecutionPort(delegatePort, actorPeerId).delegate(
    request
  )) as CoordinatedAgentExecutionReceipt;
}

/**
 * Explicit CLI-subagent entry point for the same claim/attempt/lease contract.
 * Keeping this boundary named prevents text-only delegation from accidentally
 * bypassing Work Coordination when the execution surface changes.
 */
export async function delegateCoordinatedCliSubagentTask(
  request: CoordinatedAgentTaskEnvelope,
  execute: () => Promise<AgentExecutionReceipt>,
  actorPeerId?: string
): Promise<CoordinatedAgentExecutionReceipt> {
  return delegateCoordinatedAgentTask(request, { delegate: async () => execute() }, actorPeerId);
}

function closeWorkItem(
  item: WorkItem,
  actorPeerId: string,
  status: 'done' | 'review' | 'blocked',
  summary: string,
  attemptId?: string,
  receipt?: AgentExecutionReceipt,
  securityScope?: ContextSecurityScope
): void {
  // A worker may legitimately update WorkItem metadata while its lease is
  // active (for example, runtime/observability evidence arriving during the
  // provider call). Re-read before closing so that an unrelated version bump
  // does not strand the attempt in `running`. The lease identity remains the
  // authority check; a transferred or released lease still fails closed in
  // releaseWorkItem.
  const current = getWorkItem(item.item_id);
  if (!current) {
    throw new Error(`[WORK_ITEM_NOT_FOUND] ${item.item_id}`);
  }
  const closeVersion = current.lease_id === item.lease_id ? current.version : item.version;
  const executionStatus = receipt?.status || status;
  const resultMetadata = {
    status: executionStatus,
    ...(receipt?.output_ref ? { output_ref: receipt.output_ref } : {}),
    ...(receipt?.error ? { error: receipt.error } : {}),
  };
  if (item.lease_id) {
    releaseWorkItem({
      itemId: item.item_id,
      leaseId: item.lease_id,
      actorPeerId,
      expectedVersion: closeVersion,
      nextStatus: status,
      summary,
      metadata: {
        ...(item.metadata || {}),
        work_item_id: item.item_id,
        ...(attemptId ? { attempt_id: attemptId } : {}),
        ...(receipt?.runtime_id ? { runtime_id: receipt.runtime_id } : {}),
        ...(receipt?.output_ref ? { output_ref: receipt.output_ref } : {}),
        ...(receipt?.model_id ? { model_id: receipt.model_id } : {}),
        ...(receipt?.native_subagent ? { native_subagent: receipt.native_subagent } : {}),
        ...(receipt?.provider ? { provider: receipt.provider } : {}),
        ...(securityScope ? { security_scope: securityScope } : {}),
        summary,
        lease_status: 'released',
        execution_status: executionStatus,
        result: resultMetadata,
      },
    });
    return;
  }
  updateWorkItem({
    itemId: item.item_id,
    expectedVersion: closeVersion,
    status,
    metadata: {
      ...(item.metadata || {}),
      work_item_id: item.item_id,
      ...(attemptId ? { attempt_id: attemptId } : {}),
      ...(receipt?.runtime_id ? { runtime_id: receipt.runtime_id } : {}),
      ...(receipt?.output_ref ? { output_ref: receipt.output_ref } : {}),
      ...(receipt?.model_id ? { model_id: receipt.model_id } : {}),
      ...(receipt?.native_subagent ? { native_subagent: receipt.native_subagent } : {}),
      ...(receipt?.provider ? { provider: receipt.provider } : {}),
      ...(securityScope ? { security_scope: securityScope } : {}),
      summary,
      lease_status: 'released',
      execution_status: executionStatus,
      result: resultMetadata,
    },
  });
}
