import { a2aBridge } from './a2a-bridge.js';
import { serializeDelegationChain, type DelegationChain } from './delegation-chain.js';
import {
  recordKnowledgeUsageFeedback,
  type DeliveredKnowledgeRef,
} from './src/knowledge-feedback-loop.js';
import type { ContextSecurityScope } from './context-security-scope.js';
import type { PlannedNextTask, TaskResultBlock } from './mission-orchestration-worker-contracts.js';

export interface MissionVisiblePromptInput {
  missionId: string;
  taskId: string;
  content: string;
  form: string;
  contextPackId?: string;
  knowledgeRefs?: DeliveredKnowledgeRef[];
  securityScope?: ContextSecurityScope;
}

export interface ParsedTaskResultResponse {
  taskResult?: TaskResultBlock;
  parseErrors: string[];
  surfaceParseErrors: string[];
}

export interface TaskResultResponseDeps {
  recordMissionVisiblePrompt: (input: MissionVisiblePromptInput) => void;
  resolveTaskDispatchTimeoutMs: (task: PlannedNextTask) => number;
  parseTaskResultResponse: (responseText: string) => ParsedTaskResultResponse;
  buildNeedsKnowledgeReinforcementLines: (input: {
    missionId: string;
    taskId: string;
    teamRole?: string;
    needs: string[];
    deliveredKnowledgeRefs: DeliveredKnowledgeRef[];
    securityScope?: ContextSecurityScope;
  }) => Promise<string[]>;
  buildTaskResultRetryPrompt: (input: {
    missionId: string;
    taskId: string;
    previousResponse: string;
    parseErrors: string[];
    knowledgeDeltaLines?: string[];
  }) => string;
  stampTaskResultProvenance: (taskResult: TaskResultBlock | undefined) => void;
}

