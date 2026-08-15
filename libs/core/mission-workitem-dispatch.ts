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

interface WorkItemExecutionOutcome {
  responseText: string;
  attemptId?: string;
  runtimeId?: string;
  outputRef?: string;
  executorAgentId?: string;
  provider?: string;
  modelId?: string;
  nativeSubagent?: Record<string, unknown>;
}

export interface MissionWorkItemDispatchOptions {
  mode?: MissionWorkItemDispatchMode;
  executionSurface?: MissionExecutionSurface;
  reviewExecutionSurface?: MissionExecutionSurface;
  limit?: number;
  statuses?: WorkItemStatus[];
  sources?: WorkItemSource[];
  finalStatus?: MissionWorkItemDispatchFinalStatus;
  /**
   * Bounded auto-rounds: after a round, re-select still-actionable items
   * (ready/backlog/blocked) and dispatch again until nothing remains, no
   * progress is made, or the round budget is spent. Default 1 (single round)
   * unless KYBERION_DISPATCH_MAX_ROUNDS overrides it.
   */
  rounds?: number;
}

export interface MissionWorkItemDispatchRecord {
  item_id: string;
  title: string;
  team_role?: string;
  assignee_peer_id?: string;
  context_pack_id?: string;
  context_pack_path?: string;
  execution_mode: MissionWorkItemDispatchMode | 'agent' | 'subagent';
  execution_surface?: MissionExecutionSurface;
  execution_surface_used?: 'cli_subagent' | 'agent_runtime';
  review_execution_surface?: MissionExecutionSurface;
  review_execution_surface_used?: 'cli_subagent' | 'agent_runtime';
  status: 'created' | 'updated' | 'skipped' | 'failed' | 'deferred';
  work_item_status_before?: WorkItemStatus;
  work_item_status_after?: WorkItemStatus;
  response_path?: string;
  response_excerpt?: string;
  cognitive_route?: CognitiveRouteDecision;
  cognitive_route_summary?: string;
  task_model_hint?: TaskModelHint;
  task_result?: TaskResultBlock;
  task_result_errors?: string[];
  clarification_packet?: OperatorInteractionPacket;
  clarification_packet_path?: string;
  reflection_status?: 'done' | 'review' | 'blocked';
  reflection_path?: string;
  reflection_excerpt?: string;
  reflected_at?: string;
  ticket_state_after?: string;
  reviewer_status?: 'approved' | 'refuted' | 'blocked';
  reviewer_agent_id?: string;
  attempt_id?: string;
  runtime_id?: string;
  output_ref?: string;
  executor_agent_id?: string;
  provider?: string;
  model_id?: string;
  native_subagent?: Record<string, unknown>;
  review_attempt_id?: string;
  review_runtime_id?: string;
  review_output_ref?: string;
  review_provider?: string;
  reviewer_path?: string;
  reviewer_excerpt?: string;
  reviewer_notes?: string[];
  artifact_review_receipt?: string;
  drift_watchdog?: Record<string, unknown>;
  drift_watchdog_summary?: string;
  notes: string[];
}

export interface MissionWorkItemDispatchManifest {
  mission_id: string;
  mission_type?: string;
  tier: MissionState['tier'];
  tenant_slug?: string;
  created_at: string;
  updated_at: string;
  mode: MissionWorkItemDispatchMode;
  final_status: MissionWorkItemDispatchFinalStatus;
  work_item_count: number;
  records: MissionWorkItemDispatchRecord[];
  manifest_path?: string;
  event_path?: string;
}

interface WorkItemDispatchAdapters {
  routeA2A?: (envelope: A2AMessage) => Promise<A2AMessage>;
  delegateTask?: (
    instruction: string,
    context?: string,
    options?: ReasoningCallOptions
  ) => Promise<string>;
  /** Deterministic seam for tests that exercise the native subagent adapter. */
  nativeSubagentTask?: (
    instruction: string,
    context?: string,
    options?: ReasoningCallOptions
  ) => Promise<{ text: string; nativeSubagent?: Record<string, unknown> }>;
}

// Provider startup and context-pack construction can legitimately take more
// than two minutes. Keep the deadline bounded, but make the default suitable
// for implementation/review work; operators can still tune it per environment.
const DEFAULT_WORK_ITEM_RESPONSE_TIMEOUT_MS = 10 * 60 * 1000;

function resolveWorkItemResponseTimeoutMs(): number {
  const raw = process.env.KYBERION_WORKITEM_RESPONSE_TIMEOUT_MS?.trim();
  const value = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_WORK_ITEM_RESPONSE_TIMEOUT_MS;
}

class WorkItemResponseTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(
      `[WORKITEM_RESPONSE_TIMEOUT] no response within ${timeoutMs}ms; the work item was blocked without retrying the same request`
    );
    this.name = 'WorkItemResponseTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

type WorkItemDispatchReviewerVerdict = {
  approved: boolean;
  refuted: boolean;
  findings: string[];
  rationale?: string;
  raw_text: string;
  parsed?: Record<string, unknown>;
};

function dispatchRoot(missionPath: string): string {
  return nodePath.join(missionPath, 'evidence');
}

function dispatchEventPath(missionPath: string): string {
  return nodePath.join(missionPath, 'coordination', 'events', 'workitem-dispatch.jsonl');
}

function manifestPath(missionPath: string): string {
  return nodePath.join(dispatchRoot(missionPath), 'workitem-dispatch-manifest.json');
}

function ticketRoot(missionPath: string): string {
  return nodePath.join(missionPath, 'coordination', 'tickets');
}

function ticketManifestPath(missionPath: string): string {
  return nodePath.join(ticketRoot(missionPath), 'dispatch-manifest.json');
}

function ticketReplyPath(missionPath: string, taskId: string): string {
  return nodePath.join(ticketRoot(missionPath), 'replies', `${taskId}.json`);
}

function missionNextTasksPath(missionPath: string): string {
  return nodePath.join(missionPath, 'NEXT_TASKS.json');
}

function resolveWorkItemExecutionSurface(
  item: WorkItem,
  purpose: 'implementation' | 'review' = 'implementation',
  defaultSurface?: MissionExecutionSurface
): MissionExecutionSurfaceDecision {
  const metadata = (item.metadata || {}) as Record<string, unknown>;
  const requestedKey = purpose === 'review' ? 'review_execution_surface' : 'execution_surface';
  const signalsKey =
    purpose === 'review' ? 'review_execution_surface_signals' : 'execution_surface_signals';
  const signals =
    metadata[signalsKey] && typeof metadata[signalsKey] === 'object'
      ? (metadata[signalsKey] as Record<string, unknown>)
      : undefined;
  return resolveMissionExecutionSurface({
    requested: metadata[requestedKey] ?? (signals ? undefined : defaultSurface),
    signals,
  });
}

interface WorkItemReviewPlannedTask extends Record<string, unknown> {
  task_id?: string;
  status?: string;
  assigned_to?: { role?: string; agent_id?: string };
  description?: string;
  deliverable?: string;
  target_path?: string;
  dependencies?: string[];
  acceptance_criteria?: string[];
  risk?: string;
  review_target?: string;
  last_result?: TaskResultBlock;
  reconciliation?: {
    evidence?: Array<{
      path?: string;
      kind?: string;
    }>;
  };
}

interface WorkItemArtifactReviewContext {
  reviewTaskId: string;
  reviewerTeamRole: 'reviewer' | 'qa';
  targetTaskId?: string;
  artifactAbsolutePath?: string;
  artifactPath?: string;
  artifactSha256?: string;
  artifactKind?: 'doc' | 'deck' | 'code' | 'media';
  profile?: ArtifactReviewerProfile;
  implementerAgentIds: string[];
  acceptanceCriteria: string[];
  reviewerAgentId?: string;
  blockingReason?: string;
}

type ResolvedWorkItemArtifactReviewContext = WorkItemArtifactReviewContext & {
  targetTaskId: string;
  artifactAbsolutePath: string;
  artifactPath: string;
  artifactSha256: string;
  artifactKind: 'doc' | 'deck' | 'code' | 'media';
  profile: ArtifactReviewerProfile;
  reviewerAgentId: string;
  blockingReason?: undefined;
};

