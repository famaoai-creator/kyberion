import { a2aBridge, AgentBusyError } from './a2a-bridge.js';
import { readHintsByCategory } from './src/feedback-loop.js';
import {
  buildMissionTeamView,
  resolveMissionTeamPlan,
  resolveMissionTeamReceiver,
} from './mission-team-plan-composer.js';
import { resolveTaskModelHint } from './reasoning-model-routing.js';
import { type TaskModelPhaseKind } from './reasoning-level-policy.js';
import { resolveQuestionInteractionPacket } from './question-resolver.js';
import { inferTaskTargetPath, validateDelegatedTaskPreflight } from './delegation-preflight.js';
import { notifyOperator } from './operator-notifications.js';
import { agentRegistry } from './agent-registry.js';
import { deriveAgentNhiId } from './agent-identity.js';
import {
  appendDelegationLink,
  buildDelegationLink,
  delegationChainRootActor,
  serializeDelegationChain,
  validateChainAttenuation,
  type DelegationCapabilityTier,
  type DelegationChain,
} from './delegation-chain.js';
import { resolveCapabilityProfileForTeamRole } from './subagent-capability-profiles.js';
import { reportProviderTemporarilyUnhealthy } from './provider-health-registry.js';
import {
  emitChannelSurfaceEvent,
  enqueueChronosOutboxMessage,
  type PlanningPacket,
} from './channel-surface.js';
import { enqueueSurfaceOutboxMessage } from './surface-coordination-store.js';
import { extractPlanningPacketBlocks } from './planning-packet-contract.js';
import {
  buildPlannerKickoffPrompt,
  buildPlannerRetryPrompt,
  buildPlanningReviewPrompt,
  collectPlanningPacketTaskContractErrors,
  packetRequiresIndependentReview,
  parsePlanningReviewVerdict,
  type PlanningReviewVerdict,
} from './mission-planning-packet.js';
import { extractSurfaceBlocks } from './surface-response-blocks.js';
import { renderStructuredOutputSchemaPrompt } from './structured-output-contracts.js';
import { evaluateMissionGate, writeMissionGateRecord } from './mission-gate-engine.js';
import { resolveArtifactReviewerProfile } from './mission-review-gates.js';
import { draftRefine } from './draft-refine.js';
import {
  ensureMissionTeamRuntimeViaSupervisor,
  shutdownAllAgentRuntimes,
} from './agent-runtime-supervisor.js';
import { ledger } from './ledger.js';
import { missionCoordinationBus } from './mission-coordination-bus.js';
import {
  claimWorkItem,
  importExternalWorkItem,
  releaseWorkItem,
  updateWorkItem,
  type WorkItem,
} from './work-coordination.js';
import { logger } from './core.js';
import { buildWorkingPrinciplesLines, canonicalizeTeamRole } from './working-principles.js';
import {
  buildWorkingPrinciplesInjectionProvider,
  getMissionDynamicInjectionRegistry,
  getMissionScopedDynamicInjectionRegistry,
  renderInjectionsAsSystemReminders,
  type DynamicInjectionProvider,
  type DynamicInjectionRegistry,
  type ScopedDynamicInjectionRegistry,
} from './dynamic-injection.js';
import {
  runGoalDrivenLoop,
  type GoalPreStepHook,
  type GoalWallClockScheduler,
  type RunGoalDrivenLoopOptions,
} from './worker-goal-driver.js';
import {
  createGoal,
  type GoalBudgetLimits,
  type GoalRuntimeState,
  type GoalState,
} from './worker-goal.js';
import { WorkerStateJournal } from './worker-state-journal.js';
import { getDefaultWorkerEventStream, type WorkerEventStream } from './worker-event-stream.js';
import { buildExecutionEnv } from './authority.js';
import { missionDir, missionEvidenceDir, rootDir } from './path-resolver.js';
import { pathResolver } from './path-resolver.js';
import { type MissionContextPackPruningSummary } from './mission-context-pack.js';
import { provisionTaskKnowledge } from './task-knowledge-provisioning.js';
import { appendPromptVisibilityRecord } from './prompt-visibility-ledger.js';
import {
  recordKnowledgeDelivery,
  type DeliveredKnowledgeRef,
} from './src/knowledge-feedback-loop.js';
import { findRelevantDistilledKnowledge } from './distill-knowledge-injector.js';
import { TraceContext, persistTrace } from './src/trace.js';
import { createGapRecorder, sanitizeGapSamples, type GapRecorder } from './gap-phase.js';
import * as nodePath from 'node:path';
import * as path from 'node:path';
import { readJson } from './foundation/json.js';
import { getRegisteredEnvText } from './foundation/env.js';
import {
  safeExec,
  safeExistsSync,
  loadJson,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} from './secure-io.js';
