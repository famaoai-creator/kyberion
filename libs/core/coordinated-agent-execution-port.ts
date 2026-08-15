import {
  claimWorkItem,
  getWorkItem,
  releaseWorkItem,
  updateWorkItem,
  type WorkItem,
  type WorkItemStatus,
} from './work-coordination.js';
import type {
  AgentExecutionPort,
  AgentExecutionReceipt,
  AgentTaskEnvelope,
} from './agent-execution-port.js';
import type { ContextSecurityScope } from './context-security-scope.js';
import { getAgentExecutionPort } from './agent-execution-port.js';
import { logger } from './core.js';

export interface CoordinatedAgentTaskEnvelope extends AgentTaskEnvelope {
  work_item_id: string;
  success_status?: Extract<WorkItemStatus, 'done' | 'review'>;
}

export interface CoordinatedAgentExecutionReceipt extends AgentExecutionReceipt {
  work_item_id: string;
  attempt_id?: string;
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
      receipt = await this.delegatePort.delegate(request);
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