function resolveWorkItemArtifactReviewContext(input: {
  missionPath: string;
  missionId: string;
  missionState: MissionState;
  item: WorkItem;
  teamRole?: string;
}): WorkItemArtifactReviewContext | null {
  const taskId = getWorkItemTaskId(input.item);
  if (!taskId || (input.teamRole !== 'reviewer' && input.teamRole !== 'qa')) return null;
  const reviewerTeamRole = input.teamRole;
  const tasks =
    readJsonFileFromDispatchIO<WorkItemReviewPlannedTask[]>(
      missionNextTasksPath(input.missionPath)
    ) || [];
  const reviewTask = tasks.find((task) => String(task.task_id || '') === taskId);
  const metadata = (input.item.metadata || {}) as Record<string, unknown>;
  const reviewTarget = String(reviewTask?.review_target || metadata.review_target || '').trim();
  const acceptanceCriteria = Array.isArray(reviewTask?.acceptance_criteria)
    ? reviewTask.acceptance_criteria.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];
  if (!reviewTarget) return null;
  const targetTask = tasks.find((task) => String(task.task_id || '') === reviewTarget);
  if (!targetTask) {
    return {
      reviewTaskId: taskId,
      reviewerTeamRole,
      targetTaskId: reviewTarget,
      implementerAgentIds: [],
      acceptanceCriteria,
      blockingReason: `review target ${reviewTarget} does not exist`,
    };
  }

  const diffPath = nodePath.join(input.missionPath, 'evidence', 'prs', reviewTarget, 'diff.patch');
  const resultArtifacts = (targetTask.last_result?.artifacts || [])
    .map((artifact) => String(artifact?.path || '').trim())
    .filter(Boolean);
  const reconciledArtifacts = (targetTask.reconciliation?.evidence || [])
    .filter((evidence) => evidence.kind === 'artifact')
    .map((evidence) => String(evidence.path || '').trim())
    .filter(Boolean);
  const candidates = [
    diffPath,
    ...resultArtifacts,
    ...reconciledArtifacts,
    String(targetTask.target_path || '').trim(),
    String(targetTask.deliverable || '').trim(),
  ].filter(Boolean);
  let artifactAbsolutePath: string | undefined;
  for (const candidate of candidates) {
    const possiblePaths = nodePath.isAbsolute(candidate)
      ? [candidate]
      : [nodePath.join(input.missionPath, candidate), pathResolver.rootResolve(candidate)];
    artifactAbsolutePath = possiblePaths.find(
      (possiblePath) => safeExistsSync(possiblePath) && safeStat(possiblePath).isFile()
    );
    if (artifactAbsolutePath) break;
  }
  if (!artifactAbsolutePath) {
    return {
      reviewTaskId: taskId,
      reviewerTeamRole,
      targetTaskId: reviewTarget,
      implementerAgentIds: [],
      acceptanceCriteria,
      blockingReason: `review target artifact is unavailable for ${reviewTarget}`,
    };
  }

  const artifactPath = pathResolver.toRepoRelative(artifactAbsolutePath);
  const artifactKind = inferArtifactReviewKind(artifactPath);
  const profile = resolveArtifactReviewerProfile({
    artifactKind,
    missionClass: input.missionState.mission_type,
    riskProfile: reviewTask?.risk || targetTask.risk || String(metadata.risk || ''),
  });
  const implementerRole = String(targetTask.assigned_to?.role || '').trim();
  const resolvedImplementer = implementerRole
    ? resolveMissionTeamReceiver({ missionId: input.missionId, teamRole: implementerRole })
        ?.agent_id
    : undefined;
  const implementerAgentIds = Array.from(
    new Set(
      [targetTask.assigned_to?.agent_id, resolvedImplementer].filter((agentId): agentId is string =>
        Boolean(agentId)
      )
    )
  );
  const reviewerAssignment = resolveMissionTeamReceiver({
    missionId: input.missionId,
    teamRole: input.teamRole,
    excludedAgentIds: implementerAgentIds,
    requiredCapabilities: profile.required_reviewer_capabilities,
  });
  const ticketAssignee = String(
    metadata.resolved_agent_id || input.item.assignee_peer_id || ''
  ).trim();
  const ticketAssigneeProfile = ticketAssignee
    ? loadAgentProfileIndex()[ticketAssignee]
    : undefined;
  const ticketAssigneeCapabilities = new Set(ticketAssigneeProfile?.capabilities || []);
  const eligibleTicketAssignee =
    ticketAssignee &&
    !implementerAgentIds.includes(ticketAssignee) &&
    profile.required_reviewer_capabilities.every((capability) =>
      ticketAssigneeCapabilities.has(capability)
    )
      ? ticketAssignee
      : undefined;
  const reviewerAgentId = reviewerAssignment?.agent_id || eligibleTicketAssignee;
  const blockingReason =
    implementerAgentIds.length === 0
      ? 'implementer identity is unavailable for independent review'
      : !reviewerAgentId
        ? `no independent reviewer satisfies capabilities: ${profile.required_reviewer_capabilities.join(', ')}`
        : implementerAgentIds.includes(reviewerAgentId)
          ? `reviewer ${reviewerAgentId} is also an implementer`
          : undefined;
  return {
    reviewTaskId: taskId,
    reviewerTeamRole,
    targetTaskId: reviewTarget,
    artifactAbsolutePath,
    artifactPath,
    artifactSha256: hashArtifactForReview(artifactAbsolutePath),
    artifactKind,
    profile,
    implementerAgentIds,
    acceptanceCriteria,
    reviewerAgentId,
    ...(blockingReason ? { blockingReason } : {}),
  };
}

function isResolvedArtifactReviewContext(
  context: WorkItemArtifactReviewContext | null
): context is ResolvedWorkItemArtifactReviewContext {
  return Boolean(
    context &&
    !context.blockingReason &&
    context.targetTaskId &&
    context.artifactAbsolutePath &&
    context.artifactPath &&
    context.artifactSha256 &&
    context.artifactKind &&
    context.profile &&
    context.reviewerAgentId
  );
}

function buildArtifactReviewPromptLines(context: ResolvedWorkItemArtifactReviewContext): string[] {
  return [
    '',
    'Artifact quality review mandate:',
    `- Artifact: ${context.artifactPath}`,
    `- Artifact SHA-256: ${context.artifactSha256}`,
    `- Specialist perspectives: ${context.profile.required_reviewer_roles.join(', ')}`,
    `- Independent from: ${context.implementerAgentIds.join(', ')}`,
    '- Try to falsify every acceptance criterion and inspect the artifact itself.',
    '- Put defects in task_result.review_findings using severity=must_fix|should_fix|nit, location, and instruction.',
    '- Use must_fix only for defects that block acceptance. An empty review_findings array means no defect was found.',
  ];
}

function normalizeArtifactReviewFindings(
  taskResult: TaskResultBlock | undefined,
  artifactPath: string
): Array<{
  severity: 'must_fix' | 'should_fix' | 'nit';
  location: string;
  instruction: string;
}> {
  const findings = Array.isArray(taskResult?.review_findings)
    ? taskResult.review_findings
        .map((finding) => {
          const severity = String(finding?.severity || '').trim();
          const location = String(finding?.location || '').trim();
          const instruction = String(finding?.instruction || '').trim();
          if (
            (severity !== 'must_fix' && severity !== 'should_fix' && severity !== 'nit') ||
            !location ||
            !instruction
          ) {
            return null;
          }
          return { severity, location, instruction };
        })
        .filter(
          (
            finding
          ): finding is {
            severity: 'must_fix' | 'should_fix' | 'nit';
            location: string;
            instruction: string;
          } => Boolean(finding)
        )
    : [];
  for (const gap of taskResult?.gaps || []) {
    findings.push({ severity: 'must_fix', location: artifactPath, instruction: gap });
  }
  return findings;
}

function persistWorkItemArtifactReviewReceipt(input: {
  missionPath: string;
  missionId: string;
  item: WorkItem;
  context: ResolvedWorkItemArtifactReviewContext;
  taskResult?: TaskResultBlock;
}): { relativePath: string; receipt: ArtifactReviewReceipt } {
  const findings = normalizeArtifactReviewFindings(input.taskResult, input.context.artifactPath);
  const reviewId = `${input.context.reviewTaskId}-${input.item.item_id}-v${input.item.version}`;
  const relativePath = `evidence/reviews/${reviewId}.json`;
  const receipt = buildArtifactReviewReceipt({
    reviewId,
    missionId: input.missionId,
    reviewTaskId: input.context.reviewTaskId,
    reviewTargetTaskId: input.context.targetTaskId,
    artifact: {
      path: input.context.artifactPath,
      sha256: input.context.artifactSha256,
      kind: input.context.artifactKind,
    },
    reviewerAgentId: input.context.reviewerAgentId,
    reviewerTeamRole: input.context.reviewerTeamRole,
    specialistRoles: input.context.profile.required_reviewer_roles,
    independentFrom: input.context.implementerAgentIds,
    findings: findings.map<ArtifactReviewFinding>((finding) => ({
      severity: finding.severity === 'must_fix' ? 'blocking' : 'suggestion',
      category: 'artifact_quality',
      description: finding.instruction,
      ...(finding.severity === 'must_fix' ? { required_action: finding.instruction } : {}),
      location: finding.location,
    })),
    acceptanceCriteria: input.context.acceptanceCriteria.length
      ? input.context.acceptanceCriteria
      : [`Review ${input.context.targetTaskId}`],
  });
  writeDispatchArtifact(
    nodePath.join(input.missionPath, relativePath),
    receipt as unknown as Record<string, unknown>
  );

  const taskPath = missionNextTasksPath(input.missionPath);
  const tasks = readJsonFileFromDispatchIO<Array<Record<string, unknown>>>(taskPath) || [];
  const index = tasks.findIndex(
    (task) => String(task.task_id || '') === input.context.reviewTaskId
  );
  if (index >= 0) {
    const task = tasks[index];
    const assignedTo =
      task.assigned_to && typeof task.assigned_to === 'object'
        ? (task.assigned_to as Record<string, unknown>)
        : {};
    tasks[index] = {
      ...task,
      assigned_to: { ...assignedTo, agent_id: input.context.reviewerAgentId },
      artifact_review_profile: {
        ...input.context.profile,
        artifact_path: input.context.artifactPath,
        artifact_sha256: input.context.artifactSha256,
        implementer_agent_ids: input.context.implementerAgentIds,
      },
      artifact_review_receipt: relativePath,
      review_findings: findings,
    };
    writeJsonFileFromDispatchIO(taskPath, tasks);
  }
  return { relativePath, receipt };
}

