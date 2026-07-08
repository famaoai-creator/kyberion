/**
 * scripts/refactor/mission-workitem-dispatch.ts
 * Mission work item execution dispatch for registered tickets.
 */

import * as nodePath from 'node:path';
import {
  a2aBridge,
  executeServicePreset,
  getReasoningBackend,
  ledger,
  logger,
  pathResolver,
  resolveMissionTeamReceiver,
  safeExistsSync,
  listWorkItems,
  updateWorkItem,
  buildCognitiveRouteDecision,
  formatCognitiveRouteDecision,
  advanceReasoningDriftWatchdog,
  encodeReasoningDriftWatchdogState,
  hydrateReasoningDriftWatchdogState,
  formatReasoningDriftWatchdogDecision,
  extractSurfaceBlocks,
  renderMissionContextPack,
  resolveMissionContextPack,
  saveMissionContextPack,
  resolveTaskModelHint,
  resolveQuestionInteractionPacket,
  type TaskResultBlock,
  type CognitiveRouteDecision,
  type A2AMessage,
  type WorkItem,
  type WorkItemSource,
  type WorkItemStatus,
  type TaskModelHint,
  type OperatorInteractionPacket,
} from '@agent/core';
import { findMissionPath } from '@agent/core';
import { buildWorkingPrinciplesLines } from '@agent/core';
import type { MissionState } from './mission-types.js';
import {
  countWords as countWordsFromDispatchIO,
  readJsonFile as readJsonFileFromDispatchIO,
  writeJsonFile as writeJsonFileFromDispatchIO,
} from './mission-dispatch-io.js';
import { appendDispatchEvent, writeDispatchArtifact } from './mission-dispatch-lifecycle.js';
import { evaluatePhaseEntryGate } from './mission-process-planning.js';
import { recordTask } from './mission-maintenance.js';

export type MissionWorkItemDispatchMode = 'auto' | 'agent' | 'subagent';
export type MissionWorkItemDispatchFinalStatus = 'review' | 'done' | 'blocked';

