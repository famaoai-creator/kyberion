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

/**
 * Confidential missions default to external_egress=deny. A model-backed
 * WorkItem may opt into one provider only when both provider-tier policy and
 * tenant-specific domain policy approve it; all other providers remain denied.
 */

import {
  runWithWorkItemResponseDeadline,
  getWorkItemTaskId,
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
  routeToAgentOrSubagent,
} from './mission-workitem-dispatch-review.js';
import type {
  MissionWorkItemDispatchMode,
  MissionWorkItemDispatchFinalStatus,
  WorkItemExecutionOutcome,
  MissionWorkItemDispatchOptions,
  MissionWorkItemDispatchRecord,
  MissionWorkItemDispatchManifest,
  WorkItemDispatchAdapters,
  WorkItemDispatchReviewerVerdict,
  WorkItemReviewPlannedTask,
  WorkItemArtifactReviewContext,
  ResolvedWorkItemArtifactReviewContext,
} from './mission-workitem-dispatch-review.js';

export function validateWorkItemGranularity(
  item: WorkItem,
  assigneePeerId?: string
): { ok: boolean; notes: string[] } {
  const notes: string[] = [];
  const description = String(item.description || '').trim();
  const metadata = (item.metadata || {}) as Record<string, unknown>;
  if (!item.assignee_peer_id && !assigneePeerId) {
    notes.push('missing assignee_peer_id');
  }
  if (!description) {
    notes.push('missing description');
  } else if (countWordsFromDispatchIO(description) < 6) {
    notes.push('description too short');
  }
  if (!metadata.deliverable && !metadata.target_path) {
    notes.push('missing deliverable or target_path');
  }
  return { ok: notes.length === 0, notes };
}

export function resolveWorkItemProjectIds(state: MissionState): string[] {
  const missionId = state.mission_id.toUpperCase();
  const linkedProjectId = String(state.relationships?.project?.project_id || '').trim();
  if (linkedProjectId) {
    if (state.tier === 'confidential' && !state.tenant_slug?.trim()) {
      throw new Error(
        `[MISSION_WORKITEM_SCOPE_REQUIRED] Confidential mission ${missionId} needs tenant_slug before dispatch.`
      );
    }
    return [linkedProjectId];
  }

  const tenantSlug = state.tenant_slug?.trim();
  if (!tenantSlug) {
    throw new Error(
      `[MISSION_WORKITEM_SCOPE_REQUIRED] Mission ${missionId} needs tenant_slug before recovering a project from WorkItems.`
    );
  }

  // Legacy/onboarding missions may predate the explicit mission→project
  // relationship. Recover the project from the scoped canonical WorkItems so
  // typed context remains the source of truth without broadening tenant scope.
  const scopedItems = listWorkItems({
    labels: [`mission:${missionId}`],
    tenantSlugs: [tenantSlug],
  });
  const recoveredProjectIds = scopedItems
    .filter(
      (item) => getMissionLabel(item) === missionId && item.context?.tenant_slug === tenantSlug
    )
    .map((item) => String(item.context?.project_id || item.project_id || '').trim())
    .filter(Boolean);
  const uniqueProjectIds = [...new Set(recoveredProjectIds)];
  if (uniqueProjectIds.length === 0) {
    throw new Error(
      `[MISSION_PROJECT_CONTEXT_MISSING] Mission ${missionId} has no tenant-scoped WorkItem project context.`
    );
  }
  if (uniqueProjectIds.length > 1) {
    throw new Error(
      `[MISSION_PROJECT_CONTEXT_AMBIGUOUS] Mission ${missionId} resolved multiple project IDs: ${uniqueProjectIds.join(', ')}`
    );
  }
  return uniqueProjectIds;
}

export function readMissionWorkGraph(state: MissionState): {
  items: WorkItem[];
  readyItemIds: Set<string>;
} {
  const itemsById = new Map<string, WorkItem>();
  const readyItemIds = new Set<string>();
  for (const projectId of resolveWorkItemProjectIds(state)) {
    const canonical = readCanonicalWorkGraph(projectId, {
      ...(state.tenant_slug?.trim() ? { tenantSlug: state.tenant_slug.trim() } : {}),
    });
    for (const item of canonical.items) itemsById.set(item.item_id, item);
    for (const itemId of canonical.graph.ready_item_ids) readyItemIds.add(itemId);
  }
  return { items: [...itemsById.values()], readyItemIds };
}