function readManifest(missionPath: string): MissionWorkItemDispatchManifest | null {
  const path = manifestPath(missionPath);
  if (!safeExistsSync(path)) return null;
  try {
    const parsed = readJsonFileFromDispatchIO<MissionWorkItemDispatchManifest>(path);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function getMissionLabel(item: WorkItem): string | undefined {
  return (item.labels || [])
    .find((label) => label.startsWith('mission:'))
    ?.slice('mission:'.length);
}

function getTeamRole(item: WorkItem): string | undefined {
  const label = (item.labels || []).find((entry) => entry.startsWith('team_role:'));
  if (label) return label.slice('team_role:'.length);
  const metadata = item.metadata as Record<string, unknown> | undefined;
  const teamRole = metadata?.team_role;
  return typeof teamRole === 'string' ? teamRole : undefined;
}

function getTaskDescription(item: WorkItem): string {
  return item.title || item.description || item.source_ref || item.item_id;
}

function getTaskModelHint(
  item: WorkItem,
  phaseKind: 'implement' | 'review' = 'implement'
): TaskModelHint {
  const metadata = (item.metadata || {}) as Record<string, unknown>;
  const risk = typeof metadata.risk === 'string' ? metadata.risk : undefined;
  const estimatedScope =
    typeof metadata.estimated_scope === 'string' ? metadata.estimated_scope : undefined;
  const modelId = typeof metadata.model_id === 'string' ? metadata.model_id : undefined;
  return resolveTaskModelHint({
    phase_kind: phaseKind,
    ...(risk ? { risk } : {}),
    ...(estimatedScope ? { estimated_scope: estimatedScope } : {}),
    ...(modelId ? { model_id: modelId } : {}),
  });
}

function isFastTierTaskModelHint(taskModelHint?: TaskModelHint): boolean {
  return taskModelHint?.execution_tier === 'fast' || taskModelHint?.tier === 'small';
}

function buildFastTierPromptAddendum(taskModelHint?: TaskModelHint): string[] {
  if (!isFastTierTaskModelHint(taskModelHint)) return [];
  return [
    'Fast-tier enforcement:',
    '- Restate each acceptance criterion explicitly in the response.',
    '- Provide a non-empty verification_done list that maps to those criteria.',
    '- Include at least one artifact path when files changed or an artifact is expected.',
    '- Keep the result minimal, but do not omit required schema fields.',
  ];
}

function isIndependentReviewRequired(item: WorkItem): boolean {
  const metadata = (item.metadata || {}) as Record<string, unknown>;
  return metadata.risk === 'approval_required' || metadata.risk === 'high_stakes';
}

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  const content = fenced ? fenced[1].trim() : trimmed;
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return content.slice(start, end + 1);
}

function parseIndependentReviewerVerdict(text: string): WorkItemDispatchReviewerVerdict {
  const rawText = String(text || '');
  const json = extractJsonObject(rawText);
  const findings: string[] = [];
  let approved = false;
  let refuted = false;
  let rationale: string | undefined;
  let parsed: Record<string, unknown> | undefined;

  if (json) {
    try {
      const candidate = JSON.parse(json) as Record<string, unknown>;
      parsed = candidate;
      approved = candidate.approved === true || candidate.approved === 'true';
      refuted = candidate.refuted === true || candidate.refuted === 'true';
      rationale = typeof candidate.rationale === 'string' ? candidate.rationale.trim() : undefined;
      const candidateFindings = Array.isArray(candidate.findings)
        ? candidate.findings.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
      findings.push(...candidateFindings);
    } catch {
      // fall through to text heuristics
    }
  }

  if (!approved && !refuted) {
    const lowered = rawText.toLowerCase();
    approved = /\bapproved\b/.test(lowered) && !/\b(reject|refut|block)\b/.test(lowered);
    refuted = /\b(refut|reject|block)\b/.test(lowered);
  }

  return {
    approved,
    refuted,
    findings,
    ...(rationale ? { rationale } : {}),
    raw_text: rawText,
    ...(parsed ? { parsed } : {}),
  };
}

function buildIndependentReviewerPrompt(input: {
  missionId: string;
  item: WorkItem;
  teamRole?: string;
  assigneePeerId?: string;
  contextPackSummary: string;
  taskModelHint: TaskModelHint;
  executionResponse: string;
}): string {
  const metadata = (input.item.metadata || {}) as Record<string, unknown>;
  const acceptanceCriteria = Array.isArray(metadata.acceptance_criteria)
    ? metadata.acceptance_criteria
        .map((criterion) => String(criterion || '').trim())
        .filter(Boolean)
    : [];
  const lines = [
    `You are an independent reviewer for mission ${input.missionId}.`,
    'Your job is to refute the implementation if it misses acceptance criteria, leaks scope, or fails to justify the result.',
    'Return JSON only: {"approved": boolean, "refuted": boolean, "findings": string[], "rationale": string}.',
    '',
    `Task: ${input.item.title}`,
    `Description: ${input.item.description}`,
    input.teamRole ? `Implementer role: ${input.teamRole}` : '',
    input.assigneePeerId ? `Implementer agent: ${input.assigneePeerId}` : '',
    input.taskModelHint
      ? `Reviewer model hint: ${input.taskModelHint.model_id} (${input.taskModelHint.tier}/${input.taskModelHint.effort})`
      : '',
    acceptanceCriteria.length > 0
      ? `Acceptance criteria:\n- ${acceptanceCriteria.join('\n- ')}`
      : '',
    ...buildFastTierPromptAddendum(input.taskModelHint).map((line) => `Reviewer note: ${line}`),
    '',
    ...buildWorkingPrinciplesLines('reviewer'),
    'Mission context:',
    input.contextPackSummary,
    '',
    'Implementation response to review:',
    input.executionResponse.trim(),
  ].filter(Boolean);
  return lines.join('\n');
}

async function runIndependentReviewerReview(input: {
  missionPath: string;
  missionId: string;
  missionState: MissionState;
  item: WorkItem;
  teamRole?: string;
  assigneePeerId?: string;
  executionResponse: string;
  taskModelHint: TaskModelHint;
  reviewExecutionSurface?: MissionExecutionSurface;
  adapters: WorkItemDispatchAdapters;
}): Promise<{
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
}> {
  const missionState = {
    mission_id: input.missionId,
    tier: 'public' as const,
    status: 'active',
    assigned_persona: 'worker',
    git: { branch: 'review', start_commit: '', latest_commit: '', checkpoints: [] },
    history: [],
  };
  const contextPack = await resolveMissionContextPack({
    missionId: input.missionId,
    tier: input.missionState.tier,
    tenantSlug: input.missionState.tenant_slug,
    recipientKind: 'reviewer',
    teamRole: 'reviewer',
    assigneePeerId: undefined,
    workItemId: input.item.item_id,
    workItem: input.item,
    projectId: input.missionState.relationships?.project?.project_id,
    trackId: input.missionState.relationships?.track?.track_id,
    missionState: input.missionState,
  });
  if (!contextPack) {
    throw new Error(`Unable to resolve reviewer context pack for ${input.missionId}`);
  }
  const contextPackPath = saveMissionContextPack(input.missionPath, contextPack);
  const reviewerTaskModelHint = getTaskModelHint(input.item, 'review');
  const reviewerPrompt = [
    `Cognitive route: reviewer validation for ${input.item.item_id}`,
    '',
    renderMissionContextPack(contextPack),
    '',
    buildIndependentReviewerPrompt({
      missionId: input.missionId,
      item: input.item,
      teamRole: input.teamRole,
      assigneePeerId: input.assigneePeerId,
      contextPackSummary: contextPack.summary,
      taskModelHint: reviewerTaskModelHint,
      executionResponse: input.executionResponse,
    }),
  ].join('\n');

  const metadata = (input.item.metadata || {}) as Record<string, unknown>;
  const configuredReviewerAgentId =
    typeof metadata.reviewer_agent_id === 'string' ? metadata.reviewer_agent_id : undefined;
  const reviewerAssignment = resolveMissionTeamReceiver({
    missionId: input.missionId,
    teamRole: 'reviewer',
    excludedAgentIds: input.assigneePeerId ? [input.assigneePeerId] : [],
  });
  const reviewerAgentId =
    configuredReviewerAgentId && configuredReviewerAgentId !== input.assigneePeerId
      ? configuredReviewerAgentId
      : reviewerAssignment?.agent_id;
  const reviewSurfaceDecision = resolveWorkItemExecutionSurface(
    input.item,
    'review',
    input.reviewExecutionSurface
  );
  const hasReviewSurfaceConfiguration =
    reviewSurfaceDecision.selected_by === 'explicit' ||
    (metadata.review_execution_surface_signals !== null &&
      typeof metadata.review_execution_surface_signals === 'object');
  const reviewerResponse = await runWithWorkItemResponseDeadline((signal) =>
    routeToAgentOrSubagent({
      missionId: input.missionId,
      item: input.item,
      teamRole: 'reviewer',
      assigneePeerId: reviewerAgentId,
      prompt: reviewerPrompt,
      taskModelHint: reviewerTaskModelHint,
      mode: hasReviewSurfaceConfiguration ? 'auto' : 'subagent',
      surfacePurpose: 'review',
      securityScope: contextPack.security_scope,
      defaultExecutionSurface: input.reviewExecutionSurface,
      adapters: input.adapters,
      signal,
      contextMode: 'fresh',
    })
  );
  const reviewerResponseText = reviewerResponse.responseText;
  const verdict = parseIndependentReviewerVerdict(reviewerResponseText);
  const reviewerPath = nodePath.join(
    dispatchRoot(input.missionPath),
    `workitem-review-${input.item.item_id}.json`
  );
  const reviewerExcerpt = reviewerResponseText.slice(0, 800);
  writeDispatchArtifact(reviewerPath, {
    mission_id: input.missionId,
    item_id: input.item.item_id,
    team_role: input.teamRole,
    assignee_peer_id: input.assigneePeerId,
    context_pack_id: contextPack.context_pack_id,
    context_pack_path: contextPackPath,
    task_model_hint: reviewerTaskModelHint,
    prompt: reviewerPrompt,
    response_text: reviewerResponseText,
    response_excerpt: reviewerExcerpt,
    verdict,
    execution_surface: reviewSurfaceDecision.surface,
    execution_surface_used: reviewerResponse.executionSurfaceUsed,
    reviewer_agent_id: reviewerAgentId,
    attempt_id: reviewerResponse.attemptId,
    runtime_id: reviewerResponse.runtimeId,
    output_ref: reviewerResponse.outputRef,
    provider: reviewerResponse.provider,
    written_at: new Date().toISOString(),
  });

  return {
    verdict,
    reviewerPrompt,
    reviewerPath,
    reviewerExcerpt,
    reviewerTaskModelHint,
    reviewerContextPackId: contextPack.context_pack_id,
    reviewerContextPackPath: contextPackPath,
    reviewerExecutionSurface: reviewSurfaceDecision.surface,
    reviewerExecutionSurfaceUsed: reviewerResponse.executionSurfaceUsed,
    reviewerAgentId,
    reviewerAttemptId: reviewerResponse.attemptId,
    reviewerRuntimeId: reviewerResponse.runtimeId,
    reviewerOutputRef: reviewerResponse.outputRef,
    reviewerProvider: reviewerResponse.provider,
  };
}

/**
 * Dog-food fixes (2026-07-08):
 *  - File-producing tasks need the governed agentic tool path; the text-only
 *    default made implementers CLAIM file edits without writing anything.
 *    Auto-enable KYBERION_CLAUDE_AGENT_TOOLS for the call when the work item
 *    expects file output (explicit '0' still wins as an operator opt-out).
 *  - Transient CLI hiccups returned empty responses that went straight to
 *    blocked; retry once before giving up.
 */
function workItemExpectsFiles(item: WorkItem): boolean {
  const metadata = (item.metadata || {}) as Record<string, unknown>;
  return Boolean(
    metadata.deliverable ||
    metadata.target_path ||
    String(metadata.expected_output_format || '') === 'files'
  );
}

async function delegateSubagentTask(input: {
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
}): Promise<WorkItemExecutionOutcome> {
  const delegationContext = input.purpose === 'review' ? 'workitem-review' : 'workitem';
  const delegationIdentity = input.assigneePeerId || input.item.assignee_peer_id;
  const delegationContextRef = delegationIdentity
    ? `${delegationContext}:${input.item.item_id}:agent=${delegationIdentity}`
    : `${delegationContext}:${input.item.item_id}`;
  const missionId = String(
    input.item.metadata?.mission_id || input.item.project_id || input.item.item_id
  ).trim();
  const backend = getReasoningBackend();
  const nativeDispatcher = new HarnessSubagentDispatcher();
  const nativeAdopter = backend.getNativeSubagentAdopter?.() ?? null;

  const executeText = async (): Promise<AgentExecutionReceipt> => {
    const startedAt = new Date().toISOString();
    try {
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
        return nativeDispatcher.dispatch(input.prompt, delegationContextRef, backend, {
          ...input.routingOptions,
          context_mode: input.contextMode,
          profile: input.purpose === 'review' ? 'explorer' : 'implementer',
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
        provider: backend.name,
        ...(input.routingOptions.model ? { model_id: String(input.routingOptions.model) } : {}),
        ...(nativeAdopter?.getInfo?.()
          ? { native_subagent: nativeAdopter.getInfo() || undefined }
          : nativeSubagent
            ? { native_subagent: nativeSubagent }
            : {}),
        status: 'succeeded',
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        output_ref: `${input.item.item_id}:result`,
        output,
      };
    } catch (error) {
      return {
        execution_kind: 'agent_delegation',
        task_id: getWorkItemTaskId(input.item) || input.item.item_id,
        agent_id: delegationIdentity || `task-agent-${input.item.item_id}`,
        provider: backend.name,
        ...(input.routingOptions.model ? { model_id: String(input.routingOptions.model) } : {}),
        status: 'failed',
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const wantsFiles = workItemExpectsFiles(input.item);
  const previousTools = process.env.KYBERION_CLAUDE_AGENT_TOOLS;
  if (wantsFiles && previousTools === undefined) {
    process.env.KYBERION_CLAUDE_AGENT_TOOLS = '1';
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
        success_status:
          input.purpose === 'review' || isIndependentReviewRequired(input.item) ? 'review' : 'done',
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
      delete process.env.KYBERION_CLAUDE_AGENT_TOOLS;
    }
  }
}

async function runWithWorkItemResponseDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const timeoutMs = resolveWorkItemResponseTimeoutMs();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new WorkItemResponseTimeoutError(timeoutMs));
  }, timeoutMs);
  timer.unref?.();
  try {
    try {
      return await run(controller.signal);
    } catch (error) {
      if (timedOut) throw new WorkItemResponseTimeoutError(timeoutMs);
      throw error;
    }
  } finally {
    clearTimeout(timer);
  }
}

