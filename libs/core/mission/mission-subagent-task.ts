import { createLogger } from '../logger.js';
import { isRecord } from '../foundation/text.js';
import { getRegisteredEnvText, setRegisteredEnv } from '../foundation/env.js';
import { nowIso } from '../foundation/time.js';
import type { AgentExecutionReceipt } from '../agent/agent-execution-port.js';
import type { AgentContextMode } from '../context-boundary.js';
import type { ReasoningBackend } from '../reasoning/reasoning-backend.js';
import {
  buildTaskReasoningBackend,
  type TaskReasoningBackendOptions,
} from '../workforce/task-execution-port.js';
import type { WorkItem } from '../workforce/work-coordination.js';
import type { ContextSecurityScope } from '../context-security-scope.js';
import {
  delegateCoordinatedCliSubagentTask,
  type CoordinatedAgentExecutionReceipt,
} from '../coordinated-agent-execution-port.js';
import { HarnessSubagentDispatcher } from '../agent/agent-dispatch.js';
import {
  assertProviderCanProjectProfile,
  resolveCliProviderDescriptorOrNull,
} from '../provider/provider-permission-profiles.js';
import { isAgentRuntimeApprovalPendingError } from '../agent/agent-prompt-approval-port.js';
import type {
  WorkItemDispatchAdapters,
  WorkItemExecutionOutcome,
} from './mission-workitem-dispatch-review.js';

const logger = createLogger('mission-subagent-task');

export function getWorkItemTaskId(item: WorkItem): string | undefined {
  const metadata = (item.metadata || {}) as Record<string, unknown>;
  const taskId = metadata.task_id;
  if (typeof taskId === 'string' && taskId.trim()) return taskId.trim();
  const sourceRef = String(item.source_ref || '').trim();
  const match = sourceRef.match(/^mission:[^:]+:(.+)$/u);
  return match?.[1] || undefined;
}

export function workItemExpectsFiles(item: WorkItem): boolean {
  const metadata = (item.metadata || {}) as Record<string, unknown>;
  return Boolean(
    metadata.deliverable ||
    metadata.target_path ||
    String(metadata.expected_output_format || '') === 'files'
  );
}