export function areMissionTaskDependenciesSatisfied(state: MissionState, item: WorkItem): boolean {
  const metadata = (item.metadata || {}) as Record<string, unknown>;
  const canonicalDependencies = (item.dependencies || [])
    .map((dependency) => String(dependency || '').trim())
    .filter(Boolean);
  const dependencies =
    canonicalDependencies.length > 0
      ? canonicalDependencies
      : Array.isArray(metadata.dependencies)
        ? metadata.dependencies.map((dependency) => String(dependency || '').trim()).filter(Boolean)
        : [];

  if (dependencies.length === 0) return true;
  const missionId = state.mission_id.toUpperCase();
  const canonicalStatusById = new Map<string, WorkItemStatus>();
  for (const candidate of readMissionWorkGraph(state).items) {
    if (getMissionLabel(candidate) !== missionId) continue;
    canonicalStatusById.set(candidate.item_id, candidate.status);
    const candidateTaskId = getWorkItemTaskId(candidate);
    if (candidateTaskId) canonicalStatusById.set(candidateTaskId, candidate.status);
  }
  return dependencies.every((dependency) => {
    const canonicalStatus = canonicalStatusById.get(dependency);
    return canonicalStatus === 'done' || canonicalStatus === 'archived';
  });
}

export function selectWorkItems(
  state: MissionState,
  options: MissionWorkItemDispatchOptions
): WorkItem[] {
  const missionId = state.mission_id.toUpperCase();
  const labels = [`mission:${missionId}`];
  const statuses =
    options.statuses && options.statuses.length > 0
      ? options.statuses
      : (['ready', 'backlog'] as WorkItemStatus[]);
  const sources =
    options.sources && options.sources.length > 0
      ? options.sources
      : (['local'] as WorkItemSource[]);
  const canonical = readMissionWorkGraph(state);
  const allMissionItems = canonical.items
    .filter((item) => sources.includes(item.source))
    .filter((item) => labels.every((label) => item.labels.includes(label)))
    .filter((item) => getMissionLabel(item) === missionId);
  return allMissionItems
    .filter((item) => statuses.includes(item.status))
    .filter((item) => {
      if (item.status === 'blocked') return areMissionTaskDependenciesSatisfied(state, item);
      return (
        canonical.readyItemIds.has(item.item_id) && areMissionTaskDependenciesSatisfied(state, item)
      );
    });
}

export function resolveAssigneePeerId(input: {
  missionId: string;
  item: WorkItem;
  teamRole?: string;
}): string | undefined {
  const metadata = (input.item.metadata || {}) as Record<string, unknown>;
  const resolved = metadata.resolved_agent_id;
  if (typeof resolved === 'string' && resolved) return resolved;
  if (input.item.assignee_peer_id) return input.item.assignee_peer_id;
  if (input.teamRole) {
    const assignment = resolveMissionTeamReceiver({
      missionId: input.missionId,
      teamRole: input.teamRole,
    });
    if (assignment?.agent_id) return assignment.agent_id;
  }
  return undefined;
}