function getWorkItemTaskId(item: WorkItem): string | undefined {
  const metadata = (item.metadata || {}) as Record<string, unknown>;
  const taskId = metadata.task_id;
  if (typeof taskId === 'string' && taskId.trim()) return taskId.trim();
  const sourceRef = String(item.source_ref || '').trim();
  const match = sourceRef.match(/^mission:[^:]+:(.+)$/u);
  return match?.[1] || undefined;
}

function extractGitHubIssueNumber(source: unknown): number | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const record = source as Record<string, unknown>;
  const raw = record.issue_number ?? record.number ?? record.id;
  const numeric = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function extractGitHubRepoInfo(source: unknown): {
  owner?: string;
  repo?: string;
  repositoryUrl?: string;
} {
  if (!source || typeof source !== 'object') return {};
  const record = source as Record<string, unknown>;
  const repositoryUrl =
    typeof record.repository_url === 'string' ? record.repository_url : undefined;
  const owner = typeof record.owner === 'string' ? record.owner : undefined;
  const repo = typeof record.repo === 'string' ? record.repo : undefined;
  if (owner && repo) return { owner, repo, repositoryUrl };
  if (repositoryUrl) {
    const match = repositoryUrl.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/u);
    if (match) {
      return { owner: match[1], repo: match[2].replace(/\.git$/u, ''), repositoryUrl };
    }
  }
  return { repositoryUrl };
}

function extractJiraIssueKey(source: unknown): string | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const record = source as Record<string, unknown>;
  const raw = record.issue_key ?? record.key ?? record.id;
  const value = typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim();
  return value || undefined;
}

function extractJiraProjectInfo(source: unknown): { domain?: string; projectKey?: string } {
  if (!source || typeof source !== 'object') return {};
  const record = source as Record<string, unknown>;
  return {
    domain: typeof record.domain === 'string' ? record.domain : undefined,
    projectKey: typeof record.projectKey === 'string' ? record.projectKey : undefined,
  };
}

function buildTicketReflectionBody(input: {
  missionId: string;
  item: WorkItem;
  teamRole?: string;
  assigneePeerId?: string;
  contextPackId?: string;
  contextPackPath?: string;
  cognitiveRouteSummary?: string;
  driftWatchdogSummary?: string;
  taskResult?: TaskResultBlock;
  clarificationPacket?: OperatorInteractionPacket;
  clarificationPacketPath?: string;
  ticketState: 'done' | 'review' | 'blocked';
  responseText: string;
  responsePath: string;
  responseExcerpt: string;
  notes: string[];
}): string {
  const lines = [
    `Mission: ${input.missionId}`,
    `Work item: ${input.item.item_id}`,
    input.teamRole ? `Team role: ${input.teamRole}` : '',
    input.assigneePeerId ? `Assignee agent: ${input.assigneePeerId}` : '',
    input.contextPackId ? `Context pack: ${input.contextPackId}` : '',
    input.contextPackPath ? `Context pack path: ${input.contextPackPath}` : '',
    input.cognitiveRouteSummary ? `Cognitive route: ${input.cognitiveRouteSummary}` : '',
    input.driftWatchdogSummary ? `Drift watchdog: ${input.driftWatchdogSummary}` : '',
    input.taskResult ? `Task result: ${input.taskResult.summary}` : '',
    input.clarificationPacket ? `Clarification packet: ${input.clarificationPacket.headline}` : '',
    input.clarificationPacketPath
      ? `Clarification packet path: ${input.clarificationPacketPath}`
      : '',
    `Result state: ${input.ticketState}`,
    `Response path: ${input.responsePath}`,
    '',
    input.responseText.trim() ? input.responseText.trim() : input.responseExcerpt,
    ...input.notes.map((note) => `- ${note}`),
  ].filter(Boolean);
  return lines.join('\n');
}

