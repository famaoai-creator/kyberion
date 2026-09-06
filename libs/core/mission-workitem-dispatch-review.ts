/**
 * scripts/refactor/mission-workitem-dispatch.ts
 * Mission work item execution dispatch for registered tickets.
 */

import * as nodePath from 'node:path';
import type { A2AMessage } from './a2a-bridge.js';
import { getA2ARoute } from './a2a-route-port.js';
import type { AgentExecutionPort, AgentExecutionReceipt } from './agent-execution-port.js';
import type { AgentContextMode } from './context-boundary.js';
import {
  buildArtifactReviewReceipt,
  hashArtifactForReview,
  inferArtifactReviewKind,
  type ArtifactReviewFinding,
  type ArtifactReviewReceipt,
} from './artifact-review.js';
import { getReasoningBackend } from './reasoning-backend.js';
import {
  delegateCoordinatedCliSubagentTask,
  delegateCoordinatedAgentTask,
  type CoordinatedAgentExecutionReceipt,
} from './coordinated-agent-execution-port.js';
import { loadAgentProfileIndex } from './mission-team-index.js';
import * as pathResolver from './path-resolver.js';
import { getRegisteredEnvText, setRegisteredEnv } from './foundation/env.js';
import { parseSafeJsonObjectInput } from './foundation/safe-json.js';
import { nowIso } from './foundation/time.js';
import {
  resolveArtifactReviewerProfile,
  type ArtifactReviewerProfile,
} from './mission-review-gates.js';
import { resolveMissionTeamReceiver } from './mission-team-plan-composer.js';
import { safeExistsSync, safeStat } from './secure-io.js';
import { type WorkItem, type WorkItemSource, type WorkItemStatus } from './work-coordination.js';
import { type CognitiveRouteDecision } from './cognitive-routing.js';
import {
  renderMissionContextPack,
  resolveMissionContextPack,
  saveMissionContextPack,
} from './mission-context-pack.js';
import { resolveTaskModelHint, type TaskModelHint } from './reasoning-model-routing.js';
import { type TaskResultBlock } from './channel-surface-types.js';
import { type OperatorInteractionPacket } from './src/types/operator-interaction-packet.js';
import { HarnessSubagentDispatcher } from './agent-dispatch.js';
import { buildWorkingPrinciplesLines } from './working-principles.js';
import type { MissionState } from './mission-types.js';
import type { ContextSecurityScope } from './context-security-scope.js';
import { checkProviderEgress } from './provider-egress-gate.js';
import { evaluateEgressPolicy } from './egress-policy.js';
import { reasoningBackendEndpoint } from './reasoning-egress-scope.js';
import { writeDispatchArtifact } from './mission-dispatch-lifecycle.js';
import { loadMissionNextTaskObjectsAtPath } from './mission-next-task-reader.js';
import { loadMissionWorkItemDispatchManifestAtPath } from './mission-workitem-dispatch-manifest.js';
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

