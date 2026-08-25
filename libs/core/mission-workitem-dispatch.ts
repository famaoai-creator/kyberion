/**
 * scripts/refactor/mission-workitem-dispatch.ts
 * Mission work item execution dispatch for registered tickets.
 */

import * as nodePath from 'node:path';
import { a2aBridge, type A2AMessage } from './a2a-bridge.js';
import type { AgentExecutionPort, AgentExecutionReceipt } from './agent-execution-port.js';
import type { AgentContextMode } from './context-boundary.js';
import {
  buildArtifactReviewReceipt,
  hashArtifactForReview,
  inferArtifactReviewKind,
  type ArtifactReviewFinding,
  type ArtifactReviewReceipt,
} from './artifact-review.js';
import { executeServicePreset } from './service-engine.js';
import { getReasoningBackend } from './reasoning-backend.js';
import {
  delegateCoordinatedCliSubagentTask,
  delegateCoordinatedAgentTask,
  type CoordinatedAgentExecutionReceipt,
} from './coordinated-agent-execution-port.js';
import { readCanonicalWorkGraph } from './work-graph-projection.js';
import { ledger } from './ledger.js';
import { loadAgentProfileIndex } from './mission-team-index.js';
import { logger } from './core.js';
import * as pathResolver from './path-resolver.js';
import { getRegisteredEnvText, setRegisteredEnv } from './foundation/env.js';
import {
  resolveArtifactReviewerProfile,
  type ArtifactReviewerProfile,
} from './mission-review-gates.js';
import { resolveMissionTeamReceiver } from './mission-team-plan-composer.js';
import { safeExistsSync, safeStat } from './secure-io.js';
import {
  getWorkItem,
  listWorkItems,
  updateWorkItem,
  type WorkItem,
  type WorkItemSource,
  type WorkItemStatus,
} from './work-coordination.js';
import {
  buildCognitiveRouteDecision,
  formatCognitiveRouteDecision,
  type CognitiveRouteDecision,
} from './cognitive-routing.js';
import {
  advanceReasoningDriftWatchdog,
  encodeReasoningDriftWatchdogState,
  hydrateReasoningDriftWatchdogState,
  formatReasoningDriftWatchdogDecision,
} from './reasoning-drift-watchdog.js';
import { extractSurfaceBlocks } from './surface-response-blocks.js';
import {
  renderMissionContextPack,
  resolveMissionContextPack,
  saveMissionContextPack,
} from './mission-context-pack.js';
import { resolveTaskModelHint, type TaskModelHint } from './reasoning-model-routing.js';
import { resolveQuestionInteractionPacket } from './question-resolver.js';
import { type TaskResultBlock } from './channel-surface-types.js';
import { type OperatorInteractionPacket } from './src/types/operator-interaction-packet.js';
import { HarnessSubagentDispatcher } from './agent-dispatch.js';
import { findMissionPath } from './path-resolver.js';
import { closeTaskArtifacts } from './mission-artifact-closure.js';
import { deriveAgentNhiId } from './agent-identity.js';
import { issueTaskGrantBestEffort, revokeGrantsForTaskBestEffort } from './task-scoped-grants.js';
import { buildWorkingPrinciplesLines } from './working-principles.js';
import type { MissionState } from './mission-types.js';
import type { ContextSecurityScope } from './context-security-scope.js';
import { checkProviderEgress } from './provider-egress-gate.js';
import { evaluateEgressPolicy } from './egress-policy.js';
import { reasoningBackendEndpoint } from './reasoning-egress-scope.js';
import {
  countWords as countWordsFromDispatchIO,
  readJsonFile as readJsonFileFromDispatchIO,
  writeJsonFile as writeJsonFileFromDispatchIO,
} from './mission-dispatch-io.js';
import { appendDispatchEvent, writeDispatchArtifact } from './mission-dispatch-lifecycle.js';
import { evaluatePhaseEntryGate } from './mission-process-planning.js';
import { recordTask } from './mission-maintenance.js';
import type { ReasoningCallOptions } from './reasoning-backend.js';
import {
  resolveMissionExecutionSurface,
  type MissionExecutionSurface,
  type MissionExecutionSurfaceDecision,
} from './mission-execution-surface.js';

export type MissionWorkItemDispatchMode = 'auto' | 'agent' | 'subagent';
export type MissionWorkItemDispatchFinalStatus = 'review' | 'done' | 'blocked';

/**
 * Confidential missions default to external_egress=deny. A model-backed
 * WorkItem may opt into one provider only when both provider-tier policy and
 * tenant-specific domain policy approve it; all other providers remain denied.
 */

