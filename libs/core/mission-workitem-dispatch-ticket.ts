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

export function extractGitHubIssueNumber(source: unknown): number | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const record = source as Record<string, unknown>;
  const raw = record.issue_number ?? record.number ?? record.id;
  const numeric = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(numeric) ? numeric : undefined;
}

export function extractGitHubRepoInfo(source: unknown): {
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

export function extractJiraIssueKey(source: unknown): string | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const record = source as Record<string, unknown>;
  const raw = record.issue_key ?? record.key ?? record.id;
  const value = typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim();
  return value || undefined;
}

export function extractJiraProjectInfo(source: unknown): { domain?: string; projectKey?: string } {
  if (!source || typeof source !== 'object') return {};
  const record = source as Record<string, unknown>;
  return {
    domain: typeof record.domain === 'string' ? record.domain : undefined,
    projectKey: typeof record.projectKey === 'string' ? record.projectKey : undefined,
  };
}

export function buildTicketReflectionBody(input: {
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

export function deriveTicketState(
  finalStatus: MissionWorkItemDispatchFinalStatus,
  notes: string[]
): 'done' | 'review' | 'blocked' {
  if (finalStatus === 'blocked' || notes.some((note) => /block/i.test(note))) return 'blocked';
  return finalStatus === 'done' ? 'done' : 'review';
}

export function normalizeAcceptanceText(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function evaluateAcceptanceCriteriaEvidence(input: {
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

export function updateTicketManifest(
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

export const TICKET_STATE_TO_TASK_STATUS: Record<string, string> = {
  // Keep NEXT_TASKS (what the finish exit gate reads) in lockstep with the
  // ticket outcome — the dog-food run required hand-syncing statuses before
  // finish because dispatch only annotated ticket_dispatch metadata.
  done: 'completed',
  review: 'reviewed',
  blocked: 'blocked',
};

export const TASK_STATUS_RANK: Record<string, number> = {
  planned: 0,
  rework: 1,
  blocked: 2,
  review: 3,
  reviewed: 3,
  done: 4,
  completed: 4,
  accepted: 5,
};

export function updateNextTasksReflection(
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

export function appendComment(
  existing: unknown,
  comment: Record<string, unknown>
): Record<string, unknown>[] {
  const comments = Array.isArray(existing)
    ? (existing.filter((entry) => entry && typeof entry === 'object') as Record<string, unknown>[])
    : [];
  comments.push(comment);
  return comments;
}

export async function reflectTicketOutcome(input: {
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