export interface MissionWorkItemDispatchOptions {
  mode?: MissionWorkItemDispatchMode;
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
  reviewer_path?: string;
  reviewer_excerpt?: string;
  reviewer_notes?: string[];
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
  delegateTask?: (instruction: string, context?: string) => Promise<string>;
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
  return resolveTaskModelHint({
    phase_kind: phaseKind,
    ...(risk ? { risk } : {}),
    ...(estimatedScope ? { estimated_scope: estimatedScope } : {}),
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
  adapters: WorkItemDispatchAdapters;
}): Promise<{
  verdict: WorkItemDispatchReviewerVerdict;
  reviewerPrompt: string;
  reviewerPath: string;
  reviewerExcerpt: string;
  reviewerTaskModelHint: TaskModelHint;
  reviewerContextPackId: string;
  reviewerContextPackPath: string;
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

  const reviewerResponseText = input.adapters.delegateTask
    ? await input.adapters.delegateTask(reviewerPrompt, `workitem-review:${input.item.item_id}`)
    : await getReasoningBackend().delegateTask(
        reviewerPrompt,
        `workitem-review:${input.item.item_id}`
      );
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
  prompt: string;
  routingOptions: Record<string, unknown>;
  adapters: WorkItemDispatchAdapters;
  notes: string[];
}): Promise<string> {
  const run = async (): Promise<string> => {
    if (input.adapters.delegateTask) {
      return input.adapters.delegateTask(input.prompt, `workitem:${input.item.item_id}`);
    }
    return getReasoningBackend().delegateTask(
      input.prompt,
      `workitem:${input.item.item_id}`,
      input.routingOptions
    );
  };
  const wantsFiles = workItemExpectsFiles(input.item);
  const previousTools = process.env.KYBERION_CLAUDE_AGENT_TOOLS;
  if (wantsFiles && previousTools === undefined) {
    process.env.KYBERION_CLAUDE_AGENT_TOOLS = '1';
    input.notes.push('agentic tools auto-enabled (work item expects file output)');
  }
  try {
    let responseText = await run();
    if (!responseText || !responseText.trim()) {
      input.notes.push('empty subagent response; retrying once');
      responseText = await run();
    }
    return responseText;
  } finally {
    if (wantsFiles && previousTools === undefined) {
      delete process.env.KYBERION_CLAUDE_AGENT_TOOLS;
    }
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
}): { satisfied: boolean; missing: string[] } {
  const criteria = Array.from(
    new Set(input.criteria.map((criterion) => normalizeAcceptanceText(criterion)).filter(Boolean))
  );
  if (criteria.length === 0) {
    return { satisfied: true, missing: [] };
  }

  const evidenceParts = [input.responseText, input.responseExcerpt];
  const evidence = normalizeAcceptanceText(evidenceParts.join('\n'));
  const missing = criteria.filter((criterion) => !evidence.includes(criterion));
  return {
    satisfied: missing.length === 0,
    missing,
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
  });
  const fastTierVerificationSatisfied =
    !isFastTierTaskModelHint(input.taskModelHint) ||
    ((input.taskResult?.verification_done?.length || 0) > 0 &&
      ((input.taskResult?.artifacts?.length || 0) > 0 ||
        (input.taskResult?.needs?.length || 0) > 0));
  if (!fastTierVerificationSatisfied) {
    notes.push('fast-tier verification incomplete');
  }
  if (!acceptanceCheck.satisfied) {
    notes.push(`acceptance criteria not met: ${acceptanceCheck.missing.join('; ')}`);
  }
  if (!taskId) {
    notes.push('missing task_id for ticket reflection');
    return {
      ticketState: deriveTicketState(
        acceptanceCheck.satisfied
          ? input.finalStatus
          : input.responseText.trim()
            ? 'review'
            : 'blocked',
        notes
      ),
      reflectionPath: '',
      notes,
    };
  }

  const effectiveFinalStatus =
    acceptanceCheck.satisfied && fastTierVerificationSatisfied
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
    acceptance_criteria_satisfied: acceptanceCheck.satisfied,
    acceptance_criteria_missing: acceptanceCheck.missing,
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
      acceptance_criteria_satisfied: acceptanceCheck.satisfied,
      acceptance_criteria_missing: acceptanceCheck.missing,
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
  return listWorkItems({
    projectId,
    source: sources,
    status: statuses,
    labels,
  }).filter((item) => getMissionLabel(item) === missionId);
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
    'Task result schema: {"summary":"3 sentences max","artifacts":[{"path":"...","kind":"..."}],"verification_done":["..."],"gaps":["..."],"needs":["..."]}',
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
  return [
    `The previous response for mission ${input.missionId} and work item ${input.item.item_id} was rejected.`,
    'Resend the answer as exactly one ```task_result``` block.',
    'Required fields: summary, artifacts, verification_done, gaps, needs.',
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
  adapters: WorkItemDispatchAdapters;
}): Promise<{ executionMode: 'agent' | 'subagent'; responseText: string; notes: string[] }> {
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
  // ①モデル振り分け: the per-task model hint (tier/effort from phase_kind,
  // risk, scope) rides into the backend call instead of a global env choice.
  const routingOptions = {
    ...(input.taskModelHint?.effort ? { effort: input.taskModelHint.effort } : {}),
    ...(input.taskModelHint?.execution_tier
      ? { model_tier: input.taskModelHint.execution_tier }
      : {}),
  };
  if (Object.keys(routingOptions).length > 0) {
    notes.push(
      `model routing: tier=${input.taskModelHint?.execution_tier ?? 'default'} effort=${input.taskModelHint?.effort ?? 'default'}`
    );
  }
  if (input.mode === 'subagent' || (!input.assigneePeerId && input.mode === 'auto')) {
    const responseText = await delegateSubagentTask({
      item: input.item,
      prompt,
      routingOptions,
      adapters: input.adapters,
      notes,
    });
    return { executionMode: 'subagent', responseText, notes };
  }

  if (!input.assigneePeerId) {
    notes.push('missing assignee_peer_id; falling back to subagent');
    const responseText = await delegateSubagentTask({
      item: input.item,
      prompt,
      routingOptions,
      adapters: input.adapters,
      notes,
    });
    return { executionMode: 'subagent', responseText, notes };
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
            },
          },
        });
    return { executionMode: 'agent', responseText: String(response.payload?.text || ''), notes };
  } catch (error: any) {
    notes.push(`agent dispatch failed: ${error?.message || error}; falling back to subagent`);
    const backend = getReasoningBackend();
    const responseText = input.adapters.delegateTask
      ? await input.adapters.delegateTask(prompt, `workitem:${input.item.item_id}`)
      : await backend.delegateTask(prompt, `workitem:${input.item.item_id}`);
    return { executionMode: 'subagent', responseText, notes };
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
  adapters: WorkItemDispatchAdapters;
}): Promise<{
  executionMode: 'agent' | 'subagent';
  responseText: string;
  taskResult?: TaskResultBlock;
  parseErrors: string[];
  surfaceParseErrors: string[];
  notes: string[];
  retried: boolean;
}> {
  let attemptPrompt = input.prompt;
  const notes: string[] = [];
  let retried = false;
  let response = await routeToAgentOrSubagent({
    missionId: input.missionId,
    item: input.item,
    teamRole: input.teamRole,
    assigneePeerId: input.assigneePeerId,
    prompt: attemptPrompt,
    taskModelHint: input.taskModelHint,
    mode: input.mode,
    adapters: input.adapters,
  });
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
    response = await routeToAgentOrSubagent({
      missionId: input.missionId,
      item: input.item,
      teamRole: input.teamRole,
      assigneePeerId: input.assigneePeerId,
      prompt: attemptPrompt,
      taskModelHint: input.taskModelHint,
      mode: input.mode,
      adapters: input.adapters,
    });
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
    responseText: response.responseText,
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
    const assigneePeerId = resolveAssigneePeerId({ missionId, item, teamRole });
    const taskModelHint = getTaskModelHint(item);
    const validation = validateWorkItemGranularity(item, assigneePeerId);
    const record: MissionWorkItemDispatchRecord = {
      item_id: item.item_id,
      title: getTaskDescription(item),
      team_role: teamRole,
      assignee_peer_id: assigneePeerId,
      execution_mode: mode,
      status: validation.ok ? 'created' : 'failed',
      work_item_status_before: item.status,
      task_model_hint: taskModelHint,
      notes: [...validation.notes],
    };

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

    const response = await obtainTaskResultResponse({
      missionId,
      item,
      teamRole,
      assigneePeerId,
      prompt: dispatchContext.prompt,
      taskModelHint,
      mode,
      adapters,
    });
    const cognitiveRouteSummary = formatCognitiveRouteDecision(dispatchContext.cognitiveRoute);
    let reviewerResult: {
      verdict: WorkItemDispatchReviewerVerdict;
      reviewerPrompt: string;
      reviewerPath: string;
      reviewerExcerpt: string;
      reviewerTaskModelHint: TaskModelHint;
      reviewerContextPackId: string;
      reviewerContextPackPath: string;
    } | null = null;
    const independentReviewRequired = isIndependentReviewRequired(item);
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
      prompt: dispatchContext.prompt,
      responseText: response.responseText,
      cognitiveRouteSummary,
      executionMode: response.executionMode,
      ticketState: finalStatus,
    });
    const effectiveFinalStatus = driftWatchdog.shouldStop
      ? 'blocked'
      : !response.taskResult || response.parseErrors.length > 0 || taskResultNeeds.length > 0
        ? 'blocked'
        : independentReviewRequired && reviewerResult && !reviewerResult.verdict.approved
          ? 'review'
          : finalStatus;
    record.execution_mode = response.executionMode;
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
      responseText: response.responseText,
      prompt: dispatchContext.prompt,
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

    updateWorkItem({
      itemId: item.item_id,
      status: reflection.ticketState,
      assigneePeerId: assigneePeerId || item.assignee_peer_id,
      metadata: {
        ...(item.metadata || {}),
        last_dispatch_at: new Date().toISOString(),
        last_dispatch_mode: response.executionMode,
        last_dispatch_mission_id: missionId,
        last_dispatch_response_path: artifact.filePath,
        last_dispatch_response_excerpt: record.response_excerpt,
        last_context_pack_id: dispatchContext.contextPackId,
        last_context_pack_path: dispatchContext.contextPackPath,
        last_cognitive_route_tier: dispatchContext.cognitiveRoute.tier,
        last_cognitive_route_reason: dispatchContext.cognitiveRoute.reason,
        last_cognitive_route_summary: cognitiveRouteSummary,
        last_task_model_hint: taskModelHint,
        last_task_result_needs: taskResultNeeds,
        last_clarification_packet_path: clarificationPacketPath,
        needs_input: Boolean(clarificationPacket),
        ...(reviewerResult
          ? {
              last_independent_reviewer_status: record.reviewer_status,
              last_independent_reviewer_path: record.reviewer_path,
              last_independent_reviewer_excerpt: record.reviewer_excerpt,
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
      response_path: artifact.filePath,
      status_after: reflection.ticketState,
      ticket_state_after: reflection.ticketState,
      ticket_reflection_path: reflection.reflectionPath || undefined,
      reviewer_status: record.reviewer_status,
      reviewer_path: record.reviewer_path,
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
      context_pack_id: dispatchContext.contextPackId,
      context_pack_path: dispatchContext.contextPackPath,
      context_pack_summary: dispatchContext.contextPackSummary,
      context_pack_pruning_summary: dispatchContext.contextPackPruningSummary,
      ...taskResultObservability,
      cognitive_route_summary: cognitiveRouteSummary,
      drift_watchdog_summary: driftWatchdog.decisionSummary,
      ticket_state_after: reflection.ticketState,
      response_path: artifact.filePath,
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