import { emitMissionTaskEvent } from './mission-task-events.js';
import {
  enqueueMissionOrchestrationEvent,
  emitMissionOrchestrationObservation,
  loadMissionOrchestrationEvent,
  startMissionOrchestrationWorker,
  type MissionOrchestrationEvent,
} from './mission-orchestration-events.js';
import {
  appendMissionOrchestrationJournalStatus,
  loadMissionOrchestrationJournal,
  loadMissionOrchestrationReplayPlan,
  provisionMissionEntry,
  writeProvisionedJson,
  writeProvisionedText,
} from './mission-orchestration-journal.js';
import { createMissionProgressController } from './mission-orchestration-progress.js';
import {
  evaluateMissionPhaseExitGates,
  loadMissionStateSnapshot,
  missionClassOf,
  missionRiskProfileOf,
  resolvePhaseGateMode,
  summarizeMissionGateState,
} from './mission-orchestration-phase-gates.js';
import { validatePlannedNextTasks } from './mission-orchestration-task-validation.js';
import {
  buildArtifactReviewLines,
  normalizeReviewFindings,
  persistArtifactReviewReceipt,
  prepareArtifactReviewTask,
  resolveReviewArtifact,
  resolveReviewTargetForTask,
} from './mission-orchestration-artifact-review.js';
import {
  emitSlackMissionEvent,
  resolveMissionRelativeTargetPath,
  resolveMissionPlanningPacket,
} from './mission-orchestration-planning.js';
export { resolveMissionPlanningPacket } from './mission-orchestration-planning.js';
import {
  handleMissionIssueRequested,
  handleMissionTeamPrewarmRequested,
  handleMissionKickoffRequested,
  handleMissionFollowupRequested,
  handleMissionReconciliationRequested,
  handleMissionDistillationRequested,
  handleMissionCompletionRequested,
  handleMissionControlRequested,
  handleSurfaceControlRequested,
  notifyRequestingSurface,
  type MissionLifecycleHandlerDeps,
} from './mission-orchestration-lifecycle-handlers.js';
import {
  obtainTaskResultResponse as obtainTaskResultResponseCore,
  type TaskResultResponseDeps,
} from './mission-orchestration-task-response.js';
import {
  dispatchMissionNextTasksCore as dispatchMissionNextTasksCoreImpl,
  type DispatchCoreDeps,
} from './mission-orchestration-dispatch.js';

export {
  evaluateMissionPhaseExitGates,
  loadMissionPhaseGateDefinitions,
  resolvePhaseGateMode,
} from './mission-orchestration-phase-gates.js';
import { recoverMissionRequestedTasks } from './mission-task-recovery.js';
import {
  emitIntentSnapshot,
  latestSnapshot,
  mapStageToLoopPhase,
} from './intent-snapshot-store.js';
import { evaluateMissionIntentDrift } from './mission-intent-delta.js';
import { summarizeHeuristics } from './heuristic-feedback.js';
import { getIntentExtractor } from './intent-extractor.js';
import { installAnthropicBackendsIfAvailable } from './reasoning-bootstrap.js';
import { getReasoningBackend, getLastServedReasoningMode } from './reasoning-backend.js';
import { fireLifecycleHooks, getDefaultLifecycleHookEngine } from './lifecycle-hook-engine.js';
import {
  getMissionAgentInputQueue,
  renderAgentInputQueueEntries,
  type AgentInputQueueScope,
  type AgentInputQueue,
} from './agent-input-queue.js';
import { deriveExecutionGraph, executeGraph, type GraphNode } from './graph-scheduler.js';
import {
  buildMissionGraphInputs,
  collectMissionGraphHandoffs,
  type MissionGraphHandoff,
} from './mission-graph-handoff.js';
import {
  openOrCreateMissionGraphRunJournal,
  type MissionGraphRunJournalHandle,
} from './mission-graph-run-journal.js';
import { providerIdForReasoningIdentifier } from './provider-egress-gate.js';
import { MissionWorkingMemory } from './mission-working-memory.js';
import {
  MAX_CARRYOVER_BACKGROUND_TASKS,
  WorkerContextCompactor,
  isPromptTooLongError,
  type ActiveBackgroundTaskRef,
  type CompactionCarryover,
  type CompactionReason,
  type WorkerContextMessage,
} from './worker-context-compaction.js';
import { listActiveDelegatedTaskRecords } from './delegated-task-observability.js';
import {
  claimPendingDelegationNotifications,
  renderDelegationNotificationLines,
  DELEGATION_NOTIFICATION_CLAIM_LIMIT,
} from './delegation-notifications.js';
import {
  payloadSurface,
  type MissionControlPayload,
  type PlannedNextTask,
  type SlackPayload,
  type SurfaceControlPayload,
  type TaskResultBlock,
} from './mission-orchestration-worker-contracts.js';

