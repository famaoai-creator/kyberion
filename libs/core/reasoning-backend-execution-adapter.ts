import type {
  AgentExecutionPort,
  AgentExecutionReceipt,
  AgentTaskEnvelope,
} from './agent-execution-port.js';
import type { ReasoningBackend } from './reasoning-backend.js';
import { nowIso } from './foundation/time.js';
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
    const startedAt = nowIso();
    const nativeAdopter = this.backend.getNativeSubagentAdopter?.() || undefined;
    const initialNativeInfo = nativeAdopter?.getInfo?.() || undefined;
    const initialModelId =
      request.model_id ||
      (initialNativeInfo?.model as string | undefined) ||
      (this.backend as ReasoningBackend & { model?: string }).model;
    try {
      const output = nativeAdopter
        ? await nativeAdopter.dispatch(request.instruction, request.context_refs?.join('\n'), {
            signal: this.signal,
            model: request.model_id,
          })
        : await this.backend.delegateTask(request.instruction, request.context_refs?.join('\n'), {
            signal: this.signal,
            model: request.model_id,
          });
      const nativeInfo = nativeAdopter?.getInfo?.() || initialNativeInfo;
      const modelId =
        request.model_id || (nativeInfo?.model as string | undefined) || initialModelId;
      return {
        execution_kind: 'agent_delegation',
        task_id: request.task_id,
        agent_id: request.agent_id || `task-agent-${request.task_id}`,
        provider: (nativeInfo?.provider as string | undefined) || this.backend.name,
        model_id: modelId,
        ...(nativeAdopter
          ? { native_subagent: { adopter_id: nativeAdopter.id, ...nativeInfo } }
          : {}),
        status: 'succeeded',
        started_at: startedAt,
        completed_at: nowIso(),
        output_ref: `${request.task_id}:result`,
        output,
      };
    } catch (error) {
      const nativeInfo = nativeAdopter?.getInfo?.() || initialNativeInfo;
      const modelId =
        request.model_id || (nativeInfo?.model as string | undefined) || initialModelId;
      return {
        execution_kind: 'agent_delegation',
        task_id: request.task_id,
        agent_id: request.agent_id || `task-agent-${request.task_id}`,
        provider: (nativeInfo?.provider as string | undefined) || this.backend.name,
        model_id: modelId,
        ...(nativeAdopter
          ? { native_subagent: { adopter_id: nativeAdopter.id, ...nativeInfo } }
          : {}),
        status: 'failed',
        started_at: startedAt,
        completed_at: nowIso(),
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
