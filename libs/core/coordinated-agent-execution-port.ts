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
import { getAgentExecutionPort } from './agent-execution-port.js';

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
      },
    });

    const attemptId = claimed.item.current_attempt_id;
    let receipt: AgentExecutionReceipt;
    try {
      receipt = await this.delegatePort.delegate(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      closeWorkItem(claimed.item, this.actorPeerId, 'blocked', message, attemptId);
      throw error;
    }

    const terminalStatus =
      receipt.status === 'succeeded' ? request.success_status || 'done' : 'blocked';
    closeWorkItem(
      claimed.item,
      this.actorPeerId,
      terminalStatus,
      receipt.error || receipt.output || `agent execution ${receipt.status}`,
      attemptId,
      receipt
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

function closeWorkItem(
  item: WorkItem,
  actorPeerId: string,
  status: 'done' | 'review' | 'blocked',
  summary: string,
  attemptId?: string,
  receipt?: AgentExecutionReceipt
): void {
  if (item.lease_id) {
    releaseWorkItem({
      itemId: item.item_id,
      leaseId: item.lease_id,
      actorPeerId,
      expectedVersion: item.version,
      nextStatus: status,
      summary,
      metadata: {
        ...(item.metadata || {}),
        ...(attemptId ? { attempt_id: attemptId } : {}),
        ...(receipt?.runtime_id ? { runtime_id: receipt.runtime_id } : {}),
        ...(receipt?.output_ref ? { output_ref: receipt.output_ref } : {}),
        summary,
        execution_status: receipt?.status || status,
      },
    });
    return;
  }
  updateWorkItem({
    itemId: item.item_id,
    expectedVersion: item.version,
    status,
    metadata: {
      ...(item.metadata || {}),
      ...(attemptId ? { attempt_id: attemptId } : {}),
      ...(receipt?.runtime_id ? { runtime_id: receipt.runtime_id } : {}),
      ...(receipt?.output_ref ? { output_ref: receipt.output_ref } : {}),
      summary,
      execution_status: receipt?.status || status,
    },
  });
}