function deriveTicketState(
  finalStatus: MissionWorkItemDispatchFinalStatus,
  notes: string[]
): 'done' | 'review' | 'blocked' {
  if (finalStatus === 'blocked' || notes.some((note) => /block/i.test(note))) return 'blocked';
  return finalStatus === 'done' ? 'done' : 'review';
}

function normalizeAcceptanceText(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function evaluateAcceptanceCriteriaEvidence(input: {
  criteria: string[];
  responseText: string;
  responseExcerpt: string;
  taskResult?: TaskResultBlock;
}): { satisfied: boolean; missing: string[]; structured: boolean } {
  const criteria = Array.from(
    new Set(input.criteria.map((criterion) => normalizeAcceptanceText(criterion)).filter(Boolean))
  );
  if (criteria.length === 0) {
    return { satisfied: true, missing: [], structured: false };
  }

  const evidenceParts = [input.responseText, input.responseExcerpt];
  const evidence = normalizeAcceptanceText(evidenceParts.join('\n'));
  const structuredEvidence = new Map(
    (input.taskResult?.acceptance_evidence || []).map((entry) => [
      normalizeAcceptanceText(entry.criterion),
      entry,
    ])
  );
  const missing = criteria.filter((criterion) => {
    const entry = structuredEvidence.get(criterion);
    if (entry) return entry.status !== 'passed' || !entry.evidence.trim();
    return !evidence.includes(criterion);
  });
  return {
    satisfied: missing.length === 0,
    missing,
    structured:
      missing.length === 0 && criteria.some((criterion) => structuredEvidence.has(criterion)),
  };
}

function updateTicketManifest(
  missionPath: string,
  taskId: string,
  updater: (record: Record<string, unknown>, ticketState: 'done' | 'review' | 'blocked') => void,
  ticketState: 'done' | 'review' | 'blocked'
): void {
  const manifestFile = ticketManifestPath(missionPath);
  const manifest = readJsonFileFromDispatchIO<{ records?: Array<Record<string, unknown>> }>(
    manifestFile
  );
  if (!manifest?.records) return;
  const index = manifest.records.findIndex((record) => String(record.task_id || '') === taskId);
  if (index < 0) return;
  updater(manifest.records[index], ticketState);
  writeJsonFileFromDispatchIO(manifestFile, manifest);
}

const TICKET_STATE_TO_TASK_STATUS: Record<string, string> = {
  // Keep NEXT_TASKS (what the finish exit gate reads) in lockstep with the
  // ticket outcome — the dog-food run required hand-syncing statuses before
  // finish because dispatch only annotated ticket_dispatch metadata.
  done: 'completed',
  review: 'reviewed',
  blocked: 'blocked',
};

const TASK_STATUS_RANK: Record<string, number> = {
  planned: 0,
  rework: 1,
  blocked: 2,
  review: 3,
  reviewed: 3,
  done: 4,
  completed: 4,
  accepted: 5,
};

function updateNextTasksReflection(
  missionPath: string,
  taskId: string,
  payload: Record<string, unknown>,
  ticketState?: string
): void {
  const nextTasksFile = missionNextTasksPath(missionPath);
  const tasks = readJsonFileFromDispatchIO<Array<Record<string, unknown>>>(nextTasksFile);
  if (!tasks) return;
  const index = tasks.findIndex((task) => String(task.task_id || '') === taskId);
  if (index < 0) return;
  const current = tasks[index];
  const mappedStatus = ticketState ? TICKET_STATE_TO_TASK_STATUS[ticketState] : undefined;
  const currentStatus = String(current.status || 'planned').toLowerCase();
  const shouldAdvance =
    mappedStatus !== undefined &&
    (TASK_STATUS_RANK[mappedStatus] ?? 0) > (TASK_STATUS_RANK[currentStatus] ?? 0);
  tasks[index] = {
    ...current,
    ...(shouldAdvance ? { status: mappedStatus } : {}),
    ticket_dispatch: {
      ...(current.ticket_dispatch as Record<string, unknown> | undefined),
      ...payload,
    },
  };
  writeJsonFileFromDispatchIO(nextTasksFile, tasks);
}

function appendComment(
  existing: unknown,
  comment: Record<string, unknown>
): Record<string, unknown>[] {
  const comments = Array.isArray(existing)
    ? (existing.filter((entry) => entry && typeof entry === 'object') as Record<string, unknown>[])
    : [];
  comments.push(comment);
  return comments;
}

async function reflectTicketOutcome(input: {
  missionPath: string;
  missionId: string;
  item: WorkItem;
  teamRole?: string;
  assigneePeerId?: string;
  contextPackId?: string;
  contextPackPath?: string;
  cognitiveRoute?: CognitiveRouteDecision;
  driftWatchdogSummary?: string;
  finalStatus: MissionWorkItemDispatchFinalStatus;
  responseText: string;
  responsePath: string;
  responseExcerpt: string;
  notes: string[];
  taskResult?: TaskResultBlock;
  clarificationPacket?: OperatorInteractionPacket;
  clarificationPacketPath?: string;
  reviewerStatus?: 'approved' | 'refuted' | 'blocked';
  reviewerPath?: string;
  reviewerExcerpt?: string;
  artifactReviewReceipt?: {
    relativePath: string;
    receipt: ArtifactReviewReceipt;
  };
  executionMode: 'agent' | 'subagent';
  taskModelHint?: TaskModelHint;
}): Promise<{
  ticketState: 'done' | 'review' | 'blocked';
  reflectionPath: string;
  notes: string[];
}> {
  const taskId = getWorkItemTaskId(input.item);
  const notes = [...input.notes];
  const metadata = (input.item.metadata || {}) as Record<string, unknown>;
  const acceptanceCriteria = Array.isArray(metadata.acceptance_criteria)
    ? metadata.acceptance_criteria
        .map((criterion) => String(criterion || '').trim())
        .filter(Boolean)
    : [];
  const acceptanceCheck = evaluateAcceptanceCriteriaEvidence({
    criteria: acceptanceCriteria,
    responseText: input.responseText,
    responseExcerpt: input.responseExcerpt,
    taskResult: input.taskResult,
  });
  const approvedArtifactReview = input.artifactReviewReceipt?.receipt.verdict === 'approved';
  const acceptanceSatisfied = acceptanceCheck.satisfied || approvedArtifactReview;
  const acceptanceMissing = approvedArtifactReview ? [] : acceptanceCheck.missing;
  const fastTierVerificationSatisfied =
    !isFastTierTaskModelHint(input.taskModelHint) ||
    ((input.taskResult?.verification_done?.length || 0) > 0 &&
      ((input.taskResult?.artifacts?.length || 0) > 0 ||
        (input.taskResult?.needs?.length || 0) > 0));
  if (!fastTierVerificationSatisfied) {
    notes.push('fast-tier verification incomplete');
  }
  if (approvedArtifactReview && !acceptanceCheck.satisfied) {
    notes.push(
      `acceptance criteria satisfied by approved artifact review receipt: ${input.artifactReviewReceipt?.relativePath}`
    );
  } else if (acceptanceCheck.structured) {
    notes.push('acceptance criteria satisfied by task_result.acceptance_evidence');
  } else if (!acceptanceSatisfied) {
    notes.push(`acceptance criteria not met: ${acceptanceMissing.join('; ')}`);
  }
  if (!taskId) {
    notes.push('missing task_id for ticket reflection');
    return {
      ticketState: deriveTicketState(
        acceptanceSatisfied ? input.finalStatus : input.responseText.trim() ? 'review' : 'blocked',
        notes
      ),
      reflectionPath: '',
      notes,
    };
  }

  const effectiveFinalStatus =
    acceptanceSatisfied && fastTierVerificationSatisfied
      ? input.finalStatus
      : input.responseText.trim()
        ? 'review'
        : 'blocked';
  const ticketState = deriveTicketState(effectiveFinalStatus, notes);
  const reflectionPath = ticketReplyPath(input.missionPath, taskId);
  const manifest = readJsonFileFromDispatchIO<{ records?: Array<Record<string, unknown>> }>(
    ticketManifestPath(input.missionPath)
  );
  const manifestRecord = manifest?.records?.find(
    (record) => String(record.task_id || '') === taskId
  );
  const liveResults = (manifestRecord?.live_results as Record<string, unknown> | undefined) || {};
  const cognitiveRouteSummary = input.cognitiveRoute
    ? formatCognitiveRouteDecision(input.cognitiveRoute)
    : undefined;
  const reflectionBody = buildTicketReflectionBody({
    missionId: input.missionId,
    item: input.item,
    teamRole: input.teamRole,
    assigneePeerId: input.assigneePeerId,
    contextPackId: input.contextPackId,
    contextPackPath: input.contextPackPath,
    cognitiveRouteSummary,
    driftWatchdogSummary: input.driftWatchdogSummary,
    ticketState,
    responseText: input.responseText,
    responsePath: input.responsePath,
    responseExcerpt: input.responseExcerpt,
    taskResult: input.taskResult,
    clarificationPacket: input.clarificationPacket,
    clarificationPacketPath: input.clarificationPacketPath,
    notes,
  });
  const reflectionPayload = {
    mission_id: input.missionId,
    task_id: taskId,
    work_item_id: input.item.item_id,
    team_role: input.teamRole,
    assignee_peer_id: input.assigneePeerId,
    context_pack_id: input.contextPackId,
    context_pack_path: input.contextPackPath,
    cognitive_route: input.cognitiveRoute,
    cognitive_route_summary: cognitiveRouteSummary,
    drift_watchdog_summary: input.driftWatchdogSummary,
    acceptance_criteria: acceptanceCriteria,
    acceptance_criteria_satisfied: acceptanceSatisfied,
    acceptance_criteria_missing: acceptanceMissing,
    clarification_packet: input.clarificationPacket,
    clarification_packet_path: input.clarificationPacketPath,
    execution_mode: input.executionMode,
    ticket_state: ticketState,
    response_path: input.responsePath,
    response_excerpt: input.responseExcerpt,
    notes,
    body: reflectionBody,
    reflected_at: new Date().toISOString(),
  };
  writeDispatchArtifact(reflectionPath, reflectionPayload);

  updateTicketManifest(
    input.missionPath,
    taskId,
    (record, state) => {
      record.reflection_status = ticketState;
      record.reflection_path = reflectionPath;
      record.reflection_excerpt = input.responseExcerpt;
      record.reflected_at = new Date().toISOString();
      record.ticket_state_after = state;
      record.notes = Array.from(
        new Set([...(Array.isArray(record.notes) ? (record.notes as string[]) : []), ...notes])
      );
    },
    ticketState
  );

  updateNextTasksReflection(
    input.missionPath,
    taskId,
    {
      reflected_at: new Date().toISOString(),
      ticket_state: ticketState,
      ticket_reply_path: reflectionPath,
      response_path: input.responsePath,
      response_excerpt: input.responseExcerpt,
      context_pack_id: input.contextPackId,
      context_pack_path: input.contextPackPath,
      cognitive_route: cognitiveRouteSummary,
      drift_watchdog_summary: input.driftWatchdogSummary,
      acceptance_criteria: acceptanceCriteria,
      acceptance_criteria_satisfied: acceptanceSatisfied,
      acceptance_criteria_missing: acceptanceMissing,
      reviewer_status: input.reviewerStatus,
      reviewer_path: input.reviewerPath,
      reviewer_excerpt: input.reviewerExcerpt,
      clarification_packet_path: input.clarificationPacketPath,
      needs_input: Boolean(input.clarificationPacket),
      result_status: ticketState,
      review_required: ticketState === 'review',
      blocked: ticketState === 'blocked',
      work_item_status_after: input.finalStatus,
    },
    ticketState
  );

  // AL-03: `done` is where this task contract's completion is finalized
  // (ticket manifest + NEXT_TASKS both advanced above) — GC the task's
  // disposable scoped artifacts (cache/tmp classes; evidence untouched).
  // Best-effort: task GC must never fail the reflection that already
  // recorded the outcome (closeTaskArtifacts itself never throws).
  if (ticketState === 'done') {
    const taskGc = closeTaskArtifacts(input.missionId, taskId, { missionDir: input.missionPath });
    if (taskGc.status === 'error') {
      notes.push(`task artifact GC skipped: ${taskGc.error || 'unknown error'}`);
    }
  }

  // NI-04: task completion ('done') and failure ('blocked') auto-revoke the
  // short-lived task grants issued at dispatch — no standing authority
  // survives the task contract. A 'review' outcome keeps the contract open,
  // so its grants are left to lazy expiry instead. Best-effort next to
  // AL-03's GC above: revocation must never fail the reflection that already
  // recorded the outcome.
  if (ticketState === 'done' || ticketState === 'blocked') {
    revokeGrantsForTaskBestEffort(input.missionId, taskId, `task ${ticketState}`);
  }

  const githubPath = nodePath.join(ticketRoot(input.missionPath), 'github', `${taskId}.json`);
  if (safeExistsSync(githubPath)) {
    const githubIssue = readJsonFileFromDispatchIO<Record<string, unknown>>(githubPath);
    if (githubIssue) {
      const issueNumber =
        extractGitHubIssueNumber(liveResults.github) || extractGitHubIssueNumber(githubIssue);
      const repoInfo = extractGitHubRepoInfo(githubIssue);
      githubIssue.state = ticketState === 'done' ? 'closed' : 'open';
      githubIssue.state_reason = ticketState === 'done' ? 'completed' : 'reopened';
      githubIssue.comments = appendComment(githubIssue.comments, {
        body: reflectionBody,
        created_at: new Date().toISOString(),
        state: ticketState,
        source: 'workitem-dispatch',
      });
      githubIssue.last_reflection = {
        ticket_state: ticketState,
        reflected_at: new Date().toISOString(),
        response_path: input.responsePath,
        response_excerpt: input.responseExcerpt,
        cognitive_route: cognitiveRouteSummary,
        drift_watchdog_summary: input.driftWatchdogSummary,
      };
      writeJsonFileFromDispatchIO(githubPath, githubIssue);

      if (repoInfo.owner && repoInfo.repo && issueNumber) {
        try {
          await executeServicePreset(
            'github',
            'add_comment',
            {
              owner: repoInfo.owner,
              repo: repoInfo.repo,
              issue_number: issueNumber,
              body: reflectionBody,
            },
            'secret-guard'
          );
          if (ticketState === 'done') {
            await executeServicePreset(
              'github',
              'close_issue',
              {
                owner: repoInfo.owner,
                repo: repoInfo.repo,
                issue_number: issueNumber,
              },
              'secret-guard'
            );
          }
        } catch (error: any) {
          notes.push(`github reflection failed: ${error?.message || error}`);
        }
      }
    }
  }

  const jiraPath = nodePath.join(ticketRoot(input.missionPath), 'jira', `${taskId}.json`);
  if (safeExistsSync(jiraPath)) {
    const jiraIssue = readJsonFileFromDispatchIO<Record<string, unknown>>(jiraPath);
    if (jiraIssue) {
      const issueKey = extractJiraIssueKey(liveResults.jira) || extractJiraIssueKey(jiraIssue);
      const jiraInfo = {
        ...extractJiraProjectInfo(jiraIssue),
        ...extractJiraProjectInfo(liveResults.jira),
      };
      const fields =
        jiraIssue.fields && typeof jiraIssue.fields === 'object'
          ? (jiraIssue.fields as Record<string, unknown>)
          : {};
      fields.status = {
        name: ticketState === 'done' ? 'Done' : ticketState === 'review' ? 'In Review' : 'Blocked',
      };
      jiraIssue.fields = fields;
      jiraIssue.comments = appendComment(jiraIssue.comments, {
        body: reflectionBody,
        created_at: new Date().toISOString(),
        state: ticketState,
        source: 'workitem-dispatch',
      });
      jiraIssue.last_reflection = {
        ticket_state: ticketState,
        reflected_at: new Date().toISOString(),
        response_path: input.responsePath,
        response_excerpt: input.responseExcerpt,
        cognitive_route: cognitiveRouteSummary,
        drift_watchdog_summary: input.driftWatchdogSummary,
      };
      writeJsonFileFromDispatchIO(jiraPath, jiraIssue);

      if (issueKey && jiraInfo.domain) {
        try {
          await executeServicePreset(
            'jira',
            'add_comment',
            {
              issue_key: issueKey,
              body: reflectionBody,
            },
            'secret-guard'
          );
          if (ticketState === 'done') {
            const transitions = await executeServicePreset(
              'jira',
              'get_transitions',
              {
                issue_key: issueKey,
              },
              'secret-guard'
            );
            const transitionList = Array.isArray((transitions as any)?.transitions)
              ? (transitions as any).transitions
              : Array.isArray((transitions as any)?.body?.transitions)
                ? (transitions as any).body.transitions
                : [];
            const match = transitionList.find((transition: any) => {
              const name = String(transition?.name || transition?.to?.name || '')
                .trim()
                .toLowerCase();
              return ['done', 'closed', 'resolved', 'complete', 'completed'].includes(name);
            });
            if (match?.id) {
              await executeServicePreset(
                'jira',
                'transition_issue',
                {
                  issue_key: issueKey,
                  transition_id: String(match.id),
                },
                'secret-guard'
              );
            } else {
              notes.push(`jira reflection transition skipped: no done transition for ${issueKey}`);
            }
          }
        } catch (error: any) {
          notes.push(`jira reflection failed: ${error?.message || error}`);
        }
      }
    }
  }

  return {
    ticketState,
    reflectionPath,
    notes,
  };
}

function validateWorkItemGranularity(
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

function resolveWorkItemProjectId(state: MissionState): string {
  return String(state.relationships?.project?.project_id || state.mission_id || '').trim();
}

function areMissionTaskDependenciesSatisfied(state: MissionState, item: WorkItem): boolean {
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
  const projectId = resolveWorkItemProjectId(state);
  const missionId = state.mission_id.toUpperCase();
  const canonicalStatusById = new Map<string, WorkItemStatus>();
  for (const candidate of readCanonicalWorkGraph(projectId).items) {
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

function selectWorkItems(state: MissionState, options: MissionWorkItemDispatchOptions): WorkItem[] {
  const missionId = state.mission_id.toUpperCase();
  const projectId = resolveWorkItemProjectId(state);
  const labels = [`mission:${missionId}`];
  const statuses =
    options.statuses && options.statuses.length > 0
      ? options.statuses
      : (['ready', 'backlog'] as WorkItemStatus[]);
  const sources =
    options.sources && options.sources.length > 0
      ? options.sources
      : (['local'] as WorkItemSource[]);
  const canonical = readCanonicalWorkGraph(projectId);
  const allMissionItems = canonical.items
    .filter((item) => sources.includes(item.source))
    .filter((item) => labels.every((label) => item.labels.includes(label)))
    .filter((item) => getMissionLabel(item) === missionId);
  const readyIds = new Set(canonical.graph.ready_item_ids);
  return allMissionItems
    .filter((item) => statuses.includes(item.status))
    .filter((item) => {
      if (item.status === 'blocked') return areMissionTaskDependenciesSatisfied(state, item);
      return readyIds.has(item.item_id) && areMissionTaskDependenciesSatisfied(state, item);
    });
}

function resolveAssigneePeerId(input: {
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

function buildDispatchResponseArtifact(input: {
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

function evaluateWorkItemDrift(input: {
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

function buildWorkItemPromptBody(input: {
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
      ? `Acceptance criteria:\n- ${acceptanceCriteria.join('\n- ')}`
      : '',
    ...buildFastTierPromptAddendum(input.taskModelHint),
    '',
    ...buildWorkingPrinciplesLines(input.teamRole),
    'Return exactly one ```task_result``` block and nothing else structured.',
    'Task result schema: {"summary":"3 sentences max","artifacts":[{"path":"...","kind":"..."}],"verification_done":["..."],"gaps":["..."],"needs":["..."],"acceptance_evidence":[{"criterion":"exact criterion text","status":"passed|failed","evidence":"specific verification or artifact"}]}',
    acceptanceCriteria.length > 0
      ? 'For every acceptance criterion, copy its exact text into acceptance_evidence and record specific evidence. Do not mark it passed without evidence.'
      : '',
    'Do not paste file contents. Include only conclusions, artifact paths, verification steps, gaps, and needs.',
  ].filter(Boolean);
  return lines.join('\n');
}

function buildTaskResultRetryPrompt(input: {
  missionId: string;
  item: WorkItem;
  previousResponse: string;
  parseErrors: string[];
}): string {
  const metadata = (input.item.metadata || {}) as Record<string, unknown>;
  const hasAcceptanceCriteria =
    Array.isArray(metadata.acceptance_criteria) && metadata.acceptance_criteria.length > 0;
  return [
    `The previous response for mission ${input.missionId} and work item ${input.item.item_id} was rejected.`,
    'Resend the answer as exactly one ```task_result``` block.',
    'Required fields: summary, artifacts, verification_done, gaps, needs.',
    hasAcceptanceCriteria
      ? 'Also include acceptance_evidence for every acceptance criterion, using the exact criterion text and specific evidence.'
      : '',
    'Do not include other structured blocks.',
    'Errors:',
    ...input.parseErrors.map((error) => `- ${error}`),
    '',
    'Previous response excerpt:',
    input.previousResponse.slice(0, 1200),
  ].join('\n');
}

async function buildWorkItemDispatchContext(input: {
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
    securityScope: contextPack.security_scope,
    cognitiveRoute,
  };
}

function summarizeDispatchObservability(input: {
  pruning?: Record<string, unknown>;
  taskResult?: { needs?: string[] } | undefined;
  parseErrors: string[];
}): {
  context_chars?: number;
  pruned_chars?: number;
  rollup_used: boolean;
  result_schema_ok: boolean;
  needs_count: number;
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
  };
}

function parseTaskResultResponse(responseText: string): {
  taskResult?: NonNullable<ReturnType<typeof extractSurfaceBlocks>['taskResults']>[number];
  parseErrors: string[];
  surfaceParseErrors: string[];
  plainText: string;
} {
  const structured = extractSurfaceBlocks(responseText);
  return {
    taskResult: structured.taskResults?.[0],
    parseErrors: structured.taskResultErrors || [],
    surfaceParseErrors: structured.surfaceParseErrors || [],
    plainText: structured.text,
  };
}

function buildTaskResultClarificationPacket(input: {
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

function buildClarificationArtifactPath(missionPath: string, itemId: string): string {
  return nodePath.join(dispatchRoot(missionPath), `workitem-clarification-${itemId}.json`);
}

async function routeToAgentOrSubagent(input: {
  missionId: string;
  item: WorkItem;
  teamRole?: string;
  assigneePeerId?: string;
  prompt: string;
  taskModelHint: TaskModelHint;
  mode: MissionWorkItemDispatchMode;
  surfacePurpose?: 'implementation' | 'review';
  defaultExecutionSurface?: MissionExecutionSurface;
  securityScope: ContextSecurityScope;
  adapters: WorkItemDispatchAdapters;
  signal: AbortSignal;
  contextMode: AgentContextMode;
}): Promise<
  {
    executionMode: 'agent' | 'subagent';
    executionSurfaceUsed: 'cli_subagent' | 'agent_runtime';
  } & WorkItemExecutionOutcome & {
      notes: string[];
    }
> {
  const prompt = input.prompt;
  const itemDetails = input.item as WorkItem & Record<string, unknown>;
  const deliverable =
    typeof itemDetails.deliverable === 'string' ? itemDetails.deliverable : undefined;
  const targetPath =
    typeof itemDetails.target_path === 'string' ? itemDetails.target_path : undefined;
  const acceptanceCriteria = Array.isArray(itemDetails.acceptance_criteria)
    ? itemDetails.acceptance_criteria.filter(
        (criterion): criterion is string =>
          typeof criterion === 'string' && Boolean(criterion.trim())
      )
    : undefined;
  const dependencies = Array.isArray(itemDetails.dependencies)
    ? itemDetails.dependencies.filter(
        (dependency): dependency is string =>
          typeof dependency === 'string' && Boolean(dependency.trim())
      )
    : undefined;

  const notes: string[] = [];
  const surfacePurpose = input.surfacePurpose || 'implementation';
  const surfaceDecision = resolveWorkItemExecutionSurface(
    input.item,
    surfacePurpose,
    input.defaultExecutionSurface
  );
  const metadata = (input.item.metadata || {}) as Record<string, unknown>;
  const signalsKey =
    surfacePurpose === 'review' ? 'review_execution_surface_signals' : 'execution_surface_signals';
  const hasSurfaceConfiguration =
    surfaceDecision.selected_by === 'explicit' ||
    (metadata[signalsKey] !== null && typeof metadata[signalsKey] === 'object');
  const useRuntime =
    surfaceDecision.active_surface === 'agent_runtime' ||
    (!hasSurfaceConfiguration && input.mode === 'agent');
  // ①モデル振り分け: the per-task model hint (tier/effort from phase_kind,
  // risk, scope) rides into the backend call instead of a global env choice.
  const routingOptions = {
    ...(input.taskModelHint?.effort ? { effort: input.taskModelHint.effort } : {}),
    ...(input.taskModelHint?.execution_tier
      ? { model_tier: input.taskModelHint.execution_tier }
      : {}),
    ...(input.taskModelHint?.model_id ? { model: input.taskModelHint.model_id } : {}),
  };
  if (Object.keys(routingOptions).length > 0) {
    notes.push(
      `model routing: tier=${input.taskModelHint?.execution_tier ?? 'default'} effort=${input.taskModelHint?.effort ?? 'default'}`
    );
  }
  if (!useRuntime) {
    const execution = await delegateSubagentTask({
      item: input.item,
      assigneePeerId: input.assigneePeerId,
      prompt,
      routingOptions,
      adapters: input.adapters,
      notes,
      signal: input.signal,
      securityScope: input.securityScope,
      contextMode: input.contextMode,
      purpose: surfacePurpose,
    });
    return {
      executionMode: 'subagent',
      executionSurfaceUsed: 'cli_subagent',
      ...execution,
      notes,
    };
  }

  if (!input.assigneePeerId) {
    if (useRuntime) {
      throw new Error(
        `[EXECUTION_SURFACE_UNAVAILABLE] ${surfaceDecision.surface} requires an assigned agent-runtime peer`
      );
    }
    notes.push('missing assignee_peer_id; falling back to subagent');
    const execution = await delegateSubagentTask({
      item: input.item,
      assigneePeerId: input.assigneePeerId,
      prompt,
      routingOptions,
      adapters: input.adapters,
      notes,
      signal: input.signal,
      securityScope: input.securityScope,
      contextMode: input.contextMode,
      purpose: surfacePurpose,
    });
    return {
      executionMode: 'subagent',
      executionSurfaceUsed: 'cli_subagent',
      ...execution,
      notes,
    };
  }

  if (useRuntime && !input.adapters.routeA2A && !a2aBridge.route) {
    throw new Error(
      `[EXECUTION_SURFACE_UNAVAILABLE] ${surfaceDecision.surface} has no A2A/runtime route`
    );
  }

  // Explicit agent_runtime selections use the same WorkItem lifecycle as CLI
  // delegation. Legacy `--dispatch-mode agent` without a surface selection
  // keeps its compatibility fallback below; it must not claim an item before
  // deciding whether a failed runtime call may fall back to CLI.
  if (surfaceDecision.active_surface === 'agent_runtime') {
    const routeA2A = input.adapters.routeA2A || a2aBridge.route;
    const runtimePort: AgentExecutionPort = {
      delegate: async (request) => {
        const startedAt = new Date().toISOString();
        try {
          const response = await routeA2A({
            a2a_version: '1.0',
            header: {
              msg_id: `REQ-${Date.now().toString(36).toUpperCase()}-${input.item.item_id}`,
              correlation_id: request.idempotency_key,
              sender: 'kyberion:workitem-dispatcher',
              receiver: input.assigneePeerId,
              performative: 'request',
              timestamp: new Date().toISOString(),
            },
            payload: {
              intent: 'workitem_execution',
              text: request.instruction,
              objective: input.item.title || input.item.item_id,
              acceptance_criteria: acceptanceCriteria,
              expected_outputs: [deliverable || '', targetPath || '']
                .map((entry) => String(entry || '').trim())
                .filter(Boolean),
              rationale: deliverable
                ? `Deliver ${deliverable} for ${input.item.item_id}`
                : `Complete work item ${input.item.item_id}`,
              prior_decisions:
                dependencies && dependencies.length > 0
                  ? [`Dependencies: ${dependencies.join(', ')}`]
                  : undefined,
              context: {
                mission_id: input.missionId,
                work_item_id: input.item.item_id,
                team_role: input.teamRole,
                execution_mode: 'workitem',
                task_model_hint: input.taskModelHint,
                security_scope: input.securityScope,
                context_mode: input.contextMode,
              },
            },
          });
          const runtimeId =
            typeof response.payload?.runtime_id === 'string'
              ? response.payload.runtime_id
              : undefined;
          return {
            execution_kind: 'agent_delegation',
            task_id: request.task_id,
            agent_id: request.agent_id || input.assigneePeerId || `task-agent-${request.task_id}`,
            ...(runtimeId ? { runtime_id: runtimeId } : {}),
            status: 'succeeded',
            started_at: startedAt,
            completed_at: new Date().toISOString(),
            output_ref: `${input.item.item_id}:result`,
            output: String(response.payload?.text || ''),
          };
        } catch (error) {
          return {
            execution_kind: 'agent_delegation',
            task_id: request.task_id,
            agent_id: request.agent_id || input.assigneePeerId || `task-agent-${request.task_id}`,
            status: 'failed',
            started_at: startedAt,
            completed_at: new Date().toISOString(),
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    };
    const receipt: CoordinatedAgentExecutionReceipt = await delegateCoordinatedAgentTask(
      {
        work_item_id: input.item.item_id,
        task_id: getWorkItemTaskId(input.item) || input.item.item_id,
        mission_id: input.missionId,
        agent_id: input.assigneePeerId,
        security_scope: input.securityScope,
        context_mode: input.contextMode,
        success_status:
          surfacePurpose === 'review' || isIndependentReviewRequired(input.item)
            ? 'review'
            : 'done',
        instruction: prompt,
        context_refs: [JSON.stringify(input.taskModelHint), JSON.stringify(routingOptions)],
        idempotency_key: `agent-runtime:${surfacePurpose}:${input.item.item_id}:${input.item.version}`,
      },
      runtimePort,
      input.assigneePeerId || `workitem-runtime:${input.item.item_id}`
    );
    if (receipt.status !== 'succeeded') {
      throw new Error(receipt.error || `[EXECUTION_SURFACE_FAILED] ${surfaceDecision.surface}`);
    }
    return {
      executionMode: 'agent',
      executionSurfaceUsed: 'agent_runtime',
      responseText: receipt.output || '',
      attemptId: receipt.attempt_id,
      runtimeId: receipt.runtime_id,
      outputRef: receipt.output_ref,
      executorAgentId: receipt.agent_id,
      provider: receipt.provider,
      notes,
    };
  }

  try {
    const response = input.adapters.routeA2A
      ? await input.adapters.routeA2A({
          a2a_version: '1.0',
          header: {
            msg_id: `REQ-${Date.now().toString(36).toUpperCase()}-${input.item.item_id}`,
            sender: 'kyberion:workitem-dispatcher',
            receiver: input.assigneePeerId,
            performative: 'request',
            timestamp: new Date().toISOString(),
          },
          payload: {
            intent: 'workitem_execution',
            text: prompt,
            objective: input.item.title || input.item.item_id,
            acceptance_criteria: acceptanceCriteria,
            expected_outputs: [deliverable || '', targetPath || '']
              .map((entry) => String(entry || '').trim())
              .filter(Boolean),
            rationale: deliverable
              ? `Deliver ${deliverable} for ${input.item.item_id}`
              : `Complete work item ${input.item.item_id}`,
            prior_decisions:
              dependencies && dependencies.length > 0
                ? [`Dependencies: ${dependencies.join(', ')}`]
                : undefined,
            context: {
              mission_id: input.missionId,
              work_item_id: input.item.item_id,
              team_role: input.teamRole,
              execution_mode: 'workitem',
              task_model_hint: input.taskModelHint,
              security_scope: input.securityScope,
              context_mode: input.contextMode,
            },
          },
        })
      : await a2aBridge.route({
          a2a_version: '1.0',
          header: {
            msg_id: `REQ-${Date.now().toString(36).toUpperCase()}-${input.item.item_id}`,
            sender: 'kyberion:workitem-dispatcher',
            receiver: input.assigneePeerId,
            performative: 'request',
            timestamp: new Date().toISOString(),
          },
          payload: {
            intent: 'workitem_execution',
            text: prompt,
            objective: input.item.title || input.item.item_id,
            acceptance_criteria: acceptanceCriteria,
            expected_outputs: [deliverable || '', targetPath || '']
              .map((entry) => String(entry || '').trim())
              .filter(Boolean),
            rationale: deliverable
              ? `Deliver ${deliverable} for ${input.item.item_id}`
              : `Complete work item ${input.item.item_id}`,
            prior_decisions:
              dependencies && dependencies.length > 0
                ? [`Dependencies: ${dependencies.join(', ')}`]
                : undefined,
            context: {
              mission_id: input.missionId,
              work_item_id: input.item.item_id,
              team_role: input.teamRole,
              execution_mode: 'workitem',
              task_model_hint: input.taskModelHint,
              security_scope: input.securityScope,
              context_mode: input.contextMode,
            },
          },
        });
    return {
      executionMode: 'agent',
      executionSurfaceUsed: 'agent_runtime',
      responseText: String(response.payload?.text || ''),
      notes,
    };
  } catch (error: any) {
    if (!hasSurfaceConfiguration && input.mode === 'agent') {
      throw new Error(
        `[EXECUTION_SURFACE_FAILED] ${surfaceDecision.surface} dispatch failed: ${error?.message || error}`
      );
    }
    notes.push(`agent dispatch failed: ${error?.message || error}; falling back to subagent`);
    const backend = getReasoningBackend();
    const nativeDispatcher = new HarnessSubagentDispatcher();
    const responseText = input.adapters.delegateTask
      ? await input.adapters.delegateTask(prompt, `workitem:${input.item.item_id}`, {
          context_mode: input.contextMode,
          signal: input.signal,
        })
      : await nativeDispatcher.dispatch(prompt, `workitem:${input.item.item_id}`, backend, {
          model: input.taskModelHint.model_id,
          effort: input.taskModelHint.effort,
          profile: 'implementer',
          context_mode: input.contextMode,
          role: 'implementer',
          signal: input.signal,
        });
    return { executionMode: 'subagent', executionSurfaceUsed: 'cli_subagent', responseText, notes };
  }
}

async function obtainTaskResultResponse(input: {
  missionId: string;
  item: WorkItem;
  teamRole?: string;
  assigneePeerId?: string;
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
  let surfaceParseErrors = parsed.surfaceParseErrors;
  const needsRetry = !taskResult || parseErrors.length > 0 || (taskResult.needs || []).length > 0;

  if (needsRetry) {
    retried = true;
    if (taskResult?.needs?.length) {
      notes.push(`task_result.needs requested: ${taskResult.needs.join('; ')}`);
    }
    if (parseErrors.length > 0) {
      notes.push(`task_result parse errors: ${parseErrors.join('; ')}`);
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
    response = await route(attemptPrompt, 'continue');
    parsed = parseTaskResultResponse(response.responseText);
    taskResult = parsed.taskResult;
    parseErrors = parsed.parseErrors;
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
    surfaceParseErrors,
    notes,
    retried,
  };
}

export async function dispatchMissionWorkItems(
  state: MissionState,
  options: MissionWorkItemDispatchOptions = {},
  adapters: WorkItemDispatchAdapters = {}
): Promise<MissionWorkItemDispatchManifest> {
  const maxRounds = Math.max(
    1,
    Number(options.rounds ?? process.env.KYBERION_DISPATCH_MAX_ROUNDS ?? 1)
  );
  let manifest = await dispatchMissionWorkItemsRound(state, options, adapters);
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
      adapters
    );
  }
  return manifest;
}

async function dispatchMissionWorkItemsRound(
  state: MissionState,
  options: MissionWorkItemDispatchOptions = {},
  adapters: WorkItemDispatchAdapters = {}
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
        : artifactReviewReceipt && artifactReviewReceipt.receipt.verdict !== 'approved'
          ? 'review'
          : independentReviewRequired && reviewerResult && !reviewerResult.verdict.approved
            ? 'review'
            : finalStatus;
    record.execution_mode = response.executionMode;
    record.execution_surface_used = response.executionSurfaceUsed;
    record.notes.push(...response.notes);
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