export function buildDispatchResponseArtifact(input: {
  missionPath: string;
  missionId: string;
  item: WorkItem;
  teamRole?: string;
  assigneePeerId?: string;
  contextPackId?: string;
  contextPackPath?: string;
  cognitiveRoute?: CognitiveRouteDecision;
  cognitiveRouteSummary?: string;
  taskModelHint?: TaskModelHint;
  driftWatchdogSummary?: string;
  reviewerStatus?: 'approved' | 'refuted' | 'blocked';
  reviewerPath?: string;
  reviewerExcerpt?: string;
  clarificationPacket?: OperatorInteractionPacket;
  clarificationPacketPath?: string;
  executionMode: MissionWorkItemDispatchMode | 'agent' | 'subagent';
  executionSurface?: MissionExecutionSurface;
  executionSurfaceUsed?: 'cli_subagent' | 'agent_runtime';
  attemptId?: string;
  runtimeId?: string;
  outputRef?: string;
  executorAgentId?: string;
  provider?: string;
  modelId?: string;
  nativeSubagent?: Record<string, unknown>;
  reviewExecutionSurface?: MissionExecutionSurface;
  reviewExecutionSurfaceUsed?: 'cli_subagent' | 'agent_runtime';
  reviewerAgentId?: string;
  reviewAttemptId?: string;
  reviewRuntimeId?: string;
  reviewOutputRef?: string;
  reviewProvider?: string;
  responseText: string;
  prompt: string;
  taskResult?: TaskResultBlock;
  taskResultRepairs?: string[];
  taskResultRepairRequiresReview?: boolean;
}): { filePath: string; payload: Record<string, unknown> } {
  const metadata = (input.item.metadata || {}) as Record<string, unknown>;
  const acceptanceCriteria = Array.isArray(metadata.acceptance_criteria)
    ? metadata.acceptance_criteria
        .map((criterion) => String(criterion || '').trim())
        .filter(Boolean)
    : [];
  const filePath = nodePath.join(
    dispatchRoot(input.missionPath),
    `workitem-dispatch-${input.item.item_id}.json`
  );
  const payload = {
    mission_id: input.missionId,
    item_id: input.item.item_id,
    team_role: input.teamRole,
    assignee_peer_id: input.assigneePeerId,
    context_pack_id: input.contextPackId,
    context_pack_path: input.contextPackPath,
    cognitive_route: input.cognitiveRoute,
    cognitive_route_summary: input.cognitiveRouteSummary,
    task_model_hint: input.taskModelHint,
    task_result: input.taskResult,
    task_result_repairs: input.taskResultRepairs,
    task_result_repair_requires_review: input.taskResultRepairRequiresReview,
    drift_watchdog_summary: input.driftWatchdogSummary,
    reviewer_status: input.reviewerStatus,
    reviewer_path: input.reviewerPath,
    reviewer_excerpt: input.reviewerExcerpt,
    clarification_packet: input.clarificationPacket,
    clarification_packet_path: input.clarificationPacketPath,
    acceptance_criteria: acceptanceCriteria,
    execution_mode: input.executionMode,
    execution_surface: input.executionSurface,
    execution_surface_used: input.executionSurfaceUsed,
    attempt_id: input.attemptId,
    runtime_id: input.runtimeId,
    output_ref: input.outputRef,
    executor_agent_id: input.executorAgentId,
    provider: input.provider,
    model_id: input.modelId,
    native_subagent: input.nativeSubagent,
    review_execution_surface: input.reviewExecutionSurface,
    review_execution_surface_used: input.reviewExecutionSurfaceUsed,
    reviewer_agent_id: input.reviewerAgentId,
    review_attempt_id: input.reviewAttemptId,
    review_runtime_id: input.reviewRuntimeId,
    review_output_ref: input.reviewOutputRef,
    review_provider: input.reviewProvider,
    prompt: input.prompt,
    response_text: input.responseText,
    response_excerpt: input.responseText.slice(0, 800),
    written_at: new Date().toISOString(),
  };
  return { filePath, payload };
}

export function evaluateWorkItemDrift(input: {
  missionId: string;
  item: WorkItem;
  prompt: string;
  responseText: string;
  cognitiveRouteSummary: string;
  executionMode: MissionWorkItemDispatchMode | 'agent' | 'subagent';
  ticketState: MissionWorkItemDispatchFinalStatus;
}): {
  shouldStop: boolean;
  decisionSummary: string;
  stateUpdates: Record<string, unknown>;
  decision: ReturnType<typeof advanceReasoningDriftWatchdog>;
} {
  const metadata = (input.item.metadata || {}) as Record<string, unknown>;
  const priorState = hydrateReasoningDriftWatchdogState(metadata);
  const decision = advanceReasoningDriftWatchdog(priorState, {
    mission_id: input.missionId,
    item_id: input.item.item_id,
    prompt: input.prompt,
    response_text: input.responseText,
    cognitive_route_summary: input.cognitiveRouteSummary,
    execution_mode: input.executionMode,
    ticket_state: input.ticketState,
    notes: Array.isArray(metadata.drift_watchdog_last_notes)
      ? (metadata.drift_watchdog_last_notes as string[])
      : undefined,
  });
  return {
    shouldStop: decision.should_stop,
    decisionSummary: formatReasoningDriftWatchdogDecision(decision),
    stateUpdates: encodeReasoningDriftWatchdogState(decision.state),
    decision,
  };
}