export function resolveRuntimeSecurityScope(
  scope: ContextSecurityScope,
  provider?: string
): ContextSecurityScope {
  if (!provider || scope.external_egress !== 'deny') return scope;
  const dataTier = scope.write_tier;
  const providerDecision = checkProviderEgress({ provider, dataTier });
  if (!providerDecision.allowed) return scope;
  const endpointBackend =
    provider === 'claude'
      ? 'claude-cli'
      : provider === 'agy'
        ? 'agy-cli'
        : provider === 'grok'
          ? 'grok-cli'
          : provider;
  const endpointDecision = evaluateEgressPolicy(reasoningBackendEndpoint(endpointBackend), {
    tier: dataTier,
    tenant_slug: scope.tenant_slug || scope.tenant_id,
    purpose: scope.purpose,
  });
  if (endpointDecision.verdict !== 'allow') return scope;
  return {
    ...scope,
    external_egress: 'allow',
    allowed_reasoning_backends: Array.from(
      new Set([...(scope.allowed_reasoning_backends || []), provider])
    ),
  };
}
export interface WorkItemExecutionOutcome {
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
  task_result_repairs?: string[];
  task_result_repair_requires_review?: boolean;
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
  written_at?: string;
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

export interface WorkItemDispatchAdapters {
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
export const DEFAULT_WORK_ITEM_RESPONSE_TIMEOUT_MS = 10 * 60 * 1000;

export function resolveWorkItemResponseTimeoutMs(): number {
  const raw = getRegisteredEnvText('KYBERION_WORKITEM_RESPONSE_TIMEOUT_MS')?.trim();
  const value = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_WORK_ITEM_RESPONSE_TIMEOUT_MS;
}

export class WorkItemResponseTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(
      `[WORKITEM_RESPONSE_TIMEOUT] no response within ${timeoutMs}ms; the work item was blocked without retrying the same request`
    );
    this.name = 'WorkItemResponseTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}
export type WorkItemDispatchReviewerVerdict = {
  approved: boolean;
  refuted: boolean;
  findings: string[];
  rationale?: string;
  raw_text: string;
  parsed?: Record<string, unknown>;
};

export function dispatchRoot(missionPath: string): string {
  return nodePath.join(missionPath, 'evidence');
}

export function dispatchEventPath(missionPath: string): string {
  return nodePath.join(missionPath, 'coordination', 'events', 'workitem-dispatch.jsonl');
}

export function manifestPath(missionPath: string): string {
  return nodePath.join(dispatchRoot(missionPath), 'workitem-dispatch-manifest.json');
}

export function ticketRoot(missionPath: string): string {
  return nodePath.join(missionPath, 'coordination', 'tickets');
}

export function ticketManifestPath(missionPath: string): string {
  return nodePath.join(ticketRoot(missionPath), 'dispatch-manifest.json');
}

export function ticketReplyPath(missionPath: string, taskId: string): string {
  return nodePath.join(ticketRoot(missionPath), 'replies', `${taskId}.json`);
}

export function missionNextTasksPath(missionPath: string): string {
  return nodePath.join(missionPath, 'NEXT_TASKS.json');
}

function loadReviewNextTasks(missionPath: string): Array<Record<string, unknown>> {
  try {
    return (
      loadMissionNextTaskObjectsAtPath(
        missionNextTasksPath(missionPath),
        nodePath.basename(nodePath.resolve(missionPath))
      ) || []
    );
  } catch {
    return [];
  }
}

export function resolveWorkItemExecutionSurface(
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

export interface WorkItemReviewPlannedTask extends Record<string, unknown> {
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

export interface WorkItemArtifactReviewContext {
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

export type ResolvedWorkItemArtifactReviewContext = WorkItemArtifactReviewContext & {
  targetTaskId: string;
  artifactAbsolutePath: string;
  artifactPath: string;
  artifactSha256: string;
  artifactKind: 'doc' | 'deck' | 'code' | 'media';
  profile: ArtifactReviewerProfile;
  reviewerAgentId: string;
  blockingReason?: undefined;
};

export function resolveWorkItemArtifactReviewContext(input: {
  missionPath: string;
  missionId: string;
  missionState: MissionState;
  item: WorkItem;
  teamRole?: string;
}): WorkItemArtifactReviewContext | null {
  const taskId = getWorkItemTaskId(input.item);
  if (!taskId || (input.teamRole !== 'reviewer' && input.teamRole !== 'qa')) return null;
  const reviewerTeamRole = input.teamRole;
  const tasks = loadReviewNextTasks(input.missionPath) as WorkItemReviewPlannedTask[];
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

export function isResolvedArtifactReviewContext(
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

export function buildArtifactReviewPromptLines(
  context: ResolvedWorkItemArtifactReviewContext
): string[] {
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

export function normalizeArtifactReviewFindings(
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

export function persistWorkItemArtifactReviewReceipt(input: {
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
    receipt as unknown as Record<string, unknown>,
    { missionId: input.missionId, missionPath: input.missionPath }
  );

  const taskPath = missionNextTasksPath(input.missionPath);
  const tasks = loadReviewNextTasks(input.missionPath);
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
    writeDispatchArtifact(taskPath, tasks, {
      missionId: input.missionId,
      missionPath: input.missionPath,
    });
  }
  return { relativePath, receipt };
}

export function readManifest(missionPath: string): MissionWorkItemDispatchManifest | null {
  const path = manifestPath(missionPath);
  if (!safeExistsSync(path)) return null;
  try {
    return loadMissionWorkItemDispatchManifestAtPath(path);
  } catch (_) {
    return null;
  }
}

export function getMissionLabel(item: WorkItem): string | undefined {
  return (item.labels || [])
    .find((label) => label.startsWith('mission:'))
    ?.slice('mission:'.length);
}

export function getTeamRole(item: WorkItem): string | undefined {
  const label = (item.labels || []).find((entry) => entry.startsWith('team_role:'));
  if (label) return label.slice('team_role:'.length);
  const metadata = item.metadata as Record<string, unknown> | undefined;
  const teamRole = metadata?.team_role;
  return typeof teamRole === 'string' ? teamRole : undefined;
}

export function getTaskDescription(item: WorkItem): string {
  return item.title || item.description || item.source_ref || item.item_id;
}

export function getTaskModelHint(
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

export function isFastTierTaskModelHint(taskModelHint?: TaskModelHint): boolean {
  return taskModelHint?.execution_tier === 'fast' || taskModelHint?.tier === 'small';
}

export function buildFastTierPromptAddendum(taskModelHint?: TaskModelHint): string[] {
  if (!isFastTierTaskModelHint(taskModelHint)) return [];
  return [
    'Fast-tier enforcement:',
    '- Restate each acceptance criterion explicitly in the response.',
    '- Provide a non-empty verification_done list that maps to those criteria.',
    '- Include at least one artifact path when files changed or an artifact is expected.',
    '- Keep the result minimal, but do not omit required schema fields.',
  ];
}

export function isIndependentReviewRequired(item: WorkItem): boolean {
  const metadata = (item.metadata || {}) as Record<string, unknown>;
  return metadata.risk === 'approval_required' || metadata.risk === 'high_stakes';
}

export function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  const content = fenced ? fenced[1].trim() : trimmed;
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return content.slice(start, end + 1);
}

export function parseIndependentReviewerVerdict(text: string): WorkItemDispatchReviewerVerdict {
  const rawText = String(text || '');
  const json = extractJsonObject(rawText);
  const findings: string[] = [];
  let approved = false;
  let refuted = false;
  let rationale: string | undefined;
  let parsed: Record<string, unknown> | undefined;
  let jsonShapeInvalid = false;

  if (json) {
    try {
      const record = parseSafeJsonObjectInput(json, 'independent reviewer verdict');
      if (!record) {
        jsonShapeInvalid = true;
        throw new Error('review verdict must be an object');
      }
      const parseBoolean = (value: unknown): boolean | undefined => {
        if (typeof value === 'boolean') return value;
        if (value === 'true') return true;
        if (value === 'false') return false;
        return undefined;
      };
      const parsedApproved = parseBoolean(record.approved);
      const parsedRefuted = parseBoolean(record.refuted);
      if (
        (Object.hasOwn(record, 'approved') && parsedApproved === undefined) ||
        (Object.hasOwn(record, 'refuted') && parsedRefuted === undefined)
      ) {
        jsonShapeInvalid = true;
        throw new Error('review verdict boolean shape');
      }
      if (
        Object.hasOwn(record, 'findings') &&
        (!Array.isArray(record.findings) ||
          record.findings.some((entry) => typeof entry !== 'string'))
      ) {
        jsonShapeInvalid = true;
        throw new Error('review verdict findings shape');
      }
      if (Object.hasOwn(record, 'rationale') && typeof record.rationale !== 'string') {
        jsonShapeInvalid = true;
        throw new Error('review verdict rationale shape');
      }
      parsed = record;
      approved = parsedApproved === true;
      refuted = parsedRefuted === true;
      rationale = typeof record.rationale === 'string' ? record.rationale.trim() : undefined;
      const candidateFindings = Array.isArray(record.findings)
        ? record.findings.map((entry) => entry.trim()).filter(Boolean)
        : [];
      findings.push(...candidateFindings);
    } catch {
      // A structured response was present but invalid; do not let words inside
      // the rejected JSON influence the reviewer decision.
      jsonShapeInvalid = true;
    }
  }

  if (!approved && !refuted && !jsonShapeInvalid) {
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

export function buildIndependentReviewerPrompt(input: {
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

export async function runWithWorkItemResponseDeadline<T>(
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

export function getWorkItemTaskId(item: WorkItem): string | undefined {
  const metadata = (item.metadata || {}) as Record<string, unknown>;
  const taskId = metadata.task_id;
  if (typeof taskId === 'string' && taskId.trim()) return taskId.trim();
  const sourceRef = String(item.source_ref || '').trim();
  const match = sourceRef.match(/^mission:[^:]+:(.+)$/u);
  return match?.[1] || undefined;
}

export async function runIndependentReviewerReview(input: {
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
      provider: reviewerAssignment?.provider || undefined,
      providerModelId: reviewerAssignment?.modelId || undefined,
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
  writeDispatchArtifact(
    reviewerPath,
    {
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
      written_at: nowIso(),
    },
    { missionId: input.missionId, missionPath: input.missionPath }
  );

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
    const startedAt = nowIso();
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
        completed_at: nowIso(),
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
        completed_at: nowIso(),
        error: error instanceof Error ? error.message : String(error),
      };
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
      setRegisteredEnv('KYBERION_CLAUDE_AGENT_TOOLS', previousTools);
    }
  }
}
export async function routeToAgentOrSubagent(input: {
  missionId: string;
  item: WorkItem;
  teamRole?: string;
  assigneePeerId?: string;
  provider?: string;
  providerModelId?: string;
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
  const runtimeSecurityScope = resolveRuntimeSecurityScope(input.securityScope, input.provider);
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
  const defaultA2ARoute = getA2ARoute();
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

  if (useRuntime && !input.adapters.routeA2A && !defaultA2ARoute) {
    throw new Error(
      `[EXECUTION_SURFACE_UNAVAILABLE] ${surfaceDecision.surface} has no A2A/runtime route`
    );
  }

  // Explicit agent_runtime selections use the same WorkItem lifecycle as CLI
  // delegation. Legacy `--dispatch-mode agent` without a surface selection
  // keeps its compatibility fallback below; it must not claim an item before
  // deciding whether a failed runtime call may fall back to CLI.
  if (surfaceDecision.active_surface === 'agent_runtime') {
    // The route port keeps this orchestration module independent from the
    // concrete A2A bridge while preserving the bound receiver.
    const routeA2A = input.adapters.routeA2A || defaultA2ARoute;
    if (!routeA2A) {
      throw new Error(
        `[EXECUTION_SURFACE_UNAVAILABLE] ${surfaceDecision.surface} has no A2A/runtime route`
      );
    }
    const runtimePort: AgentExecutionPort = {
      delegate: async (request) => {
        const startedAt = nowIso();
        try {
          const response = await routeA2A({
            a2a_version: '1.0',
            header: {
              msg_id: `REQ-${Date.now().toString(36).toUpperCase()}-${input.item.item_id}`,
              correlation_id: request.idempotency_key,
              sender: 'kyberion:workitem-dispatcher',
              receiver: input.assigneePeerId,
              performative: 'request',
              timestamp: nowIso(),
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
                ...(input.provider ? { provider: input.provider } : {}),
                ...(input.providerModelId ? { provider_model_id: input.providerModelId } : {}),
                execution_mode: 'workitem',
                dispatch_timeout_ms: resolveWorkItemResponseTimeoutMs(),
                task_model_hint: input.taskModelHint,
                security_scope: runtimeSecurityScope,
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
            completed_at: nowIso(),
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
            completed_at: nowIso(),
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
        security_scope: runtimeSecurityScope,
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
    const routeA2A = input.adapters.routeA2A || defaultA2ARoute;
    if (!routeA2A) {
      throw new Error(
        `[EXECUTION_SURFACE_UNAVAILABLE] ${surfaceDecision.surface} has no A2A/runtime route`
      );
    }
    const response = await routeA2A({
      a2a_version: '1.0',
      header: {
        msg_id: `REQ-${Date.now().toString(36).toUpperCase()}-${input.item.item_id}`,
        sender: 'kyberion:workitem-dispatcher',
        receiver: input.assigneePeerId,
        performative: 'request',
        timestamp: nowIso(),
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
          ...(input.provider ? { provider: input.provider } : {}),
          ...(input.providerModelId ? { provider_model_id: input.providerModelId } : {}),
          execution_mode: 'workitem',
          dispatch_timeout_ms: resolveWorkItemResponseTimeoutMs(),
          task_model_hint: input.taskModelHint,
          security_scope: runtimeSecurityScope,
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