export async function obtainTaskResultResponse(
  deps: TaskResultResponseDeps,
  input: {
    missionId: string;
    task: PlannedNextTask;
    teamRole: string;
    agentId: string;
    taskModelHint?: { model_id?: string; tier?: string; effort?: string; route_reason?: string };
    provider?: string;
    providerModelId?: string;
    prompt: string;
    contextPackId?: string;
    securityScope?: import('./context-security-scope.js').ContextSecurityScope;
    /**
     * KP-04: what the first-round context pack already delivered (from
     * `buildTaskDispatchContext`), so a needs-driven retry retrieval can
     * exclude paths the worker already has instead of re-listing them.
     */
    deliveredKnowledgeRefs?: DeliveredKnowledgeRef[];
    /**
     * NI-03: the delegation chain originated at the dispatch point. Embedded
     * (a) structured in the task contract payload (`context.delegation_chain`)
     * and (b) compact-serialized in the A2A envelope header
     * (`delegation_chain`, HMAC-covered when the envelope is signed). Optional
     * — chain-less dispatches emit byte-identical legacy envelopes.
     */
    delegationChain?: DelegationChain;
  }
): Promise<{
  executionMode: 'agent';
  responseText: string;
  taskResult?: TaskResultBlock;
  parseErrors: string[];
  surfaceParseErrors: string[];
  retried: boolean;
  notes: string[];
}> {
  const notes: string[] = [];
  deps.recordMissionVisiblePrompt({
    missionId: input.missionId,
    taskId: input.task.task_id,
    content: input.prompt,
    form: 'task_dispatch',
    ...(input.contextPackId ? { contextPackId: input.contextPackId } : {}),
    knowledgeRefs: input.deliveredKnowledgeRefs,
    securityScope: input.securityScope,
  });
  let response = await a2aBridge.route({
    a2a_version: '1.0',
    header: {
      msg_id: `REQ-${Date.now().toString(36).toUpperCase()}-${input.task.task_id}`,
      sender: 'kyberion:mission-orchestrator',
      receiver: input.agentId,
      performative: 'request',
      timestamp: new Date().toISOString(),
      ...(input.delegationChain
        ? { delegation_chain: serializeDelegationChain(input.delegationChain) }
        : {}),
    },
    payload: {
      intent: 'mission_task_execution',
      text: input.prompt,
      objective: input.task.description || input.task.task_id,
      acceptance_criteria: Array.isArray((input.task as any).acceptance_criteria)
        ? (input.task as any).acceptance_criteria.filter(
            (criterion: unknown) => typeof criterion === 'string' && criterion.trim()
          )
        : undefined,
      expected_outputs: [input.task.deliverable || '', input.task.target_path || '']
        .map((entry) => String(entry || '').trim())
        .filter(Boolean),
      rationale: input.task.deliverable
        ? `Deliver ${input.task.deliverable} for ${input.task.task_id}`
        : `Complete task ${input.task.task_id}`,
      prior_decisions:
        Array.isArray((input.task as any).dependencies) &&
        (input.task as any).dependencies.length > 0
          ? [`Dependencies: ${(input.task as any).dependencies.join(', ')}`]
          : undefined,
      context: {
        mission_id: input.missionId,
        team_role: input.teamRole,
        task_id: input.task.task_id,
        execution_mode: 'task',
        task_model_hint: input.taskModelHint,
        dispatch_timeout_ms: deps.resolveTaskDispatchTimeoutMs(input.task),
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.providerModelId ? { provider_model_id: input.providerModelId } : {}),
        security_scope: input.securityScope,
        ...(input.delegationChain ? { delegation_chain: input.delegationChain } : {}),
      },
    },
  });
  let parsed = deps.parseTaskResultResponse(String(response.payload?.text || ''));
  let taskResult = parsed.taskResult;
  let parseErrors = parsed.parseErrors;
  let surfaceParseErrors = parsed.surfaceParseErrors;
  const needsRetry = !taskResult || parseErrors.length > 0 || (taskResult.needs || []).length > 0;

  if (needsRetry) {
    if (taskResult?.needs?.length)
      notes.push(`task_result.needs requested: ${taskResult.needs.join('; ')}`);
    if (parseErrors.length > 0) notes.push(`task_result parse errors: ${parseErrors.join('; ')}`);
    if (surfaceParseErrors.length > 0)
      notes.push(`surface parse errors: ${surfaceParseErrors.join('; ')}`);
    // KP-04: targeted second-round retrieval when the worker reported
    // unresolved needs — a delta on top of the first-round context pack,
    // not a re-send of it. No-op (empty lines) for parse-error-only retries
    // (no needs to query against) or when nothing new is found.
    const knowledgeDeltaLines = await deps.buildNeedsKnowledgeReinforcementLines({
      missionId: input.missionId,
      taskId: input.task.task_id,
      teamRole: input.teamRole,
      needs: taskResult?.needs || [],
      deliveredKnowledgeRefs: input.deliveredKnowledgeRefs || [],
      securityScope: input.securityScope,
    });
    const retryPrompt = deps.buildTaskResultRetryPrompt({
      missionId: input.missionId,
      taskId: input.task.task_id,
      previousResponse: String(response.payload?.text || ''),
      parseErrors: [
        ...(taskResult?.needs?.length ? [`needs unresolved: ${taskResult.needs.join('; ')}`] : []),
        ...parseErrors,
      ],
      knowledgeDeltaLines,
    });
    deps.recordMissionVisiblePrompt({
      missionId: input.missionId,
      taskId: `${input.task.task_id}-retry`,
      content: retryPrompt,
      form: 'task_result_retry',
      ...(input.contextPackId ? { contextPackId: input.contextPackId } : {}),
      knowledgeRefs: input.deliveredKnowledgeRefs,
      securityScope: input.securityScope,
    });
    response = await a2aBridge.route({
      a2a_version: '1.0',
      header: {
        msg_id: `REQ-${Date.now().toString(36).toUpperCase()}-${input.task.task_id}-retry`,
        sender: 'kyberion:mission-orchestrator',
        receiver: input.agentId,
        performative: 'request',
        timestamp: new Date().toISOString(),
        ...(input.delegationChain
          ? { delegation_chain: serializeDelegationChain(input.delegationChain) }
          : {}),
      },
      payload: {
        intent: 'mission_task_execution',
        text: retryPrompt,
        objective: input.task.description || input.task.task_id,
        acceptance_criteria: Array.isArray((input.task as any).acceptance_criteria)
          ? (input.task as any).acceptance_criteria.filter(
              (criterion: unknown) => typeof criterion === 'string' && criterion.trim()
            )
          : undefined,
        expected_outputs: [input.task.deliverable || '', input.task.target_path || '']
          .map((entry) => String(entry || '').trim())
          .filter(Boolean),
        rationale: input.task.deliverable
          ? `Deliver ${input.task.deliverable} for ${input.task.task_id}`
          : `Complete task ${input.task.task_id}`,
        prior_decisions:
          Array.isArray((input.task as any).dependencies) &&
          (input.task as any).dependencies.length > 0
            ? [`Dependencies: ${(input.task as any).dependencies.join(', ')}`]
            : undefined,
        context: {
          mission_id: input.missionId,
          team_role: input.teamRole,
          task_id: input.task.task_id,
          execution_mode: 'task',
          task_model_hint: input.taskModelHint,
          dispatch_timeout_ms: deps.resolveTaskDispatchTimeoutMs(input.task),
          ...(input.provider ? { provider: input.provider } : {}),
          ...(input.providerModelId ? { provider_model_id: input.providerModelId } : {}),
          security_scope: input.securityScope,
          ...(input.delegationChain ? { delegation_chain: input.delegationChain } : {}),
        },
      },
    });
    parsed = deps.parseTaskResultResponse(String(response.payload?.text || ''));
    taskResult = parsed.taskResult;
    parseErrors = parsed.parseErrors;
    surfaceParseErrors = parsed.surfaceParseErrors;
    if (!taskResult) notes.push('task_result missing after retry');
    if (parseErrors.length > 0)
      notes.push(`task_result parse errors after retry: ${parseErrors.join('; ')}`);
    if (surfaceParseErrors.length > 0)
      notes.push(`surface parse errors after retry: ${surfaceParseErrors.join('; ')}`);
  }

  // KP-05: fold any knowledge_feedback the worker reported into the
  // delivered/used aggregate and enqueue missing_topics as knowledge-gap
  // promotion candidates. Fails open (recordKnowledgeUsageFeedback swallows
  // its own errors) — telemetry must never block task dispatch.
  if (taskResult?.knowledge_feedback) {
    recordKnowledgeUsageFeedback({
      missionId: input.missionId,
      taskId: input.task.task_id,
      feedback: taskResult.knowledge_feedback,
      ...(input.securityScope?.tenant_slug
        ? {
            scope: {
              tier: input.securityScope.write_tier,
              tenant_slug: input.securityScope.tenant_slug,
              mission_id: input.securityScope.mission_id,
              task_id: input.task.task_id,
            },
          }
        : {}),
    });
  }

  // XP-05 closeout: this is the worker's persist point — see
  // stampTaskResultProvenance's doc comment for the local-served-only
  // boundary and why downstream propagation needs no further wiring.
  deps.stampTaskResultProvenance(taskResult);

  return {
    executionMode: 'agent',
    responseText: String(response.payload?.text || ''),
    taskResult,
    parseErrors,
    surfaceParseErrors,
    retried: needsRetry,
    notes,
  };
}