export function buildWorkItemPromptBody(input: {
  missionId: string;
  item: WorkItem;
  teamRole?: string;
  assigneePeerId?: string;
  cognitiveRouteSummary?: string;
  taskModelHint?: TaskModelHint;
}): string {
  const metadata = (input.item.metadata || {}) as Record<string, unknown>;
  const acceptanceCriteria = Array.isArray(metadata.acceptance_criteria)
    ? metadata.acceptance_criteria
        .map((criterion) => String(criterion || '').trim())
        .filter(Boolean)
    : [];
  const lines = [
    `Execute work item ${input.item.item_id} for mission ${input.missionId}.`,
    input.teamRole ? `Assigned team role: ${input.teamRole}` : '',
    input.assigneePeerId ? `Assigned agent: ${input.assigneePeerId}` : '',
    input.cognitiveRouteSummary ? `Cognitive route: ${input.cognitiveRouteSummary}` : '',
    input.taskModelHint
      ? `Model hint: ${input.taskModelHint.model_id} (${input.taskModelHint.tier}/${input.taskModelHint.effort})`
      : '',
    `Title: ${input.item.title}`,
    `Description: ${input.item.description}`,
    metadata.deliverable ? `Deliverable: ${String(metadata.deliverable)}` : '',
    metadata.target_path ? `Target path: ${String(metadata.target_path)}` : '',
    metadata.assignee_label ? `Assignee label: ${String(metadata.assignee_label)}` : '',
    acceptanceCriteria.length > 0
      ? [
          'WORK ITEM ACCEPTANCE CRITERIA (authoritative; ignore criteria from other tasks in the context pack):',
          ...acceptanceCriteria.map((criterion) => `- ${criterion}`),
        ].join('\n')
      : '',
    ...buildFastTierPromptAddendum(input.taskModelHint),
    '',
    ...buildWorkingPrinciplesLines(input.teamRole),
    'Return exactly one ```task_result``` block and nothing else structured.',
    'Task result schema: {"summary":"3 sentences max","artifacts":[{"path":"...","kind":"..."}],"verification_done":["..."],"gaps":["..."],"needs":["..."],"acceptance_evidence":[{"criterion":"exact criterion text","status":"passed|failed","evidence":"specific verification or artifact"}]}',
    acceptanceCriteria.length > 0
      ? [
          'For every WORK ITEM ACCEPTANCE CRITERION above, copy that exact text into acceptance_evidence.',
          'Do not copy acceptance criteria from the mission context pack or another task.',
          'Record specific evidence and do not mark a criterion passed without evidence.',
        ].join(' ')
      : '',
    'Do not paste file contents. Include only conclusions, artifact paths, verification steps, gaps, and needs.',
  ].filter(Boolean);
  return lines.join('\n');
}

export function buildTaskResultRetryPrompt(input: {
  missionId: string;
  item: WorkItem;
  previousResponse: string;
  parseErrors: string[];
}): string {
  const metadata = (input.item.metadata || {}) as Record<string, unknown>;
  const hasAcceptanceCriteria =
    Array.isArray(metadata.acceptance_criteria) && metadata.acceptance_criteria.length > 0;
  const acceptanceCriteria = hasAcceptanceCriteria
    ? (metadata.acceptance_criteria as unknown[])
        .map((criterion) => String(criterion || '').trim())
        .filter(Boolean)
    : [];
  return [
    `The previous response for mission ${input.missionId} and work item ${input.item.item_id} was rejected.`,
    'Resend the answer as exactly one ```task_result``` block.',
    'Required fields and shapes: summary (string), artifacts (array of objects with path and kind strings), verification_done (array of strings), gaps (array of strings), needs (array of strings), and acceptance_evidence (array of objects with criterion, status, and evidence strings).',
    'Use this minimal valid shape when there are no gaps or needs: {"summary":"...","artifacts":[{"path":"evidence/example.json","kind":"json"}],"verification_done":["..."],"gaps":[],"needs":[],"acceptance_evidence":[{"criterion":"<exact WorkItem criterion>","status":"passed","evidence":"<specific evidence>"}]}',
    'Every acceptance_evidence entry must include status exactly "passed" or "failed"; never omit it. Every artifacts entry must be an object, never a bare path string.',
    hasAcceptanceCriteria
      ? [
          'The only acceptance criteria for this retry are the following WorkItem criteria; ignore all criteria from the context pack or other tasks:',
          ...acceptanceCriteria.map((criterion) => `- ${criterion}`),
          'Include acceptance_evidence for every one using the exact text and specific evidence.',
        ].join('\n')
      : '',
    'Do not include other structured blocks.',
    'Errors:',
    ...input.parseErrors.map((error) => `- ${error}`),
    '',
    'Previous response excerpt:',
    input.previousResponse.slice(0, 1200),
  ].join('\n');
}