import {
  ensureWorkerBackendsInstalled,
  emitWorkerTransitionSnapshot,
  emitWorkerKickoffSnapshot,
  missionProgressController,
  buildUnassignedRoleSummary,
  buildUpstreamResultLines,
  resolveMissionType,
  runMissionController,
  recordMissionContextTask,
  buildNeedsKnowledgeReinforcementLines,
  buildTaskResultRetryPrompt,
  parseTaskResultResponse,
  recordMissionVisiblePrompt,
} from './mission-orchestration-worker-part-context.js';
import {
  resolveTaskDispatchTimeoutMs,
  withTaskDispatchTimeout,
  cascadeBlockedDependents,
  missionTaskTraceDirOverride,
  warnMissionTaskTraceFailureOnce,
  dispatchPlannedMissionTask,
} from './mission-orchestration-worker-part-dispatch.js';

/**
 * XP-05 closeout: stamp `TaskResultBlock.provenance` at the worker's persist
 * point. `obtainTaskResultResponse` is where a single-shot dispatch's
 * `taskResult` becomes final; everything downstream — `input.task.last_result`
 * (line ~2640, which flows into the persisted `NEXT_TASKS.json` plan),
 * `updateWorkItem` metadata summaries, and every
 * `emitMissionTaskEvent({ payload: { task_result } })` call — references this
 * same object, so stamping it once here is enough for it to survive to every
 * persist/propagation point. Deliberately NOT added to the human-readable
 * `upstreamResultLines` prompt lines (see buildUpstreamResultLines) — those
 * are prose for the next agent's context window, not the schema-validated
 * block.
 *
 * Boundary (do not fabricate): `getLastServedReasoningMode()` is process-local
 * state set by the reasoning-backend failover chain (reasoning-backend.ts)
 * only when a candidate in *this process* actually serves a call. Dispatch
 * here goes through `a2aBridge.route()`, which for a genuinely remote a2a
 * worker (different process/machine) never touches this process's reasoning
 * backend — the accessor then holds either `null` or a stale value from an
 * unrelated earlier call. Only stamp when the accessor reports a mode; a
 * remote worker is responsible for stamping its own provenance before
 * handing the block back over a2a (tracked as follow-up, out of scope here).
 * Never overwrites a block that already carries `provenance` (e.g. a future
 * remote-worker-stamped result).
 */
export function stampTaskResultProvenance(taskResult: TaskResultBlock | undefined): void {
  if (!taskResult || taskResult.provenance) return;
  const served = getLastServedReasoningMode();
  if (!served || !served.mode) return;
  const provider = providerIdForReasoningIdentifier(served.mode) || served.provider;
  taskResult.provenance = {
    mode: served.mode,
    ...(provider ? { provider } : {}),
    failover: served.failover === true,
  };
}

/**
 * DH-06: record a model-visible dispatch prompt before it crosses the A2A
 * boundary. The ledger stores only a digest/length and references, never the
 * prompt body. This is deliberately fail-closed: sending a prompt without a
 * durable visibility receipt would violate the model-visible/logged contract.
 */
export const taskResultResponseDeps: TaskResultResponseDeps = {
  recordMissionVisiblePrompt,
  resolveTaskDispatchTimeoutMs,
  parseTaskResultResponse,
  buildNeedsKnowledgeReinforcementLines,
  buildTaskResultRetryPrompt,
  stampTaskResultProvenance,
};

export async function obtainTaskResultResponse(
  input: Parameters<typeof obtainTaskResultResponseCore>[1]
): ReturnType<typeof obtainTaskResultResponseCore> {
  return obtainTaskResultResponseCore(taskResultResponseDeps, input);
}

// ---------------------------------------------------------------------------
// E2E-03 Task 5: MO-07 minimal activation — best-of-2 + judge.
// High-risk implement work runs twice with different approach directives, an
// independent judge picks the winner, and the loser is kept as evidence.
// Narrow by design (cost doubles); KYBERION_BEST_OF_N=0 disables it.
// ---------------------------------------------------------------------------