export async function delegateSubagentTask(input: {
  item: WorkItem;
  assigneePeerId?: string;
  prompt: string;
  routingOptions: Record<string, unknown>;
  adapters: WorkItemDispatchAdapters;
  notes: string[];
  signal: AbortSignal;
  securityScope: ContextSecurityScope;
  contextMode: AgentContextMode;
  purpose?: 'implementation' | 'review';
  /**
   * KD-05 tier the delegation must run under — resolved by the caller from
   * the team role × purpose ceiling (resolveDelegationCapabilityProfile).
   * Falls back to the purpose-only floor for legacy callers.
   */
  capabilityProfile?: string;
}): Promise<WorkItemExecutionOutcome> {
  const delegationContext = input.purpose === 'review' ? 'workitem-review' : 'workitem';
  const capabilityProfile =
    input.capabilityProfile ?? (input.purpose === 'review' ? 'explorer' : 'implementer');
  const delegationIdentity = input.assigneePeerId || input.item.assignee_peer_id;
  const delegationContextRef = delegationIdentity
    ? `${delegationContext}:${input.item.item_id}:agent=${delegationIdentity}`
    : `${delegationContext}:${input.item.item_id}`;
  const missionId = String(
    input.item.metadata?.mission_id || input.item.project_id || input.item.item_id
  ).trim();
  const executeText = async (): Promise<AgentExecutionReceipt> => {
    const startedAt = nowIso();
    let provider = input.adapters.nativeSubagentTask
      ? 'injected-native-subagent'
      : 'injected-task-adapter';
    let backend: ReasoningBackend | undefined;
    try {
      // The coordinated port has now claimed the WorkItem and bound its task
      // credentials. Never capture the host singleton before this boundary.
      if (!input.adapters.nativeSubagentTask && !input.adapters.delegateTask) {
        backend = buildTaskReasoningBackend({
          ...(typeof input.routingOptions.mode === 'string'
            ? { mode: input.routingOptions.mode as TaskReasoningBackendOptions['mode'] }
            : {}),
          ...(typeof input.routingOptions.model === 'string'
            ? { model: input.routingOptions.model }
            : {}),
          ...(isRecord(input.routingOptions.samplingParams)
            ? {
                samplingParams: input.routingOptions
                  .samplingParams as TaskReasoningBackendOptions['samplingParams'],
              }
            : {}),
          role:
            typeof input.routingOptions.role === 'string'
              ? input.routingOptions.role
              : input.purpose === 'review'
                ? 'reviewer'
                : 'implementer',
          ...(typeof input.routingOptions.route_profile === 'string'
            ? { profile: input.routingOptions.route_profile }
            : typeof input.routingOptions.profile === 'string'
              ? { profile: input.routingOptions.profile }
              : {}),
        });
        provider = backend.name;
        if (resolveCliProviderDescriptorOrNull(backend.name)) {
          assertProviderCanProjectProfile(backend.name, capabilityProfile);
        }
      }
      const nativeDispatcher = new HarnessSubagentDispatcher();
      const nativeAdopter = backend?.getNativeSubagentAdopter?.() ?? null;
      let nativeSubagent: Record<string, unknown> | undefined;
      const run = async () => {
        if (input.adapters.nativeSubagentTask) {
          const result = await input.adapters.nativeSubagentTask(
            input.prompt,
            delegationContextRef,
            {
              ...input.routingOptions,
              context_mode: input.contextMode,
              signal: input.signal,
            }
          );
          nativeSubagent = result.nativeSubagent;
          return result.text;
        }
        if (input.adapters.delegateTask) {
          return input.adapters.delegateTask(input.prompt, delegationContextRef, {
            context_mode: input.contextMode,
            signal: input.signal,
          });
        }
        return nativeDispatcher.dispatch(input.prompt, delegationContextRef, backend!, {
          ...input.routingOptions,
          context_mode: input.contextMode,
          profile: capabilityProfile,
          role: input.purpose === 'review' ? 'reviewer' : 'implementer',
          signal: input.signal,
        });
      };
      let output = await run();
      if (!output || !output.trim()) {
        input.notes.push('empty subagent response; retrying once');
        output = await run();
      }
      return {
        execution_kind: 'agent_delegation',
        task_id: getWorkItemTaskId(input.item) || input.item.item_id,
        agent_id: delegationIdentity || `task-agent-${input.item.item_id}`,
        provider,
        ...(input.routingOptions.model ? { model_id: String(input.routingOptions.model) } : {}),
        ...(nativeAdopter?.getInfo?.()
          ? { native_subagent: nativeAdopter.getInfo() || undefined }
          : nativeSubagent
            ? { native_subagent: nativeSubagent }
            : {}),
        status: 'succeeded',
        started_at: startedAt,
        completed_at: nowIso(),
        output_ref: `${input.item.item_id}:result`,
        output,
      };
    } catch (error) {
      if (isAgentRuntimeApprovalPendingError(error)) throw error;
      return {
        execution_kind: 'agent_delegation',
        task_id: getWorkItemTaskId(input.item) || input.item.item_id,
        agent_id: delegationIdentity || `task-agent-${input.item.item_id}`,
        provider,
        ...(input.routingOptions.model ? { model_id: String(input.routingOptions.model) } : {}),
        status: 'failed',
        started_at: startedAt,
        completed_at: nowIso(),
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      // The private chain belongs to this claimed task, so teardown must run
      // before the coordinated port leaves its trusted credential binding.
      try {
        await backend?.resetSession?.();
      } catch (error) {
        logger.warn(
          `task backend session cleanup failed — ${error instanceof Error ? error.message : String(error)} | next: inspect task provider session cleanup | evidence: work_item=${input.item.item_id}`
        );
      }
    }
  };

  const wantsFiles = workItemExpectsFiles(input.item);
  const previousTools = getRegisteredEnvText('KYBERION_CLAUDE_AGENT_TOOLS');
  if (wantsFiles && previousTools === undefined) {
    setRegisteredEnv('KYBERION_CLAUDE_AGENT_TOOLS', '1');
    input.notes.push('agentic tools auto-enabled (work item expects file output)');
  }
  try {
    const receipt: CoordinatedAgentExecutionReceipt = await delegateCoordinatedCliSubagentTask(
      {
        work_item_id: input.item.item_id,
        task_id: getWorkItemTaskId(input.item) || input.item.item_id,
        ...(missionId ? { mission_id: missionId } : {}),
        ...(delegationIdentity ? { agent_id: delegationIdentity } : {}),
        security_scope: input.securityScope,
        context_mode: input.contextMode,
        // Transport success still awaits task_result validation and final reflection.
        success_status: 'review',
        instruction: input.prompt,
        context_refs: [delegationContextRef, JSON.stringify(input.routingOptions)],
        idempotency_key: `${delegationContext}:${input.item.item_id}:${input.item.version}`,
      },
      executeText,
      delegationIdentity || `workitem:${input.item.item_id}`
    );
    if (receipt.status !== 'succeeded') {
      throw new Error(receipt.error || `work item delegation ${receipt.status}`);
    }
    return {
      responseText: receipt.output || '',
      attemptId: receipt.attempt_id,
      runtimeId: receipt.runtime_id,
      outputRef: receipt.output_ref,
      executorAgentId: receipt.agent_id,
      provider: receipt.provider,
      ...(receipt.model_id ? { modelId: receipt.model_id } : {}),
      ...(receipt.native_subagent ? { nativeSubagent: receipt.native_subagent } : {}),
    };
  } finally {
    if (wantsFiles && previousTools === undefined) {
      setRegisteredEnv('KYBERION_CLAUDE_AGENT_TOOLS', previousTools);
    }
  }
}