export async function buildWorkItemDispatchContext(input: {
  missionPath: string;
  missionId: string;
  missionState: MissionState;
  item: WorkItem;
  teamRole?: string;
  assigneePeerId?: string;
  taskModelHint?: TaskModelHint;
}): Promise<{
  prompt: string;
  contextPackId: string;
  contextPackPath: string;
  contextPackSummary: string;
  contextPackPruningSummary?: Record<string, unknown>;
  contextPackScopeAudit?: { rejected: Array<{ code: string }> };
  securityScope: ContextSecurityScope;
  cognitiveRoute: CognitiveRouteDecision;
}> {
  const contextPack = await resolveMissionContextPack({
    missionId: input.missionId,
    tier: input.missionState.tier,
    tenantSlug: input.missionState.tenant_slug,
    recipientKind: input.assigneePeerId ? 'agent' : 'subagent',
    teamRole: input.teamRole,
    assigneePeerId: input.assigneePeerId,
    workItemId: input.item.item_id,
    projectId: input.missionState.relationships?.project?.project_id || input.item.project_id,
    trackId: input.missionState.relationships?.track?.track_id,
    workItem: input.item,
    missionState: input.missionState,
  });
  if (!contextPack) {
    throw new Error(`Unable to resolve mission context pack for ${input.missionId}`);
  }
  const contextPackPath = saveMissionContextPack(input.missionPath, contextPack);
  const cognitiveRoute = buildCognitiveRouteDecision({
    mission_id: input.missionId,
    mission_type: input.missionState.mission_type,
    tenant_slug: input.missionState.tenant_slug,
    assigned_persona: input.missionState.assigned_persona,
    status: input.missionState.status,
    team_role: input.teamRole,
    recipient_kind: contextPack.recipient.kind,
    item_id: input.item.item_id,
    title: input.item.title,
    description: input.item.description,
    labels: input.item.labels,
    metadata: input.item.metadata as Record<string, unknown> | undefined,
    prompt: buildWorkItemPromptBody({
      missionId: input.missionId,
      item: input.item,
      teamRole: input.teamRole,
      assigneePeerId: input.assigneePeerId,
      taskModelHint: input.taskModelHint,
    }),
    context_pack_id: contextPack.context_pack_id,
    context_pack_path: contextPackPath,
  });
  const prompt = [
    `Cognitive route: ${formatCognitiveRouteDecision(cognitiveRoute)}`,
    '',
    renderMissionContextPack(contextPack),
    '',
    buildWorkItemPromptBody({
      missionId: input.missionId,
      item: input.item,
      teamRole: input.teamRole,
      assigneePeerId: input.assigneePeerId,
      taskModelHint: input.taskModelHint,
    }),
  ].join('\n');
  return {
    prompt,
    contextPackId: contextPack.context_pack_id,
    contextPackPath,
    contextPackSummary: contextPack.summary,
    contextPackPruningSummary: contextPack.pruning
      ? (contextPack.pruning as unknown as Record<string, unknown>)
      : undefined,
    contextPackScopeAudit: contextPack.scope_audit
      ? {
          rejected: contextPack.scope_audit.rejected.map((rejection) => ({ code: rejection.code })),
        }
      : undefined,
    securityScope: contextPack.security_scope,
    cognitiveRoute,
  };
}