// MO-07 Task 4.2 wiring: high-risk document deliverables get one
// rubric-driven refine pass before the acceptance gate. Narrow by design
// (extra reasoning call); KYBERION_DRAFT_REFINE=0 disables it.
export function isDraftRefineCandidate(input: {
  teamRole: string;
  task: PlannedNextTask;
}): boolean {
  if (getRegisteredEnvText('KYBERION_DRAFT_REFINE') === '0') return false;
  const role = String(input.teamRole || '').toLowerCase();
  if (role === 'reviewer' || role === 'qa' || role === 'planner') return false;
  const risk = String(input.task.risk || '').toLowerCase();
  if (risk !== 'high' && risk !== 'high_stakes') return false;
  const deliverable = String(input.task.deliverable || '').toLowerCase();
  return (
    deliverable.endsWith('.md') || deliverable.endsWith('.markdown') || deliverable.endsWith('.txt')
  );
}

export async function applyDraftRefineToDeliverable(input: {
  missionId: string;
  task: PlannedNextTask;
  teamRole: string;
}): Promise<void> {
  const deliverable = String(input.task.deliverable || '');
  if (!deliverable) return;
  const deliverablePath = deliverable.startsWith('/')
    ? deliverable
    : `${missionDir(input.missionId, 'public')}/${deliverable}`;
  try {
    if (!safeExistsSync(deliverablePath)) return;
    const original = String(safeReadFile(deliverablePath, { encoding: 'utf8' }) || '');
    if (!original.trim()) return;
    const outcome = await draftRefine({
      kind: 'doc',
      content: original,
      goalSummary: input.task.description,
      maxPasses: 1,
    });
    if (outcome.passes > 0 && outcome.improved) {
      safeWriteFile(deliverablePath, outcome.content);
      emitMissionTaskEvent({
        event_type: 'task_reviewed',
        mission_id: input.missionId,
        task_id: input.task.task_id,
        agent_id: 'mission-orchestration-worker',
        team_role: input.teamRole,
        decision: 'task_reviewed',
        why: `draft refined (${outcome.initial_severity} → ${outcome.final_severity})`,
        policy_used: 'mission_orchestration_control_plane_v1',
        evidence: [deliverable],
        payload: {
          kind: 'draft_refined',
          passes: outcome.passes,
          initial_severity: outcome.initial_severity,
          final_severity: outcome.final_severity,
          cost_multiplier: 1 + outcome.passes,
        },
      });
    }
  } catch (err: any) {
    // Refinement is a quality bonus, never a gate: failures must not block
    // acceptance of the original deliverable.
    logger.warn(`[worker] draft refine skipped for ${input.task.task_id}: ${err?.message || err}`);
  }
}

export function isBestOfNCandidate(input: { teamRole: string; task: PlannedNextTask }): boolean {
  if (getRegisteredEnvText('KYBERION_BEST_OF_N') === '0') return false;
  const role = String(input.teamRole || '').toLowerCase();
  if (role === 'reviewer' || role === 'qa' || role === 'planner') return false;
  const risk = String(input.task.risk || '').toLowerCase();
  return risk === 'high' || risk === 'high_stakes';
}

export const BEST_OF_APPROACHES = [
  { key: 'A', directive: 'アプローチA: 最小実装優先 — deliver the smallest correct change first.' },
  {
    key: 'B',
    directive:
      'アプローチB: 堅牢性優先 — prioritize robustness: edge cases, failure handling, verification.',
  },
] as const;

export function parseBestOfJudgeVerdict(
  text: string
): { winner: 'A' | 'B'; rationale?: string; merge_hints?: string[] } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const winner = String(parsed.winner || '').toUpperCase();
    if (winner !== 'A' && winner !== 'B') return null;
    return {
      winner,
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale : undefined,
      merge_hints: Array.isArray(parsed.merge_hints) ? parsed.merge_hints.map(String) : undefined,
    };
  } catch {
    return null;
  }
}