import {
  resolveRuntimeSecurityScope,
  DEFAULT_WORK_ITEM_RESPONSE_TIMEOUT_MS,
  resolveWorkItemResponseTimeoutMs,
  WorkItemResponseTimeoutError,
  dispatchRoot,
  dispatchEventPath,
  manifestPath,
  ticketRoot,
  ticketManifestPath,
  ticketReplyPath,
  missionNextTasksPath,
  resolveWorkItemExecutionSurface,
  resolveWorkItemArtifactReviewContext,
  isResolvedArtifactReviewContext,
  buildArtifactReviewPromptLines,
  normalizeArtifactReviewFindings,
  persistWorkItemArtifactReviewReceipt,
  readManifest,
  getMissionLabel,
  getTeamRole,
  getTaskDescription,
  getTaskModelHint,
  isFastTierTaskModelHint,
  buildFastTierPromptAddendum,
  isIndependentReviewRequired,
  extractJsonObject,
  parseIndependentReviewerVerdict,
  buildIndependentReviewerPrompt,
  runIndependentReviewerReview,
  workItemExpectsFiles,
  delegateSubagentTask,
  runWithWorkItemResponseDeadline,
  getWorkItemTaskId,
  extractGitHubIssueNumber,
  extractGitHubRepoInfo,
  extractJiraIssueKey,
  extractJiraProjectInfo,
  buildTicketReflectionBody,
  deriveTicketState,
  normalizeAcceptanceText,
  evaluateAcceptanceCriteriaEvidence,
  updateTicketManifest,
  TICKET_STATE_TO_TASK_STATUS,
  TASK_STATUS_RANK,
  updateNextTasksReflection,
  appendComment,
  reflectTicketOutcome,
  validateWorkItemGranularity,
  resolveWorkItemProjectIds,
  readMissionWorkGraph,
  areMissionTaskDependenciesSatisfied,
  selectWorkItems,
  resolveAssigneePeerId,
  buildDispatchResponseArtifact,
  evaluateWorkItemDrift,
  buildWorkItemPromptBody,
  buildTaskResultRetryPrompt,
  buildWorkItemDispatchContext,
  summarizeDispatchObservability,
  parseTaskResultResponse,
  buildTaskResultClarificationPacket,
  buildClarificationArtifactPath,
  routeToAgentOrSubagent,
  obtainTaskResultResponse,
} from './mission-workitem-dispatch-internals.js';
import type {
  WorkItemExecutionOutcome,
  MissionWorkItemDispatchOptions,
  MissionWorkItemDispatchRecord,
  MissionWorkItemDispatchManifest,
  WorkItemDispatchAdapters,
  WorkItemDispatchReviewerVerdict,
  WorkItemReviewPlannedTask,
  WorkItemArtifactReviewContext,
  ResolvedWorkItemArtifactReviewContext,
} from './mission-workitem-dispatch-internals.js';
export type {
  WorkItemExecutionOutcome,
  MissionWorkItemDispatchOptions,
  MissionWorkItemDispatchRecord,
  MissionWorkItemDispatchManifest,
  WorkItemDispatchAdapters,
  WorkItemDispatchReviewerVerdict,
  WorkItemReviewPlannedTask,
  WorkItemArtifactReviewContext,
  ResolvedWorkItemArtifactReviewContext,
} from './mission-workitem-dispatch-internals.js';

export async function dispatchMissionWorkItems(
  state: MissionState,
  options: MissionWorkItemDispatchOptions = {},
  adapters: WorkItemDispatchAdapters = {}
): Promise<MissionWorkItemDispatchManifest> {
  const maxRounds = Math.max(
    1,
    Number(options.rounds ?? getRegisteredEnvText('KYBERION_DISPATCH_MAX_ROUNDS') ?? 1)
  );
  let manifest = await dispatchMissionWorkItemsRound(state, options, adapters, 1);
  let previousRemaining = Number.POSITIVE_INFINITY;
  for (let round = 2; round <= maxRounds; round += 1) {
    const retryStatuses: WorkItemStatus[] = Array.from(
      new Set<WorkItemStatus>([...(options.statuses || ['ready', 'backlog']), 'blocked'])
    );
    const remaining = selectWorkItems(state, { ...options, statuses: retryStatuses });
    if (remaining.length === 0) break;
    if (remaining.length >= previousRemaining) {
      logger.warn(
        `[workitem-dispatch] round ${round}: no progress (${remaining.length} item(s) still actionable) — stopping auto-rounds.`
      );
      break;
    }
    previousRemaining = remaining.length;
    logger.info(
      `[workitem-dispatch] auto-round ${round}/${maxRounds}: retrying ${remaining.length} actionable item(s).`
    );
    manifest = await dispatchMissionWorkItemsRound(
      state,
      { ...options, statuses: retryStatuses },
      adapters,
      round
    );
  }
  return manifest;
}