export function summarizeDispatchObservability(input: {
  pruning?: Record<string, unknown>;
  scopeAudit?: { rejected: Array<{ code: string }> };
  taskResult?: { needs?: string[] } | undefined;
  parseErrors: string[];
}): {
  context_chars?: number;
  pruned_chars?: number;
  rollup_used: boolean;
  result_schema_ok: boolean;
  needs_count: number;
  scope_rejected_count: number;
  scope_rejection_codes: string[];
} {
  const estimatedCharsValue = input.pruning?.['estimated_chars'];
  const budgetCharsValue = input.pruning?.['budget_chars'];
  const rollupPathValue = input.pruning?.['rollup_path'];
  const estimatedChars =
    typeof estimatedCharsValue === 'number' && Number.isFinite(estimatedCharsValue)
      ? estimatedCharsValue
      : undefined;
  const budgetChars =
    typeof budgetCharsValue === 'number' && Number.isFinite(budgetCharsValue)
      ? budgetCharsValue
      : undefined;
  const needsCount = input.taskResult?.needs?.length || 0;
  return {
    ...(typeof estimatedChars === 'number' ? { context_chars: estimatedChars } : {}),
    ...(typeof estimatedChars === 'number' && typeof budgetChars === 'number'
      ? { pruned_chars: Math.max(0, estimatedChars - budgetChars) }
      : {}),
    rollup_used: Boolean(rollupPathValue),
    result_schema_ok: Boolean(
      input.taskResult && input.parseErrors.length === 0 && needsCount === 0
    ),
    needs_count: needsCount,
    scope_rejected_count: input.scopeAudit?.rejected.length || 0,
    scope_rejection_codes: [
      ...new Set(input.scopeAudit?.rejected.map((item) => item.code) || []),
    ].sort(),
  };
}

export function parseTaskResultResponse(responseText: string): {
  taskResult?: NonNullable<ReturnType<typeof extractSurfaceBlocks>['taskResults']>[number];
  parseErrors: string[];
  repairs: string[];
  repairRequiresReview: boolean;
  surfaceParseErrors: string[];
  plainText: string;
} {
  const structured = extractSurfaceBlocks(responseText);
  return {
    taskResult: structured.taskResults?.[0],
    parseErrors: structured.taskResultErrors || [],
    repairs: structured.taskResultRepairs || [],
    repairRequiresReview: Boolean(structured.taskResultRepairRequiresReview),
    surfaceParseErrors: structured.surfaceParseErrors || [],
    plainText: structured.text,
  };
}

export function buildTaskResultClarificationPacket(input: {
  missionId: string;
  item: WorkItem;
  taskResult: TaskResultBlock;
}): OperatorInteractionPacket | undefined {
  const needs = input.taskResult.needs || [];
  if (needs.length === 0) return undefined;
  return resolveQuestionInteractionPacket(
    {
      text: [
        `Mission ${input.missionId} work item ${input.item.item_id}`,
        input.item.title,
        input.item.description,
        input.taskResult.summary,
        `Unresolved needs: ${needs.join('; ')}`,
      ]
        .filter(Boolean)
        .join('\n'),
      requiredInputs: needs,
      supplementalQuestions: needs.map((need, index) => ({
        id: `task_result_need_${index + 1}`,
        question: `Please provide ${need.replace(/_/g, ' ')}.`,
        reason: 'The task result still needs this input before the work item can be resolved.',
        required_input: need,
        impact: 'The work item remains blocked until the missing input is available.',
      })),
      maxQuestions: Math.min(3, Math.max(1, needs.length)),
    },
    `Clarification needed for work item ${input.item.item_id}`,
    'The task result still has unresolved needs_input and cannot be marked complete yet.'
  );
}

export function buildClarificationArtifactPath(missionPath: string, itemId: string): string {
  return nodePath.join(dispatchRoot(missionPath), `workitem-clarification-${itemId}.json`);
}