export async function obtainBestOfTaskResultResponse(input: {
  missionId: string;
  task: PlannedNextTask;
  teamRole: string;
  agentId: string;
  taskModelHint?: { model_id?: string; tier?: string; effort?: string; route_reason?: string };
  prompt: string;
  contextPackId?: string;
  securityScope?: import('./context-security-scope.js').ContextSecurityScope;
  deliveredKnowledgeRefs?: DeliveredKnowledgeRef[];
  /** NI-03: forwarded verbatim to each candidate's obtainTaskResultResponse. */
  delegationChain?: DelegationChain;
}): Promise<Awaited<ReturnType<typeof obtainTaskResultResponse>>> {
  const attempts: Array<{
    key: string;
    response: Awaited<ReturnType<typeof obtainTaskResultResponse>>;
  }> = [];
  for (const approach of BEST_OF_APPROACHES) {
    const response = await obtainTaskResultResponse({
      ...input,
      prompt: `## Approach directive (best-of-N candidate ${approach.key})\n${approach.directive}\n\n${input.prompt}`,
    });
    attempts.push({ key: approach.key, response });
  }
  const [first, second] = attempts;
  // If either attempt failed structurally, prefer the one that parsed.
  if (!second.response.taskResult) return first.response;
  if (!first.response.taskResult) return second.response;

  const judgePrompt = [
    `You are an independent judge in a separate context from both implementers.`,
    `Two candidate task results were produced for mission ${input.missionId}, task ${input.task.task_id}.`,
    `Task: ${input.task.description || input.task.task_id}`,
    input.task.acceptance_criteria?.length
      ? `Acceptance criteria:\n- ${input.task.acceptance_criteria.join('\n- ')}`
      : '',
    '',
    `Candidate A (${BEST_OF_APPROACHES[0].directive}):`,
    JSON.stringify(first.response.taskResult, null, 2).slice(0, 6000),
    '',
    `Candidate B (${BEST_OF_APPROACHES[1].directive}):`,
    JSON.stringify(second.response.taskResult, null, 2).slice(0, 6000),
    '',
    'Pick the candidate that best satisfies the task and criteria.',
    'Return JSON only: { "winner": "A" | "B", "rationale": string, "merge_hints": string[] }',
  ]
    .filter(Boolean)
    .join('\n');

  recordMissionVisiblePrompt({
    missionId: input.missionId,
    taskId: `${input.task.task_id}-judge`,
    content: judgePrompt,
    form: 'best_of_judge',
    ...(input.contextPackId ? { contextPackId: input.contextPackId } : {}),
    knowledgeRefs: input.deliveredKnowledgeRefs,
    securityScope: input.securityScope,
  });

  let verdict: { winner: 'A' | 'B'; rationale?: string; merge_hints?: string[] } | null = null;
  try {
    const judgeResponse = await a2aBridge.route({
      a2a_version: '1.0',
      header: {
        msg_id: `REQ-${Date.now().toString(36).toUpperCase()}-${input.task.task_id}-judge`,
        sender: 'kyberion:mission-orchestrator',
        receiver: input.agentId,
        performative: 'request',
        timestamp: new Date().toISOString(),
      },
      payload: {
        intent: 'mission_task_execution',
        text: judgePrompt,
        objective: `Judge best-of-2 candidates for ${input.task.task_id}`,
        context: {
          mission_id: input.missionId,
          team_role: 'reviewer',
          task_id: `${input.task.task_id}-judge`,
          execution_mode: 'task',
          security_scope: input.securityScope,
        },
      },
    });
    verdict = parseBestOfJudgeVerdict(String(judgeResponse.payload?.text || ''));
  } catch (err: any) {
    logger.warn(
      `[MISSION_WORKER] best-of judge failed for ${input.task.task_id}: ${err?.message || err}`
    );
  }

  const winnerKey = verdict?.winner || 'A';
  const winner = winnerKey === 'B' ? second : first;
  const loser = winnerKey === 'B' ? first : second;

  // Keep the losing candidate — it is evidence, not garbage (MO-07 rule).
  try {
    const evidenceDir = missionEvidenceDir(input.missionId);
    if (evidenceDir) {
      const alternativesDir = path.join(evidenceDir, 'alternatives');
      safeMkdir(alternativesDir, { recursive: true });
      writeProvisionedJson({
        missionId: input.missionId,
        filePath: path.join(alternativesDir, `${input.task.task_id}-candidate-${loser.key}.json`),
        targetPath: `evidence/alternatives/${input.task.task_id}-candidate-${loser.key}.json`,
        provisioned: provisionMissionEntry({
          task_id: input.task.task_id,
          candidate: loser.key,
          winner: winnerKey,
          judge_rationale: verdict?.rationale,
          merge_hints: verdict?.merge_hints,
          task_result: loser.response.taskResult,
        }),
      });
    }
  } catch (err: any) {
    logger.warn(
      `[MISSION_WORKER] failed to persist best-of alternative for ${input.task.task_id}: ${err?.message || err}`
    );
  }

  emitMissionTaskEvent({
    event_type: 'task_reviewed',
    mission_id: input.missionId,
    task_id: input.task.task_id,
    agent_id: input.agentId,
    team_role: input.teamRole,
    decision: 'best_of_judged',
    why: verdict?.rationale || 'best-of-2 judge verdict (fallback to candidate A on judge failure)',
    policy_used: 'mo07_best_of_n_v1',
    payload: {
      winner: winnerKey,
      judge_succeeded: Boolean(verdict),
      cost_multiplier: 2,
      merge_hints: verdict?.merge_hints || [],
    },
  });

  if (verdict?.merge_hints?.length && winner.response.taskResult) {
    winner.response.notes.push(`best-of judge merge hints: ${verdict.merge_hints.join('; ')}`);
  }
  return winner.response;
}