async function dispatchMissionWorkItemsRound(
  state: MissionState,
  options: MissionWorkItemDispatchOptions = {},
  adapters: WorkItemDispatchAdapters = {},
  round = 1
): Promise<MissionWorkItemDispatchManifest> {
  const missionId = state.mission_id.toUpperCase();
  const missionPath = findMissionPath(missionId) || pathResolver.missionDir(missionId, state.tier);
  if (!missionPath) {
    throw new Error(`Mission path not found for ${missionId}`);
  }

  const workItems = selectWorkItems(state, options);
  const existingManifest = readManifest(missionPath);
  const records: MissionWorkItemDispatchRecord[] = [];
  const finalStatus = options.finalStatus || 'review';
  const mode = options.mode || 'auto';
  const limit =
    typeof options.limit === 'number' && options.limit > 0 ? options.limit : workItems.length;

  // Keep the round boundary explicit in the mission event stream. The
  // retrospective collector uses this event rather than inferring rounds
  // from item outcomes, which would miss empty/deferred rounds and could
  // double-count retries.
  appendDispatchEvent(dispatchEventPath(missionPath), {
    event: 'dispatch_started',
    event_type: 'workitem_dispatch_started',
    mission_id: missionId,
    round,
    mode,
    execution_surface: options.executionSurface,
    review_execution_surface: options.reviewExecutionSurface,
    selected_count: Math.min(workItems.length, limit),
    statuses: options.statuses || ['ready', 'backlog'],
  });

  for (const item of workItems.slice(0, limit)) {
    const teamRole = getTeamRole(item);
    const independentReviewRequired = isIndependentReviewRequired(item);
    const executionSurfaceDecision = resolveWorkItemExecutionSurface(
      item,
      'implementation',
      options.executionSurface
    );
    const reviewExecutionSurfaceDecision = independentReviewRequired
      ? resolveWorkItemExecutionSurface(item, 'review', options.reviewExecutionSurface)
      : undefined;
    const artifactReviewContext = resolveWorkItemArtifactReviewContext({
      missionPath,
      missionId,
      missionState: state,
      item,
      teamRole,
    });
    const assigneePeerId = isResolvedArtifactReviewContext(artifactReviewContext)
      ? artifactReviewContext.reviewerAgentId
      : resolveAssigneePeerId({ missionId, item, teamRole });
    const taskModelHint = getTaskModelHint(item);
    const teamAssignment = teamRole
      ? resolveMissionTeamReceiver({ missionId, teamRole })
      : undefined;
    const validation = validateWorkItemGranularity(item, assigneePeerId);
    const record: MissionWorkItemDispatchRecord = {
      item_id: item.item_id,
      title: getTaskDescription(item),
      team_role: teamRole,
      assignee_peer_id: assigneePeerId,
      execution_mode: mode,
      execution_surface: executionSurfaceDecision.surface,
      ...(reviewExecutionSurfaceDecision
        ? {
            review_execution_surface: reviewExecutionSurfaceDecision.surface,
          }
        : {}),
      status: validation.ok ? 'created' : 'failed',
      work_item_status_before: item.status,
      task_model_hint: taskModelHint,
      notes: [...validation.notes],
    };

    if (artifactReviewContext?.blockingReason) {
      record.status = 'failed';
      record.work_item_status_after = 'blocked';
      record.notes.push(artifactReviewContext.blockingReason);
      updateWorkItem({
        itemId: item.item_id,
        status: 'blocked',
        assigneePeerId: assigneePeerId || item.assignee_peer_id,
        metadata: {
          ...(item.metadata || {}),
          artifact_review_blocked_reason: artifactReviewContext.blockingReason,
        },
      });
      updateNextTasksReflection(
        missionPath,
        artifactReviewContext.reviewTaskId,
        {
          result_status: 'blocked',
          blocked: true,
          review_required: true,
          artifact_review_blocked_reason: artifactReviewContext.blockingReason,
        },
        'blocked'
      );
      records.push(record);
      appendDispatchEvent(dispatchEventPath(missionPath), {
        event_type: 'workitem_dispatch_blocked',
        mission_id: missionId,
        item_id: item.item_id,
        team_role: teamRole,
        reason: artifactReviewContext.blockingReason,
        policy_used: 'artifact_review_independence_v1',
      });
      continue;
    }

    if (!validation.ok) {
      records.push(record);
      appendDispatchEvent(dispatchEventPath(missionPath), {
        event_type: 'workitem_dispatch_failed',
        mission_id: missionId,
        item_id: item.item_id,
        team_role: teamRole,
        assignee_peer_id: assigneePeerId,
        notes: validation.notes,
      });
      continue;
    }

    // MO-01/MO-02: a process-template phase with an unmet entry gate defers
    // its tasks — same UX as unmet dependencies, re-dispatched once the gate
    // passes.
    const itemPhase = (item.metadata as Record<string, unknown> | undefined)?.phase;
    if (typeof itemPhase === 'string' && itemPhase) {
      const entryGate = await evaluatePhaseEntryGate({ missionId, phase: itemPhase });
      if (entryGate && entryGate.verdict === 'fail') {
        record.status = 'deferred';
        record.notes.push(
          `entry gate ${entryGate.gateId} not passed: ${entryGate.reasons.join('; ') || 'checks failed'}`
        );
        records.push(record);
        appendDispatchEvent(dispatchEventPath(missionPath), {
          event_type: 'workitem_dispatch_deferred',
          mission_id: missionId,
          item_id: item.item_id,
          team_role: teamRole,
          phase: itemPhase,
          gate_id: entryGate.gateId,
          notes: entryGate.reasons,
        });
        continue;
      }
    }

    const dispatchContext = await buildWorkItemDispatchContext({
      missionPath,
      missionId,
      missionState: state,
      item,
      teamRole,
      assigneePeerId,
      taskModelHint,
    });
    const dispatchPrompt = isResolvedArtifactReviewContext(artifactReviewContext)
      ? [dispatchContext.prompt, ...buildArtifactReviewPromptLines(artifactReviewContext)].join(
          '\n'
        )
      : dispatchContext.prompt;

    // NI-04: short-lived, audience-bound task grant for the dispatched
    // worker (RFC 8707 analogue — see task-scoped-grants.ts). Grantee = the
    // assignee's agent-registry runtime identity mapped to its NI-01 nhi_id
    // (the same slug the NI-03 delegation chain's worker link carries);
    // audience = this mission/task. Work item contracts declare no
    // capability needs today, so the scope is empty: the grant proves task
    // membership without conferring extra authorities. Best-effort — a grant
    // failure never blocks the dispatch itself. Revoked at
    // reflectTicketOutcome (done/blocked); lazy expiry covers the rest.
    const grantTaskId = getWorkItemTaskId(item);
    const granteeNhiId = assigneePeerId ? deriveAgentNhiId(assigneePeerId) : null;
    if (grantTaskId && granteeNhiId) {
      const taskGrant = issueTaskGrantBestEffort({
        granteeNhiId,
        audience: { missionId, taskId: grantTaskId },
        scope: {
          ...(item.context?.tenant_slug ? { tenant_slug: item.context.tenant_slug } : {}),
        },
        issuedBy: 'workitem-dispatch',
      });
      if (taskGrant) {
        record.notes.push(`task grant issued: ${taskGrant.grant_id}`);
      }
    }

    let response: Awaited<ReturnType<typeof obtainTaskResultResponse>>;
    try {
      response = await obtainTaskResultResponse({
        missionId,
        item,
        teamRole,
        assigneePeerId,
        provider: teamAssignment?.provider || undefined,
        providerModelId: teamAssignment?.modelId || undefined,
        prompt: dispatchPrompt,
        taskModelHint,
        mode,
        executionSurface: options.executionSurface,
        securityScope: dispatchContext.securityScope,
        adapters,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      record.status = 'failed';
      record.work_item_status_after = 'blocked';
      record.notes.push(`response wait failed: ${reason}`);
      record.notes.push(
        reason.includes('[WORKITEM_RESPONSE_TIMEOUT]')
          ? 'next action: inspect the provider/session and re-dispatch after recovery'
          : 'next action: inspect the provider error before re-dispatching'
      );
      updateWorkItem({
        itemId: item.item_id,
        status: 'blocked',
        assigneePeerId: assigneePeerId || item.assignee_peer_id,
        metadata: {
          ...(item.metadata || {}),
          last_dispatch_at: new Date().toISOString(),
          last_dispatch_mission_id: missionId,
          last_dispatch_error: reason,
          response_wait_status: reason.includes('[WORKITEM_RESPONSE_TIMEOUT]')
            ? 'timed_out'
            : 'failed',
          response_wait_next_action: 'inspect provider/session and re-dispatch after recovery',
        },
      });
      appendDispatchEvent(dispatchEventPath(missionPath), {
        event_type: 'workitem_dispatch_failed',
        mission_id: missionId,
        item_id: item.item_id,
        team_role: teamRole,
        assignee_peer_id: assigneePeerId,
        reason,
        response_wait_status: reason.includes('[WORKITEM_RESPONSE_TIMEOUT]')
          ? 'timed_out'
          : 'failed',
        next_action: 'inspect provider/session and re-dispatch after recovery',
      });
      records.push(record);
      continue;
    }
    const cognitiveRouteSummary = formatCognitiveRouteDecision(dispatchContext.cognitiveRoute);
    let reviewerResult: {
      verdict: WorkItemDispatchReviewerVerdict;
      reviewerPrompt: string;
      reviewerPath: string;
      reviewerExcerpt: string;
      reviewerTaskModelHint: TaskModelHint;
      reviewerContextPackId: string;
      reviewerContextPackPath: string;
      reviewerExecutionSurface: MissionExecutionSurface;
      reviewerExecutionSurfaceUsed: 'cli_subagent' | 'agent_runtime';
      reviewerAgentId?: string;
      reviewerAttemptId?: string;
      reviewerRuntimeId?: string;
      reviewerOutputRef?: string;
      reviewerProvider?: string;
    } | null = null;
    if (independentReviewRequired) {
      reviewerResult = await runIndependentReviewerReview({
        missionPath,
        missionId,
        missionState: state,
        item,
        teamRole,
        assigneePeerId,
        executionResponse: response.responseText,
        taskModelHint,
        reviewExecutionSurface: options.reviewExecutionSurface,
        adapters,
      });
      record.reviewer_path = reviewerResult.reviewerPath;
      record.reviewer_excerpt = reviewerResult.reviewerExcerpt;
      record.reviewer_status = reviewerResult.verdict.approved
        ? 'approved'
        : reviewerResult.verdict.refuted
          ? 'refuted'
          : 'blocked';
      record.reviewer_notes = [
        ...(reviewerResult.verdict.rationale ? [reviewerResult.verdict.rationale] : []),
        ...reviewerResult.verdict.findings,
      ].filter(Boolean);
      if (!reviewerResult.verdict.approved) {
        record.notes.push(
          `independent reviewer ${record.reviewer_status || 'blocked'}: ${
            record.reviewer_notes?.join('; ') || 'no findings provided'
          }`
        );
      }
      record.notes.push(
        `independent reviewer context pack: ${reviewerResult.reviewerContextPackId}`
      );
      record.review_execution_surface = reviewerResult.reviewerExecutionSurface;
      record.review_execution_surface_used = reviewerResult.reviewerExecutionSurfaceUsed;
      record.reviewer_agent_id = reviewerResult.reviewerAgentId;
      record.review_attempt_id = reviewerResult.reviewerAttemptId;
      record.review_runtime_id = reviewerResult.reviewerRuntimeId;
      record.review_output_ref = reviewerResult.reviewerOutputRef;
      record.review_provider = reviewerResult.reviewerProvider;
    }
    const taskResultNeeds = response.taskResult?.needs || [];
    const taskResultObservability = summarizeDispatchObservability({
      pruning: dispatchContext.contextPackPruningSummary,
      scopeAudit: dispatchContext.contextPackScopeAudit,
      taskResult: response.taskResult,
      parseErrors: response.parseErrors,
    });
    const clarificationPacket =
      taskResultNeeds.length > 0 && response.taskResult
        ? buildTaskResultClarificationPacket({
            missionId,
            item,
            taskResult: response.taskResult,
          })
        : undefined;
    const clarificationPacketPath = clarificationPacket
      ? buildClarificationArtifactPath(missionPath, item.item_id)
      : undefined;
    const driftWatchdog = evaluateWorkItemDrift({
      missionId,
      item,
      prompt: dispatchPrompt,
      responseText: response.responseText,
      cognitiveRouteSummary,
      executionMode: response.executionMode,
      ticketState: finalStatus,
    });
    const artifactReviewReceipt = isResolvedArtifactReviewContext(artifactReviewContext)
      ? persistWorkItemArtifactReviewReceipt({
          missionPath,
          missionId,
          item,
          context: artifactReviewContext,
          taskResult: response.taskResult,
        })
      : null;
    if (artifactReviewReceipt) {
      record.artifact_review_receipt = artifactReviewReceipt.relativePath;
      record.notes.push(`artifact review receipt: ${artifactReviewReceipt.relativePath}`);
    }
    const effectiveFinalStatus = driftWatchdog.shouldStop
      ? 'blocked'
      : !response.taskResult || response.parseErrors.length > 0 || taskResultNeeds.length > 0
        ? 'blocked'
        : response.repairRequiresReview
          ? 'review'
          : artifactReviewReceipt && artifactReviewReceipt.receipt.verdict !== 'approved'
            ? 'review'
            : independentReviewRequired && reviewerResult && !reviewerResult.verdict.approved
              ? 'review'
              : finalStatus;
    record.execution_mode = response.executionMode;
    record.execution_surface_used = response.executionSurfaceUsed;
    record.notes.push(...response.notes);
    if (response.repairs.length > 0) {
      record.task_result_repairs = response.repairs;
      record.notes.push(`task_result repairs: ${response.repairs.join('; ')}`);
    }
    if (response.repairRequiresReview) {
      record.task_result_repair_requires_review = true;
      record.notes.push('task_result semantic repair remained after retry; review required');
    }
    if (response.taskResult) {
      record.task_result = response.taskResult;
    }
    if (response.parseErrors.length > 0) {
      record.task_result_errors = response.parseErrors;
      record.notes.push(`task_result parse errors: ${response.parseErrors.join('; ')}`);
    }
    if (taskResultNeeds.length > 0) {
      record.notes.push(`task_result needs: ${taskResultNeeds.join('; ')}`);
      record.notes.push('needs_input');
    }
    if (clarificationPacket && clarificationPacketPath) {
      writeDispatchArtifact(clarificationPacketPath, {
        mission_id: missionId,
        item_id: item.item_id,
        task_result: response.taskResult,
        clarification_packet: clarificationPacket,
        clarification_packet_path: clarificationPacketPath,
        needs: taskResultNeeds,
        status: 'needs_input',
        written_at: new Date().toISOString(),
      });
      record.clarification_packet = clarificationPacket;
      record.clarification_packet_path = clarificationPacketPath;
      record.notes.push(`clarification packet: ${clarificationPacketPath}`);
    }
    if (driftWatchdog.shouldStop) {
      record.notes.push(driftWatchdog.decision.reason);
      record.notes.push('needs_attention');
    }
    record.cognitive_route = dispatchContext.cognitiveRoute;
    record.cognitive_route_summary = cognitiveRouteSummary;
    record.drift_watchdog = {
      ...driftWatchdog.stateUpdates,
      should_stop: driftWatchdog.shouldStop,
      needs_attention: driftWatchdog.decision.needs_attention,
      budget_exceeded: driftWatchdog.decision.budget_exceeded,
      repeated_signature: driftWatchdog.decision.repeated_signature,
      signature: driftWatchdog.decision.signature,
      reason: driftWatchdog.decision.reason,
    };
    record.drift_watchdog_summary = driftWatchdog.decisionSummary;
    record.attempt_id = response.attemptId;
    record.runtime_id = response.runtimeId;
    record.output_ref = response.outputRef;
    record.executor_agent_id = response.executorAgentId;
    record.provider = response.provider;
    record.model_id = response.modelId;
    record.native_subagent = response.nativeSubagent;

    const artifact = buildDispatchResponseArtifact({
      missionPath,
      missionId,
      item,
      teamRole,
      assigneePeerId,
      contextPackId: dispatchContext.contextPackId,
      contextPackPath: dispatchContext.contextPackPath,
      cognitiveRoute: dispatchContext.cognitiveRoute,
      cognitiveRouteSummary,
      taskModelHint,
      driftWatchdogSummary: driftWatchdog.decisionSummary,
      reviewerStatus: record.reviewer_status,
      reviewerPath: record.reviewer_path,
      reviewerExcerpt: record.reviewer_excerpt,
      taskResult: response.taskResult,
      clarificationPacket,
      clarificationPacketPath,
      executionMode: response.executionMode,
      executionSurface: executionSurfaceDecision.surface,
      executionSurfaceUsed: response.executionSurfaceUsed,
      attemptId: response.attemptId,
      runtimeId: response.runtimeId,
      outputRef: response.outputRef,
      executorAgentId: response.executorAgentId,
      provider: response.provider,
      modelId: response.modelId,
      nativeSubagent: response.nativeSubagent,
      reviewExecutionSurface: record.review_execution_surface,
      reviewExecutionSurfaceUsed: record.review_execution_surface_used,
      reviewerAgentId: record.reviewer_agent_id,
      reviewAttemptId: record.review_attempt_id,
      reviewRuntimeId: record.review_runtime_id,
      reviewOutputRef: record.review_output_ref,
      reviewProvider: record.review_provider,
      responseText: response.responseText,
      prompt: dispatchPrompt,
      taskResultRepairs: response.repairs,
      taskResultRepairRequiresReview: response.repairRequiresReview,
    });
    writeDispatchArtifact(artifact.filePath, artifact.payload);
    record.response_path = artifact.filePath;
    record.response_excerpt = response.responseText.slice(0, 400);
    record.context_pack_id = dispatchContext.contextPackId;
    record.context_pack_path = dispatchContext.contextPackPath;
    record.task_model_hint = taskModelHint;

    const reflection = await reflectTicketOutcome({
      missionPath,
      missionId,
      item,
      teamRole,
      assigneePeerId,
      contextPackId: dispatchContext.contextPackId,
      contextPackPath: dispatchContext.contextPackPath,
      cognitiveRoute: dispatchContext.cognitiveRoute,
      driftWatchdogSummary: driftWatchdog.decisionSummary,
      finalStatus: effectiveFinalStatus,
      responseText: response.responseText,
      responsePath: artifact.filePath,
      responseExcerpt: record.response_excerpt || response.responseText.slice(0, 400),
      notes: record.notes,
      reviewerStatus: record.reviewer_status,
      reviewerPath: record.reviewer_path,
      reviewerExcerpt: record.reviewer_excerpt,
      artifactReviewReceipt: artifactReviewReceipt || undefined,
      taskResult: response.taskResult,
      clarificationPacket,
      clarificationPacketPath,
      executionMode: response.executionMode,
      taskModelHint,
    });
    record.reflection_status = reflection.ticketState;
    if (reflection.reflectionPath) {
      record.reflection_path = reflection.reflectionPath;
    }
    record.reflection_excerpt = record.response_excerpt;
    record.reflected_at = new Date().toISOString();
    record.ticket_state_after = reflection.ticketState;
    record.notes.push(...reflection.notes);

    const currentItem = getWorkItem(item.item_id);
    const currentMetadata = (currentItem?.metadata || item.metadata || {}) as Record<
      string,
      unknown
    >;
    updateWorkItem({
      itemId: item.item_id,
      status: reflection.ticketState,
      assigneePeerId: assigneePeerId || item.assignee_peer_id,
      metadata: {
        ...currentMetadata,
        last_dispatch_at: new Date().toISOString(),
        last_dispatch_mode: response.executionMode,
        execution_surface: executionSurfaceDecision.surface,
        execution_surface_used: response.executionSurfaceUsed,
        ...(response.attemptId ? { last_dispatch_attempt_id: response.attemptId } : {}),
        ...(response.runtimeId ? { last_dispatch_runtime_id: response.runtimeId } : {}),
        ...(response.outputRef ? { last_dispatch_output_ref: response.outputRef } : {}),
        ...(response.executorAgentId
          ? { last_dispatch_executor_agent_id: response.executorAgentId }
          : {}),
        ...(response.provider ? { last_dispatch_provider: response.provider } : {}),
        ...(reviewExecutionSurfaceDecision
          ? {
              review_execution_surface: reviewExecutionSurfaceDecision.surface,
              review_execution_surface_used: record.review_execution_surface_used,
            }
          : {}),
        last_dispatch_mission_id: missionId,
        last_dispatch_response_path: artifact.filePath,
        last_dispatch_response_excerpt: record.response_excerpt,
        resolved_agent_id: assigneePeerId,
        last_context_pack_id: dispatchContext.contextPackId,
        last_context_pack_path: dispatchContext.contextPackPath,
        last_cognitive_route_tier: dispatchContext.cognitiveRoute.tier,
        last_cognitive_route_reason: dispatchContext.cognitiveRoute.reason,
        last_cognitive_route_summary: cognitiveRouteSummary,
        last_task_model_hint: taskModelHint,
        last_task_result_needs: taskResultNeeds,
        last_clarification_packet_path: clarificationPacketPath,
        needs_input: Boolean(clarificationPacket),
        ...(artifactReviewReceipt
          ? { last_artifact_review_receipt: artifactReviewReceipt.relativePath }
          : {}),
        ...(reviewerResult
          ? {
              last_independent_reviewer_status: record.reviewer_status,
              last_independent_reviewer_path: record.reviewer_path,
              last_independent_reviewer_excerpt: record.reviewer_excerpt,
              last_review_execution_surface: record.review_execution_surface,
              last_review_execution_surface_used: record.review_execution_surface_used,
              ...(record.reviewer_agent_id
                ? { last_reviewer_agent_id: record.reviewer_agent_id }
                : {}),
              ...(record.review_attempt_id
                ? { last_review_attempt_id: record.review_attempt_id }
                : {}),
              ...(record.review_runtime_id
                ? { last_review_runtime_id: record.review_runtime_id }
                : {}),
              ...(record.review_output_ref
                ? { last_review_output_ref: record.review_output_ref }
                : {}),
              ...(record.review_provider ? { last_review_provider: record.review_provider } : {}),
            }
          : {}),
        ...driftWatchdog.stateUpdates,
        last_drift_watchdog_summary: driftWatchdog.decisionSummary,
        last_drift_watchdog_reason: driftWatchdog.decision.reason,
      },
    });

    appendDispatchEvent(dispatchEventPath(missionPath), {
      event_type: 'workitem_dispatched',
      mission_id: missionId,
      item_id: item.item_id,
      team_role: teamRole,
      assignee_peer_id: assigneePeerId,
      execution_mode: response.executionMode,
      execution_surface: executionSurfaceDecision.surface,
      execution_surface_used: response.executionSurfaceUsed,
      attempt_id: response.attemptId,
      runtime_id: response.runtimeId,
      output_ref: response.outputRef,
      executor_agent_id: response.executorAgentId,
      provider: response.provider,
      ...(record.review_execution_surface
        ? {
            review_execution_surface: record.review_execution_surface,
            review_execution_surface_used: record.review_execution_surface_used,
            reviewer_agent_id: record.reviewer_agent_id,
            review_attempt_id: record.review_attempt_id,
            review_runtime_id: record.review_runtime_id,
            review_output_ref: record.review_output_ref,
            review_provider: record.review_provider,
          }
        : {}),
      response_path: artifact.filePath,
      status_after: reflection.ticketState,
      ticket_state_after: reflection.ticketState,
      ticket_reflection_path: reflection.reflectionPath || undefined,
      reviewer_status: record.reviewer_status,
      reviewer_path: record.reviewer_path,
      artifact_review_receipt: record.artifact_review_receipt,
      context_pack_id: dispatchContext.contextPackId,
      context_pack_path: dispatchContext.contextPackPath,
      ...taskResultObservability,
      cognitive_route: dispatchContext.cognitiveRoute,
      cognitive_route_summary: cognitiveRouteSummary,
      drift_watchdog: record.drift_watchdog,
      drift_watchdog_summary: driftWatchdog.decisionSummary,
      clarification_packet_path: clarificationPacketPath,
    });
    await recordTask(missionId, `Dispatched work item ${item.item_id}`, {
      next_step:
        reflection.ticketState === 'blocked'
          ? 'resolve the blocker before continuing'
          : 'await the dispatched response and continue reconciliation',
      work_item_id: item.item_id,
      team_role: teamRole,
      assignee_peer_id: assigneePeerId,
      execution_mode: response.executionMode,
      execution_surface: executionSurfaceDecision.surface,
      execution_surface_used: response.executionSurfaceUsed,
      attempt_id: response.attemptId,
      runtime_id: response.runtimeId,
      output_ref: response.outputRef,
      executor_agent_id: response.executorAgentId,
      provider: response.provider,
      context_pack_id: dispatchContext.contextPackId,
      context_pack_path: dispatchContext.contextPackPath,
      context_pack_summary: dispatchContext.contextPackSummary,
      context_pack_pruning_summary: dispatchContext.contextPackPruningSummary,
      ...taskResultObservability,
      cognitive_route_summary: cognitiveRouteSummary,
      drift_watchdog_summary: driftWatchdog.decisionSummary,
      ticket_state_after: reflection.ticketState,
      response_path: artifact.filePath,
      reviewer_agent_id: record.reviewer_agent_id,
      review_attempt_id: record.review_attempt_id,
      review_runtime_id: record.review_runtime_id,
      review_output_ref: record.review_output_ref,
      review_provider: record.review_provider,
    });
    record.status = 'updated';
    record.work_item_status_after = reflection.ticketState;
    records.push(record);
  }

  const manifest: MissionWorkItemDispatchManifest = {
    mission_id: missionId,
    mission_type: state.mission_type,
    tier: state.tier,
    tenant_slug: state.tenant_slug,
    created_at: existingManifest?.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    mode,
    final_status: finalStatus,
    work_item_count: records.length,
    records,
  };

  const manifestFilePath = manifestPath(missionPath);
  manifest.manifest_path = manifestFilePath;
  manifest.event_path = dispatchEventPath(missionPath);
  writeJsonFileFromDispatchIO(manifestFilePath, manifest);

  appendDispatchEvent(dispatchEventPath(missionPath), {
    event: 'dispatch_completed',
    event_type: 'workitem_dispatch_completed',
    mission_id: missionId,
    round,
    mode,
    selected_count: Math.min(workItems.length, limit),
    processed_count: records.length,
    status_counts: records.reduce<Record<string, number>>((counts, record) => {
      counts[record.status] = (counts[record.status] || 0) + 1;
      return counts;
    }, {}),
  });

  ledger.record('MISSION_WORKITEMS_DISPATCHED', {
    mission_id: missionId,
    work_item_count: records.length,
    mode,
    final_status: finalStatus,
    manifest_path: manifestFilePath,
  });

  logger.info(
    `[workitems] mission=${missionId} mode=${mode} count=${records.length} final=${finalStatus}`
  );
  return manifest;
}