export async function obtainTaskResultResponse(input: {
  missionId: string;
  item: WorkItem;
  teamRole?: string;
  assigneePeerId?: string;
  provider?: string;
  providerModelId?: string;
  prompt: string;
  taskModelHint: TaskModelHint;
  mode: MissionWorkItemDispatchMode;
  executionSurface?: MissionExecutionSurface;
  securityScope: ContextSecurityScope;
  adapters: WorkItemDispatchAdapters;
}): Promise<
  {
    executionMode: 'agent' | 'subagent';
    executionSurfaceUsed: 'cli_subagent' | 'agent_runtime';
  } & WorkItemExecutionOutcome & {
      taskResult?: TaskResultBlock;
      parseErrors: string[];
      repairs: string[];
      repairRequiresReview: boolean;
      surfaceParseErrors: string[];
      notes: string[];
      retried: boolean;
    }
> {
  let attemptPrompt = input.prompt;
  const notes: string[] = [];
  let retried = false;
  const route = (prompt: string, contextMode: AgentContextMode) =>
    runWithWorkItemResponseDeadline((signal) =>
      routeToAgentOrSubagent({
        missionId: input.missionId,
        item: input.item,
        teamRole: input.teamRole,
        assigneePeerId: input.assigneePeerId,
        provider: input.provider,
        providerModelId: input.providerModelId,
        prompt,
        taskModelHint: input.taskModelHint,
        mode: input.mode,
        defaultExecutionSurface: input.executionSurface,
        securityScope: input.securityScope,
        adapters: input.adapters,
        signal,
        contextMode,
      })
    );
  let response = await route(attemptPrompt, 'fresh');
  let parsed = parseTaskResultResponse(response.responseText);
  let taskResult = parsed.taskResult;
  let parseErrors = parsed.parseErrors;
  let repairs = parsed.repairs;
  let repairRequiresReview = parsed.repairRequiresReview;
  let surfaceParseErrors = parsed.surfaceParseErrors;
  const needsRetry =
    !taskResult ||
    parseErrors.length > 0 ||
    repairRequiresReview ||
    (taskResult.needs || []).length > 0;

  if (needsRetry) {
    retried = true;
    if (taskResult?.needs?.length) {
      notes.push(`task_result.needs requested: ${taskResult.needs.join('; ')}`);
    }
    if (parseErrors.length > 0) {
      notes.push(`task_result parse errors: ${parseErrors.join('; ')}`);
    }
    if (repairRequiresReview) {
      notes.push('task_result semantic repair requires a contract-correct retry');
    }
    if (surfaceParseErrors.length > 0) {
      notes.push(`surface parse errors: ${surfaceParseErrors.join('; ')}`);
    }
    attemptPrompt = buildTaskResultRetryPrompt({
      missionId: input.missionId,
      item: input.item,
      previousResponse: response.responseText,
      parseErrors: [
        ...(taskResult?.needs?.length ? [`needs unresolved: ${taskResult.needs.join('; ')}`] : []),
        ...parseErrors,
      ],
    });
    // Contract repair retries should not inherit a model's prior structured
    // output as conversational authority. The retry prompt carries the
    // bounded evidence and exact WorkItem criteria explicitly; a fresh turn
    // prevents unrelated criteria from the context pack from winning again.
    response = await route(attemptPrompt, 'fresh');
    parsed = parseTaskResultResponse(response.responseText);
    taskResult = parsed.taskResult;
    parseErrors = parsed.parseErrors;
    repairs = parsed.repairs;
    repairRequiresReview = parsed.repairRequiresReview;
    surfaceParseErrors = parsed.surfaceParseErrors;
    if (!taskResult) {
      notes.push('task_result missing after retry');
    }
    if (parseErrors.length > 0) {
      notes.push(`task_result parse errors after retry: ${parseErrors.join('; ')}`);
    }
    if (surfaceParseErrors.length > 0) {
      notes.push(`surface parse errors after retry: ${surfaceParseErrors.join('; ')}`);
    }
  }

  return {
    executionMode: response.executionMode,
    executionSurfaceUsed: response.executionSurfaceUsed,
    responseText: response.responseText,
    attemptId: response.attemptId,
    runtimeId: response.runtimeId,
    outputRef: response.outputRef,
    executorAgentId: response.executorAgentId,
    provider: response.provider,
    modelId: response.modelId,
    nativeSubagent: response.nativeSubagent,
    taskResult,
    parseErrors,
    repairs,
    repairRequiresReview,
    surfaceParseErrors,
    notes,
    retried,
  };
}