// ---------------------------------------------------------------------------
// E2E-03 Task 6: PR-style collaboration for code_change missions.
// Completed implement work is committed to the mission micro-repo, a
// task/<task_id> branch marks the commit, and evidence/prs/<task_id>/
// {diff.patch, PR.md} become the reviewable object. No GitHub remote is
// required — the local patch is the default; a real PR is a later opt-in.
// ---------------------------------------------------------------------------

export function publishTaskPrArtifacts(input: {
  missionId: string;
  task: PlannedNextTask;
  teamRole: string;
  taskResult?: TaskResultBlock;
}): string | undefined {
  const role = String(input.teamRole || '').toLowerCase();
  if (role === 'reviewer' || role === 'qa' || role === 'planner') return undefined;
  if (missionClassOf(input.missionId) !== 'code_change') return undefined;
  const missionPath = missionDir(input.missionId, 'public');
  try {
    safeExec('git', ['rev-parse', '--git-dir'], { cwd: missionPath });
  } catch {
    return undefined; // no micro-repo (fixture missions); nothing to publish
  }
  const branch = `task/${input.task.task_id}`;
  const summary = (input.taskResult?.summary || input.task.description || input.task.task_id)
    .replace(/\s+/g, ' ')
    .slice(0, 120);
  let committed = true;
  try {
    safeExec('git', ['add', '-A'], { cwd: missionPath });
    safeExec('git', ['commit', '-m', `task ${input.task.task_id}: ${summary}`], {
      cwd: missionPath,
    });
  } catch {
    committed = false; // nothing new to commit — still publish the PR record
  }
  try {
    safeExec('git', ['branch', '-f', branch, 'HEAD'], { cwd: missionPath });
  } catch (err: any) {
    logger.warn(
      `[MISSION_WORKER] failed to mark branch ${branch} for ${input.missionId}: ${err?.message || err}`
    );
  }
  let diff = '';
  let changedFiles: string[] = [];
  if (committed) {
    try {
      diff = String(
        safeExec('git', ['format-patch', '-1', 'HEAD', '--stdout'], { cwd: missionPath }) || ''
      );
      changedFiles = String(
        safeExec('git', ['show', '--name-only', '--pretty=format:', 'HEAD'], {
          cwd: missionPath,
        }) || ''
      )
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    } catch (err: any) {
      logger.warn(
        `[MISSION_WORKER] failed to capture diff for ${input.task.task_id}: ${err?.message || err}`
      );
    }
  }
  const prDir = path.join(missionPath, 'evidence', 'prs', input.task.task_id);
  safeMkdir(prDir, { recursive: true });
  writeProvisionedText({
    missionId: input.missionId,
    filePath: path.join(prDir, 'diff.patch'),
    targetPath: `evidence/prs/${input.task.task_id}/diff.patch`,
    provisioned: provisionMissionEntry(
      diff || `(no committed changes for task ${input.task.task_id})\n`
    ),
  });
  writeProvisionedText({
    missionId: input.missionId,
    filePath: path.join(prDir, 'PR.md'),
    targetPath: `evidence/prs/${input.task.task_id}/PR.md`,
    provisioned: provisionMissionEntry(
      [
        `# ${summary}`,
        '',
        `- Mission: ${input.missionId}`,
        `- Task: ${input.task.task_id}`,
        `- Branch: ${branch}`,
        `- Deliverable: ${input.task.deliverable || input.task.target_path || 'n/a'}`,
        '',
        '## Description',
        input.taskResult?.summary || input.task.description || '(no summary)',
        '',
        '## Changed files',
        ...(changedFiles.length > 0
          ? changedFiles.map((file) => `- ${file}`)
          : ['- (none committed)']),
        '',
      ].join('\n')
    ),
  });
  return `evidence/prs/${input.task.task_id}/PR.md`;
}

export function syncPlanningArtifacts(missionId: string): void {
  missionProgressController.syncPlanningArtifacts(missionId);
}

export function persistPlanningPacket(missionId: string, packet: PlanningPacket): void {
  missionProgressController.persistPlanningPacket(missionId, packet);
}

export function loadPlannedNextTasks(missionId: string): PlannedNextTask[] {
  return missionProgressController.loadPlannedNextTasks(missionId);
}

export function loadAllNextTasks(missionId: string): PlannedNextTask[] {
  return missionProgressController.loadAllNextTasks(missionId);
}

export function writeNextTasks(missionId: string, tasks: PlannedNextTask[]): void {
  missionProgressController.writeNextTasks(missionId, tasks);
}

export function restoreMissionGraphRunTaskSnapshots(
  tasks: PlannedNextTask[],
  journal: MissionGraphRunJournalHandle
): void {
  const nodeStates = journal.state().node_states;
  const executionFields = [
    'status',
    'rework_count',
    'review_round',
    'last_result',
    'review_findings',
    'rework_packet',
    'artifact_review_receipt',
    'reconciliation',
  ] as const;
  const taskById = new Map(tasks.map((task) => [task.task_id, task]));
  for (const node of nodeStates.values()) {
    const snapshot = node.task_snapshot;
    const task = snapshot ? taskById.get(node.task_id) : undefined;
    if (!task || !snapshot) continue;
    for (const field of executionFields) {
      if (Object.prototype.hasOwnProperty.call(snapshot, field)) {
        (task as unknown as Record<string, unknown>)[field] = snapshot[field];
      }
    }
  }
}

export function reconcileMissionProgress(missionId: string): void {
  missionProgressController.reconcileMissionProgress(missionId);
}

export function markTaskBoardInProgress(missionId: string): void {
  missionProgressController.markTaskBoardInProgress(missionId);
}

export const dispatchCoreDeps: DispatchCoreDeps = {
  ensureWorkerBackendsInstalled,
  loadAllNextTasks,
  restoreMissionGraphRunTaskSnapshots,
  writeNextTasks,
  reconcileMissionProgress,
  runMissionController,
  recordMissionContextTask,
  resolveTaskDispatchTimeoutMs,
  withTaskDispatchTimeout,
  dispatchPlannedMissionTask,
  loadPlannedNextTasks,
  buildUnassignedRoleSummary,
  cascadeBlockedDependents,
  markTaskBoardInProgress,
};

export async function dispatchMissionNextTasksCore(
  missionId: string,
  missionRunTrace?: TraceContext,
  graphRunId?: string
): Promise<Array<{ task_id: string; team_role: string; agent_id: string }>> {
  return dispatchMissionNextTasksCoreImpl(dispatchCoreDeps, missionId, missionRunTrace, graphRunId);
}
export async function dispatchMissionNextTasks(
  missionId: string,
  graphRunId?: string
): Promise<Array<{ task_id: string; team_role: string; agent_id: string }>> {
  const traceCtx = new TraceContext('mission_run', {
    missionId,
    correlationId: `mission-run:${missionId}:${Date.now()}`,
  });
  let dispatched: Array<{ task_id: string; team_role: string; agent_id: string }> = [];
  try {
    traceCtx.addEvent('mission_run_started', { mission_id: missionId });
    dispatched = await dispatchMissionNextTasksCore(missionId, traceCtx, graphRunId);
    traceCtx.setAttributes({
      mission_id: missionId,
      dispatched_task_count: dispatched.length,
      status: 'completed',
    });
    return dispatched;
  } catch (error) {
    traceCtx.setAttributes({
      mission_id: missionId,
      dispatched_task_count: dispatched.length,
      status: 'error',
    });
    traceCtx.addEvent('mission_run_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    try {
      const trace = traceCtx.finalize();
      const dirOverride = missionTaskTraceDirOverride();
      persistTrace(trace, dirOverride ? { dir: dirOverride } : undefined);
    } catch (error) {
      warnMissionTaskTraceFailureOnce('Failed to persist mission run trace', error);
    }
  }
}

export function summarizeMissionTaskOutcomes(missionId: string): {
  acceptedCount: number;
  reviewedCount: number;
  completedCount: number;
  requestedCount: number;
} {
  return missionProgressController.summarizeMissionTaskOutcomes(missionId);
}

export const missionLifecycleHandlerDeps: MissionLifecycleHandlerDeps = {
  runMissionController,
  emitSlackMissionEvent,
  resolveMissionType,
  emitWorkerKickoffSnapshot,
  persistPlanningPacket,
  syncPlanningArtifacts,
  reconcileMissionProgress,
  dispatchMissionNextTasks,
  emitWorkerTransitionSnapshot,
  summarizeMissionTaskOutcomes,
  notifyRequestingSurface,
  loadPlannedNextTasks,
};

export async function processMissionOrchestrationEventPath(eventPath: string): Promise<void> {
  ensureWorkerBackendsInstalled();
  const event = loadMissionOrchestrationEvent<SlackPayload>(eventPath);
  const priorCompletion = loadMissionOrchestrationJournal(event.mission_id, event.scope)
    .filter((entry) => entry.event_id === event.event_id)
    .at(-1);
  if (priorCompletion?.outcome.status === 'completed') {
    emitMissionOrchestrationObservation({
      decision: 'mission_orchestration_event_already_completed',
      event_id: event.event_id,
      event_type: event.event_type,
      mission_id: event.mission_id,
      scope: event.scope,
    });
    return;
  }
  emitMissionOrchestrationObservation({
    decision: 'mission_orchestration_event_started',
    event_id: event.event_id,
    event_type: event.event_type,
    mission_id: event.mission_id,
  });

  try {
    switch (event.event_type) {
      case 'mission_issue_requested':
        await handleMissionIssueRequested(event, missionLifecycleHandlerDeps);
        break;
      case 'mission_team_prewarm_requested':
        await handleMissionTeamPrewarmRequested(event, missionLifecycleHandlerDeps);
        break;
      case 'mission_kickoff_requested':
        await handleMissionKickoffRequested(event, missionLifecycleHandlerDeps);
        break;
      case 'mission_followup_requested':
        await handleMissionFollowupRequested(event, missionLifecycleHandlerDeps);
        break;
      case 'mission_reconciliation_requested':
        await handleMissionReconciliationRequested(event, missionLifecycleHandlerDeps);
        break;
      case 'mission_distillation_requested':
        await handleMissionDistillationRequested(event, missionLifecycleHandlerDeps);
        break;
      case 'mission_completion_requested':
        await handleMissionCompletionRequested(event, missionLifecycleHandlerDeps);
        break;
      case 'mission_control_requested':
        await handleMissionControlRequested(
          event as unknown as MissionOrchestrationEvent<MissionControlPayload>,
          missionLifecycleHandlerDeps
        );
        break;
      case 'surface_control_requested':
        await handleSurfaceControlRequested(
          event as unknown as MissionOrchestrationEvent<SurfaceControlPayload>,
          missionLifecycleHandlerDeps
        );
        break;
      default:
        throw new Error(`Unsupported orchestration event type: ${event.event_type}`);
    }
    appendMissionOrchestrationJournalStatus({
      missionId: event.mission_id,
      eventId: event.event_id,
      eventType: event.event_type,
      status: 'completed',
      payload: event.payload,
      requestedBy: event.requested_by,
      causationId: event.causation_id,
      correlationId: event.correlation_id,
      scope: event.scope,
      missionPathHint: event.scope?.tenant_slug
        ? pathResolver.tenantMissionDir(event.mission_id, event.scope.tenant_slug, event.scope.tier)
        : undefined,
    });
    emitMissionOrchestrationObservation({
      decision: 'mission_orchestration_event_completed',
      event_id: event.event_id,
      event_type: event.event_type,
      mission_id: event.mission_id,
      scope: event.scope,
    });
  } catch (error) {
    appendMissionOrchestrationJournalStatus({
      missionId: event.mission_id,
      eventId: event.event_id,
      eventType: event.event_type,
      status: 'failed',
      payload: event.payload,
      requestedBy: event.requested_by,
      causationId: event.causation_id,
      correlationId: event.correlation_id,
      scope: event.scope,
      missionPathHint: event.scope?.tenant_slug
        ? pathResolver.tenantMissionDir(event.mission_id, event.scope.tenant_slug, event.scope.tier)
        : undefined,
    });
    emitMissionOrchestrationObservation({
      decision: 'mission_orchestration_event_failed',
      event_id: event.event_id,
      event_type: event.event_type,
      mission_id: event.mission_id,
      scope: event.scope,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
