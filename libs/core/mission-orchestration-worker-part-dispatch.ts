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
  buildUpstreamResultLines,
  buildGraphHandoffLines,
  buildTeamSnapshotLines,
  buildReviewFindingsLines,
  buildDelegationNotificationLines,
  maybeCompactDispatchSections,
  recordMissionContextTask,
  buildMissionGoalLines,
  buildRejectionLessonLines,
  buildAuthorityRoleProcedureInjectionProvider,
  buildTaskExecutionPrompt,
  recordMissionVisiblePrompt,
  buildReviewDiffLines,
} from './mission-orchestration-worker-part-context.js';
import type { DispatchMissionTaskOutcome } from './mission-orchestration-worker-part-context.js';

export async function buildTaskDispatchContext(input: {
  missionId: string;
  task: PlannedNextTask;
  teamRole: string;
  agentId: string;
  authorityRole?: string | null;
  taskModelHint?: { model_id?: string; tier?: string; effort?: string; route_reason?: string };
  allTasks: PlannedNextTask[];
  upstreamHandoffs?: Array<MissionGraphHandoff<DispatchMissionTaskOutcome, TaskResultBlock>>;
  /** OH-01 reactive path: force compaction after a prompt-too-long dispatch failure. */
  forceContextCompaction?: boolean;
}): Promise<{
  prompt: string;
  missionContextPackId?: string;
  missionContextPackPath?: string;
  missionContextPackSummary: string;
  missionContextPackPruningSummary?: MissionContextPackPruningSummary;
  securityScope?: import('./context-security-scope.js').ContextSecurityScope;
  /** KP-05: knowledge actually delivered as part of this dispatch's context pack. */
  deliveredKnowledgeRefs: DeliveredKnowledgeRef[];
}> {
  const missionStateRaw = loadMissionStateSnapshot(input.missionId);
  const missionState =
    missionStateRaw && typeof missionStateRaw === 'object'
      ? missionStateRaw
      : {
          mission_id: input.missionId,
          tier: 'public',
          status: 'active',
          assigned_persona: 'worker',
          git: {
            branch: 'main',
            start_commit: '',
            latest_commit: '',
            checkpoints: [],
          },
          history: [],
          relationships: {},
        };
  // KP-01: single provisioning entry point (resolve + persist + render) —
  // `form: 'pack'` reproduces the pre-KP-01 inline resolve/save/render
  // sequence byte-for-byte.
  const provisionedContext = await provisionTaskKnowledge({
    form: 'pack',
    missionPath: missionDir(input.missionId, 'public'),
    missionId: input.missionId,
    tier: (missionState.tier as 'personal' | 'confidential' | 'public') || 'public',
    recipientKind: 'agent',
    teamRole: input.teamRole,
    assigneePeerId: input.agentId,
    // KP-04: hint count + pack char budget scale with the task's declared
    // scope (SCOPE_KNOWLEDGE_BUDGETS in mission-context-pack.ts). Absent
    // scope falls back to `M`, so untagged tasks are unaffected.
    ...(input.task.estimated_scope ? { estimatedScope: input.task.estimated_scope } : {}),
    workItem: {
      item_id: input.task.task_id,
      title: input.task.description || input.task.task_id,
      description: input.task.description || input.task.task_id,
      status: 'ready',
      priority: 'normal',
      source: 'local',
      source_ref: `mission:${input.missionId}:${input.task.task_id}`,
      project_id: String(
        (missionState.relationships as any)?.project?.project_id || input.missionId
      ),
      labels: [`mission:${input.missionId}`, `team_role:${input.teamRole}`],
      dependencies: Array.isArray((input.task as any).dependencies)
        ? (input.task as any).dependencies
        : [],
      version: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      metadata: {
        deliverable: input.task.deliverable,
        target_path: input.task.target_path,
        acceptance_criteria: (input.task as any).acceptance_criteria,
        risk: (input.task as any).risk,
        estimated_scope: (input.task as any).estimated_scope,
      },
    },
  });
  const missionContextPack = provisionedContext.pack;
  const missionContextPackPath = provisionedContext.missionContextPackPath;
  const missionContextPackText = missionContextPack
    ? provisionedContext.text
    : [
        'Mission context pack unavailable; using degraded fallback context.',
        `- Mission: ${input.missionId}`,
        `- Task: ${input.task.task_id}`,
        input.teamRole ? `- Team role: ${input.teamRole}` : '',
        input.task.description ? `- Description: ${input.task.description}` : '',
      ]
        .filter(Boolean)
        .join('\n');
  const missionGoalLines = buildMissionGoalLines(missionState);
  const compactedSections = await maybeCompactDispatchSections({
    missionId: input.missionId,
    task: input.task,
    allTasks: input.allTasks,
    agentId: input.agentId,
    missionContextPackText,
    missionGoalLines,
    upstreamResultLines: [
      ...buildGraphHandoffLines(input.upstreamHandoffs || []),
      ...buildUpstreamResultLines(input.task, input.allTasks),
      ...buildReviewDiffLines(input.missionId, input.task),
    ],
    teamSnapshotLines: buildTeamSnapshotLines(input.allTasks),
    securityScope: missionContextPack?.security_scope,
    force: input.forceContextCompaction,
    ...(input.forceContextCompaction ? { reason: 'overflow' as const } : {}),
  });
  const upstreamResultLines = compactedSections.upstreamResultLines;
  const teamSnapshotLines = compactedSections.teamSnapshotLines;
  const reviewFindingsLines = buildReviewFindingsLines(input.task);
  const canonicalTeamRole = canonicalizeTeamRole(input.teamRole);
  if (canonicalTeamRole === 'reviewer' || canonicalTeamRole === 'qa') {
    prepareArtifactReviewTask({
      missionId: input.missionId,
      reviewTask: input.task,
      tasks: input.allTasks,
    });
    try {
      missionCoordinationBus.send({
        mission_id: input.missionId,
        channel: 'review',
        from_agent: 'mission_orchestration_worker',
        to_agent: input.agentId,
        to_role: canonicalTeamRole,
        task_id: input.task.task_id,
        content: `Artifact review requested for task ${input.task.task_id}.`,
      });
    } catch {
      // Coordination-bus visibility is best-effort; never block dispatch on it.
    }
  }
  const artifactReviewLines = buildArtifactReviewLines(input.task);
  const rejectionLessonLines = buildRejectionLessonLines();
  // KC-06: deliver claimed background-delegation completions into this dispatch.
  const delegationNotificationLines = buildDelegationNotificationLines(
    DELEGATION_NOTIFICATION_CLAIM_LIMIT,
    { missionId: input.missionId, taskId: input.task.task_id }
  );
  // KC-08: all runtime prompt injections pass through the provider contract.
  // This keeps one-shot/throttle semantics testable and leaves room for repeat
  // warnings and claimed notifications to join the same registry.
  const injectionRegistry = getMissionDynamicInjectionRegistry(input.missionId);
  if (!injectionRegistry.hasProvider('working-principles')) {
    injectionRegistry.register(
      buildWorkingPrinciplesInjectionProvider(buildWorkingPrinciplesLines, input.teamRole)
    );
  }
  if (input.authorityRole) {
    const authorityRoleProviderId = `authority-role-procedure:${input.authorityRole}`;
    if (!injectionRegistry.hasProvider(authorityRoleProviderId)) {
      injectionRegistry.register(buildAuthorityRoleProcedureInjectionProvider(input.authorityRole));
    }
  }
  const dynamicInjectionLines = injectionRegistry
    .collect({ step: 0 })
    .map((injection) => renderInjectionsAsSystemReminders([injection]));
  const promptSupplementChars =
    upstreamResultLines.join('\n').length +
    teamSnapshotLines.join('\n').length +
    reviewFindingsLines.join('\n').length +
    artifactReviewLines.join('\n').length +
    rejectionLessonLines.join('\n').length +
    delegationNotificationLines.join('\n').length +
    dynamicInjectionLines.join('\n').length +
    256;
  const prompt = buildTaskExecutionPrompt({
    missionId: input.missionId,
    task: input.task,
    teamRole: input.teamRole,
    agentId: input.agentId,
    taskModelHint: input.taskModelHint,
    rejectionLessonLines,
    delegationNotificationLines,
    dynamicInjectionLines,
    missionContextPack: missionContextPackText,
    missionGoalLines,
    upstreamResultLines,
    teamSnapshotLines,
    reviewFindingsLines,
    artifactReviewLines,
    targetPath: input.task.target_path || input.task.deliverable,
  });
  const missionContextPackPruningSummary = missionContextPack?.pruning
    ? {
        ...(missionContextPack.pruning as MissionContextPackPruningSummary),
        estimated_chars:
          (missionContextPack.pruning as MissionContextPackPruningSummary).estimated_chars +
          promptSupplementChars,
      }
    : undefined;
  return {
    prompt,
    missionContextPackId: missionContextPack?.context_pack_id,
    missionContextPackPath,
    missionContextPackSummary: missionContextPack?.summary || 'degraded mission context pack',
    missionContextPackPruningSummary,
    securityScope: missionContextPack?.security_scope,
    deliveredKnowledgeRefs: provisionedContext.deliveredKnowledgeRefs,
  };
}

// MO-03 Task 2.3: per-task wall-clock budget derived from estimated_scope.
// A hung dispatch must not stall the whole wave silently — on timeout the
// task is marked blocked(timeout) and downstream dependents cascade to
// blocked(dependency) instead of waiting forever.
export const TASK_DISPATCH_TIMEOUT_MS: Record<'S' | 'M' | 'L', number> = {
  S: 10 * 60 * 1000,
  M: 30 * 60 * 1000,
  L: 60 * 60 * 1000,
};

export function resolveTaskDispatchTimeoutMs(task: {
  estimated_scope?: 'S' | 'M' | 'L';
  timeout_ms?: number;
}): number {
  const explicit = Number((task as Record<string, unknown>).timeout_ms);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return TASK_DISPATCH_TIMEOUT_MS[task.estimated_scope ?? 'M'] ?? TASK_DISPATCH_TIMEOUT_MS.M;
}

export async function withTaskDispatchTimeout(
  task: PlannedNextTask,
  run: Promise<DispatchMissionTaskOutcome | null>
): Promise<DispatchMissionTaskOutcome | null | 'timeout'> {
  const timeoutMs = resolveTaskDispatchTimeoutMs(task);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([run, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * MO-03 Task 2.3: cascade blocked status to transitive dependents so a
 * blocked/timed-out upstream never leaves its dependents silently planned.
 * Exported for tests.
 */
export function cascadeBlockedDependents(tasks: PlannedNextTask[]): string[] {
  const blockedIds = new Set(
    tasks.filter((task) => String(task.status || '') === 'blocked').map((task) => task.task_id)
  );
  const cascaded: string[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      const status = String(task.status || 'planned');
      if (status !== 'planned' && status !== 'rework') continue;
      const hit = (task.dependencies || []).find((dependency) => blockedIds.has(dependency));
      if (hit) {
        task.status = 'blocked';
        blockedIds.add(task.task_id);
        cascaded.push(task.task_id);
        changed = true;
      }
    }
  }
  return cascaded;
}

// ---------------------------------------------------------------------------
// KD-01 adoption: opt-in goal-driven execution mode for the mission worker.
//
// A work item may set `goal_driven: true` (and optionally `goal_budget`) to run
// its objective through the autonomous multi-turn goal loop instead of the
// single-shot dispatch. This wires `runGoalDrivenLoop` to the REAL worker seams
// the mission worker already uses — `getReasoningBackend()` (via the driver's
// default), the process worker event stream, and the mission-scoped
// dynamic-injection registry (so the OH-01 dispatch compactor and the goal
// status/objective providers coexist on the same registry). Goal lifecycle is
// persisted to a KD-03 `WorkerStateJournal` in mission-local storage so a
// kill/restart restores an `active` goal as `paused` (never self-advancing)
// until an explicit resume. A `blocked` goal is escalated through the worker's
// existing mission reporting path (`reportBlockerToMission` →
// `recordMissionContextTask`); the worker never mutates mission-wide state
// directly. Goal tools stay on the MAIN worker loop only — the subagent dispatch
// path is never touched, so the KD-05 reserved `goal:*` denial is unaffected.
// ---------------------------------------------------------------------------

/** Seams for {@link runGoalDrivenWorkItem}; every field defaults to the real runtime singleton. */
export interface GoalDrivenWorkItemSeams {
  backend?: RunGoalDrivenLoopOptions['backend'];
  stream?: WorkerEventStream;
  injectionRegistry?: DynamicInjectionRegistry;
  /** DH-09: optional task/session-scoped injection registry. */
  scopedInjectionRegistry?: ScopedDynamicInjectionRegistry;
  injectionScope?: import('./scoped-registry.js').ScopedRegistryScope;
  journal?: WorkerStateJournal;
  /** Escalate a blocked goal to the mission owner (defaults to `recordMissionContextTask`). */
  reportBlockerToMission?: (state: GoalRuntimeState) => void;
  /** Explicitly resume a persisted `paused` goal (post-restart mission ceremony). */
  resume?: boolean;
  maxTurns?: number;
  wallClockScheduler?: GoalWallClockScheduler;
  now?: () => string;
  /** PI-15/DH-10: ordered model-entry admission hooks. */
  preStep?: readonly GoalPreStepHook[];
}

export interface GoalDrivenWorkItemResult {
  goalId: string;
  finalState: GoalState;
  goal: GoalRuntimeState;
  turnsRun: number;
  /** Goal record fit for persistence at rest (null when complete/cleared). */
  persisted: GoalRuntimeState | null;
  /** True when the goal ended `blocked` and was escalated to the mission. */
  escalated: boolean;
  /** KD-02 grace-step/final-turn prose report (budget-reached `blocked` only). */
  finalReport?: string;
}

/** The work item's objective for the goal loop (framed as untrusted by the driver). */
export function goalDrivenObjective(task: PlannedNextTask): string {
  return (task.description || task.deliverable || task.task_id).trim();
}

/** Stable goal id per (mission, work item), so a resume targets the same journal record. */
export function goalIdForWorkItem(missionId: string, taskId: string): string {
  return `goal-${missionId}-${taskId}`;
}

/** Mission-local KD-03 journal path (per work item). Created lazily on first append. */
export function goalJournalPath(missionId: string, taskId: string): string {
  const safeTaskId = String(taskId)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${missionDir(missionId, 'public')}/coordination/goal-journal-${safeTaskId || 'task'}.jsonl`;
}

/** Convert opt-in work-item budgets into a driver budget (never invented). */
export function resolveGoalBudget(task: PlannedNextTask): GoalBudgetLimits | undefined {
  const raw = task.goal_budget;
  if (!raw) return undefined;
  const budget: GoalBudgetLimits = {};
  if (typeof raw.tokenBudget === 'number' && raw.tokenBudget > 0)
    budget.tokenBudget = raw.tokenBudget;
  if (typeof raw.turnBudget === 'number' && raw.turnBudget > 0) budget.turnBudget = raw.turnBudget;
  if (typeof raw.wallClockBudgetMs === 'number' && raw.wallClockBudgetMs > 0)
    budget.wallClockBudgetMs = raw.wallClockBudgetMs;
  return Object.keys(budget).length > 0 ? budget : undefined;
}

/** Record the terminal goal lifecycle op onto the KD-03 journal. */
export function persistGoalTerminal(
  journal: WorkerStateJournal,
  goalId: string,
  result: { finalState: GoalState; persisted: GoalRuntimeState | null }
): void {
  if (result.finalState === 'complete') {
    // `complete` is transient — a completed goal is cleared, which records one
    // one-shot "ignore prior active-goal reminders" reminder (KD-03 hygiene).
    journal.cancelGoal(goalId, `${goalId}:cleared`);
    return;
  }
  if (result.persisted) journal.recordGoal(result.persisted);
}

/**
 * Run a work item's objective through the autonomous goal-driven loop (KD-01),
 * persisting lifecycle to a KD-03 journal and escalating a blocked goal through
 * the existing mission reporting path. This is the seam the goal-driven dispatch
 * branch calls; it is exported so it can be exercised hermetically with a stub
 * backend, injected event stream, and an injected journal.
 */
export async function runGoalDrivenWorkItem(input: {
  missionId: string;
  task: PlannedNextTask;
  teamRole?: string;
  agentId?: string;
  /** Stable system framing prepended to every turn's prompt. */
  systemPrompt?: string;
  /** Per-turn instruction appended after the injected goal reminders. */
  turnPrompt?: string;
  /** DH-06: optional receipt sink for each model-visible goal turn. */
  onPromptVisible?: (content: string, form: string) => void;
  /** PI-15/DH-10: cooperative turn-boundary yield; never interrupts a turn. */
  shouldStopAfterTurn?: RunGoalDrivenLoopOptions['shouldStopAfterTurn'];
  /** PI-15/DH-10: ordered model-entry admission hooks. */
  preStep?: readonly GoalPreStepHook[];
  /** PI-15: shared mission inbox consumed at goal turn boundaries. */
  inputQueue?: AgentInputQueue;
  /** PI-15: optional task/agent/session filter for the shared inbox. */
  inputQueueScope?: AgentInputQueueScope;
  seams?: GoalDrivenWorkItemSeams;
}): Promise<GoalDrivenWorkItemResult> {
  const { missionId, task } = input;
  const seams = input.seams ?? {};
  const goalId = goalIdForWorkItem(missionId, task.task_id);
  const objective = goalDrivenObjective(task);
  const budget = resolveGoalBudget(task);
  const journal =
    seams.journal ??
    new WorkerStateJournal({
      journalPath: goalJournalPath(missionId, task.task_id),
      ...(seams.now ? { now: seams.now } : {}),
    });
  const stream = seams.stream ?? getDefaultWorkerEventStream();
  const injectionRegistry =
    seams.injectionRegistry ?? getMissionDynamicInjectionRegistry(missionId);
  const reportBlockerToMission =
    seams.reportBlockerToMission ??
    ((state: GoalRuntimeState) => {
      recordMissionContextTask(missionId, `Goal blocked for work item ${task.task_id}`, {
        next_step: 'resolve the goal blocker before resuming the work item',
        work_item_id: task.task_id,
        goal_id: state.goalId,
        blocker: state.terminalReason ?? '',
        ...(input.teamRole ? { team_role: input.teamRole } : {}),
        ...(input.agentId ? { assignee_peer_id: input.agentId } : {}),
      });
    });

  const loopOptions: RunGoalDrivenLoopOptions = {
    objective,
    goalId,
    missionId,
    stream,
    injectionRegistry,
    ...(seams.scopedInjectionRegistry
      ? { scopedInjectionRegistry: seams.scopedInjectionRegistry }
      : {}),
    ...(seams.injectionScope ? { injectionScope: seams.injectionScope } : {}),
    reportBlockerToMission,
    ...(budget ? { budget } : {}),
    ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
    ...(input.turnPrompt ? { turnPrompt: input.turnPrompt } : {}),
    ...(input.onPromptVisible ? { onPromptVisible: input.onPromptVisible } : {}),
    ...(input.shouldStopAfterTurn ? { shouldStopAfterTurn: input.shouldStopAfterTurn } : {}),
    ...(input.preStep ? { preStep: input.preStep } : {}),
    ...(input.inputQueue
      ? {
          getTurnPrompt: async () =>
            renderAgentInputQueueEntries(
              await input.inputQueue!.consumeForTurn(32, input.inputQueueScope)
            ),
        }
      : {}),
    ...(seams.backend ? { backend: seams.backend } : {}),
    ...(seams.maxTurns !== undefined ? { maxTurns: seams.maxTurns } : {}),
    ...(seams.wallClockScheduler ? { wallClockScheduler: seams.wallClockScheduler } : {}),
    ...(seams.now ? { now: seams.now } : {}),
  };

  // KD-03 restore contract: reconstruct state purely from the journal first. A
  // persisted `active` goal (prior process died mid-turn) comes back `paused`.
  const restored = journal.restore().goal;
  const isOurs = restored?.goalId === goalId;

  let result;
  if (isOurs && restored && restored.state === 'blocked') {
    // A prior run already settled + escalated this goal — do not re-run it.
    return {
      goalId,
      finalState: restored.state,
      goal: restored,
      turnsRun: 0,
      persisted: restored,
      escalated: true,
    };
  } else if (isOurs && restored && restored.state === 'paused') {
    // Resume path: without an explicit resume the driver returns at once and the
    // goal does NOT self-advance (it stays paused).
    result = await runGoalDrivenLoop({
      ...loopOptions,
      resumeFrom: restored,
      resume: seams.resume === true,
    });
  } else {
    // Fresh pursuit: checkpoint an `active` goal BEFORE the loop, so a mid-turn
    // kill leaves the journal holding an `active` record that restores as
    // `paused` on the next invocation.
    journal.recordGoal(
      createGoal({
        goalId,
        objective,
        missionId,
        ...(budget ? { budget } : {}),
        ...(seams.now ? { now: seams.now } : {}),
      })
    );
    result = await runGoalDrivenLoop(loopOptions);
  }

  persistGoalTerminal(journal, goalId, result);

  return {
    goalId: result.goalId,
    finalState: result.finalState,
    goal: result.goal,
    turnsRun: result.turnsRun,
    persisted: result.persisted,
    escalated: result.finalState === 'blocked',
    ...(result.finalReport !== undefined ? { finalReport: result.finalReport } : {}),
  };
}

/**
 * Goal-driven dispatch branch: claims the work item, runs the autonomous goal
 * loop through the real worker seams, and maps the terminal goal state onto the
 * work-item lifecycle (complete → done, blocked → blocked+escalated, paused →
 * planned for a later resume). Only reached when `task.goal_driven` is set; the
 * default single-shot path is untouched.
 */
/**
 * KP-01: goal-driven dispatch's context-pack provisioning. Renders the pack
 * as `form: 'system_prompt'` — a role-scoped, compact rendering meant to be
 * passed once as `systemPrompt` and reused as a stable prefix across every
 * turn (KD-08 prompt-cache discipline; see `runGoalDrivenWorkItem`'s
 * `systemPrompt` doc comment). Persists the pack the same way the single-shot
 * path does (`saveMissionContextPack`, via `provisionTaskKnowledge`'s
 * `missionPath`).
 *
 * Fails open by design: any provisioning error (invalid mission state,
 * schema violation, I/O failure) is logged and swallowed here so a knowledge
 * outage never blocks dispatch — the goal loop already tolerates an absent
 * `systemPrompt` (it is optional on `RunGoalDrivenLoopOptions`). Exported so
 * this seam can be exercised hermetically, same rationale as
 * `runGoalDrivenWorkItem`.
 */
export async function provisionGoalDrivenTaskKnowledge(input: {
  missionId: string;
  task: PlannedNextTask;
  teamRole: string;
  agentId: string;
  workItem: WorkItem;
}): Promise<{
  systemPrompt?: string;
  missionContextPackPath?: string;
  contextPackId?: string;
  securityScope?: import('./context-security-scope.js').ContextSecurityScope;
  /** KP-05: knowledge actually delivered to this goal-driven dispatch, if any. */
  deliveredKnowledgeRefs: DeliveredKnowledgeRef[];
}> {
  try {
    const missionStateRaw = loadMissionStateSnapshot(input.missionId);
    const tier =
      missionStateRaw && typeof missionStateRaw === 'object'
        ? (missionStateRaw as Record<string, unknown>).tier
        : undefined;
    const provisioned = await provisionTaskKnowledge({
      form: 'system_prompt',
      missionPath: missionDir(input.missionId, 'public'),
      missionId: input.missionId,
      tier: (tier as 'personal' | 'confidential' | 'public') || 'public',
      recipientKind: 'agent',
      teamRole: input.teamRole,
      assigneePeerId: input.agentId,
      // KP-04: same scope-linked budget as the single-shot path.
      ...(input.task.estimated_scope ? { estimatedScope: input.task.estimated_scope } : {}),
      workItem: input.workItem,
    });
    if (!provisioned.pack) return { deliveredKnowledgeRefs: [] };
    return {
      systemPrompt: provisioned.text,
      ...(provisioned.missionContextPackPath
        ? { missionContextPackPath: provisioned.missionContextPackPath }
        : {}),
      ...(provisioned.pack?.context_pack_id
        ? { contextPackId: provisioned.pack.context_pack_id }
        : {}),
      ...(provisioned.pack?.security_scope
        ? { securityScope: provisioned.pack.security_scope }
        : {}),
      deliveredKnowledgeRefs: provisioned.deliveredKnowledgeRefs,
    };
  } catch (err: any) {
    logger.warn(
      `[MISSION_WORKER] Task knowledge provisioning failed for goal-driven dispatch ${input.missionId}/${input.task.task_id}; proceeding without a context pack: ${err?.message || err}`
    );
    return { deliveredKnowledgeRefs: [] };
  }
}

export async function dispatchGoalDrivenMissionTask(
  input: {
    missionId: string;
    task: PlannedNextTask;
    teamRole: string;
    assignment: {
      agent_id: string;
      model_hint?: { model_id?: string; tier?: string; effort?: string; route_reason?: string };
    };
  },
  traceCtx: TraceContext
): Promise<DispatchMissionTaskOutcome | null> {
  const workItemSourceRef = `mission:${input.missionId}:${input.task.task_id}:goal`;
  const workItem = importExternalWorkItem({
    source: 'local',
    sourceRef: workItemSourceRef,
    title: input.task.description || input.task.task_id,
    description: input.task.description || input.task.task_id,
    status: 'ready',
    priority: 'normal',
    projectId: input.missionId,
    assigneePeerId: input.assignment.agent_id,
    labels: [`mission:${input.missionId}`, `team_role:${input.teamRole}`, 'goal_driven'],
    dependencies: Array.isArray(input.task.dependencies) ? input.task.dependencies : [],
    metadata: {
      deliverable: input.task.deliverable,
      target_path: input.task.target_path,
      task_id: input.task.task_id,
      mission_id: input.missionId,
      goal_driven: true,
    },
  });
  const claimed = claimWorkItem({
    itemId: workItem.item_id,
    actorPeerId: 'mission-orchestration-worker',
    purpose: `goal-driven dispatch ${input.missionId}/${input.task.task_id}`,
    expectedVersion: workItem.version,
    idempotencyKey: workItemSourceRef,
    metadata: {
      mission_id: input.missionId,
      task_id: input.task.task_id,
      team_role: input.teamRole,
      goal_driven: true,
    },
  });

  // KP-01: provision the mission context pack as a stable system-prompt
  // prefix for the goal loop. Fail-open — see provisionGoalDrivenTaskKnowledge.
  const { systemPrompt, contextPackId, securityScope, deliveredKnowledgeRefs } =
    await provisionGoalDrivenTaskKnowledge({
      missionId: input.missionId,
      task: input.task,
      teamRole: input.teamRole,
      agentId: input.assignment.agent_id,
      workItem,
    });
  // KP-05: report what the goal loop's stable prefix actually delivered so
  // the dispatch trace's knowledgeRefs are non-empty for this path too — see
  // attachDeliveredKnowledgeRefs.
  attachDeliveredKnowledgeRefs(traceCtx, deliveredKnowledgeRefs);

  const outcome = await runGoalDrivenWorkItem({
    missionId: input.missionId,
    task: input.task,
    teamRole: input.teamRole,
    agentId: input.assignment.agent_id,
    ...(systemPrompt ? { systemPrompt } : {}),
    inputQueue: getMissionAgentInputQueue({ missionId: input.missionId }),
    inputQueueScope: {
      taskId: input.task.task_id,
      agentId: input.assignment.agent_id,
      sessionId: goalIdForWorkItem(input.missionId, input.task.task_id),
    },
    seams: {
      scopedInjectionRegistry: getMissionScopedDynamicInjectionRegistry(input.missionId),
      injectionScope: {
        mission: input.missionId,
        task: input.task.task_id,
        session: goalIdForWorkItem(input.missionId, input.task.task_id),
      },
    },
    onPromptVisible: (content, form) =>
      recordMissionVisiblePrompt({
        missionId: input.missionId,
        taskId: input.task.task_id,
        content,
        form,
        ...(contextPackId ? { contextPackId } : {}),
        knowledgeRefs: deliveredKnowledgeRefs,
        securityScope,
      }),
  });

  const baseOutcome: DispatchMissionTaskOutcome = {
    task_id: input.task.task_id,
    team_role: input.teamRole,
    agent_id: input.assignment.agent_id,
    dispatched: outcome.finalState === 'complete',
    rollup_used: false,
    result_schema_ok: outcome.finalState === 'complete',
    needs_count: 0,
  };

  if (outcome.finalState === 'complete') {
    updateWorkItem({
      itemId: claimed.item.item_id,
      expectedVersion: claimed.item.version,
      status: 'done',
      metadata: {
        summary: outcome.goal.terminalReason || input.task.description || input.task.task_id,
        mission_id: input.missionId,
        task_id: input.task.task_id,
        team_role: input.teamRole,
        goal_id: outcome.goalId,
        goal_turns: outcome.turnsRun,
      },
    });
    input.task.status = 'completed';
    emitMissionTaskEvent({
      event_type: 'task_completed',
      mission_id: input.missionId,
      task_id: input.task.task_id,
      agent_id: input.assignment.agent_id,
      team_role: input.teamRole,
      decision: 'task_completed',
      why: 'Goal-driven work item reached structured completion.',
      policy_used: 'mission_orchestration_control_plane_v1',
      evidence: input.task.deliverable ? [String(input.task.deliverable)] : [],
      payload: {
        description: input.task.description,
        deliverable: input.task.deliverable,
        goal_id: outcome.goalId,
        goal_turns: outcome.turnsRun,
      },
    });
    return baseOutcome;
  }

  if (outcome.finalState === 'blocked') {
    updateWorkItem({
      itemId: claimed.item.item_id,
      expectedVersion: claimed.item.version,
      status: 'blocked',
      metadata: {
        summary: outcome.goal.terminalReason || input.task.description || input.task.task_id,
        blocked_reason: outcome.goal.terminalReason || 'goal blocked',
        mission_id: input.missionId,
        task_id: input.task.task_id,
        team_role: input.teamRole,
        goal_id: outcome.goalId,
      },
    });
    input.task.status = 'blocked';
    // The blocker was already escalated to the mission owner inside
    // runGoalDrivenLoop (mission_event + reportBlockerToMission); mirror it onto
    // the task-event stream so it is visible in the task board too.
    emitMissionTaskEvent({
      event_type: 'task_reviewed',
      mission_id: input.missionId,
      task_id: input.task.task_id,
      agent_id: input.assignment.agent_id,
      team_role: input.teamRole,
      decision: 'task_reviewed',
      why: 'Goal-driven work item reported a persistent blocker.',
      policy_used: 'mission_orchestration_control_plane_v1',
      evidence: input.task.deliverable ? [String(input.task.deliverable)] : [],
      payload: {
        description: input.task.description,
        deliverable: input.task.deliverable,
        goal_id: outcome.goalId,
        blocker: outcome.goal.terminalReason,
        ...(outcome.finalReport ? { final_report: outcome.finalReport } : {}),
      },
    });
    return { ...baseOutcome, dispatched: false };
  }

  // paused (technical stop / max-turns / resume halt): reset for a later resume.
  input.task.status = 'planned';

  releaseWorkItem({
    itemId: claimed.item.item_id,
    expectedVersion: claimed.item.version,
    leaseId: claimed.lease.lease_id,
    actorPeerId: 'mission-orchestration-worker',
    summary: outcome.goal.terminalReason || input.task.description || input.task.task_id,
    metadata: {
      mission_id: input.missionId,
      task_id: input.task.task_id,
      team_role: input.teamRole,
      goal_id: outcome.goalId,
      paused_reason: outcome.goal.terminalReason || 'goal paused',
    },
  });
  return { ...baseOutcome, dispatched: false };
}

// KP-05: mission-task dispatch tracing. `persistTrace` writes to the same
// day-rotated `traces-*.jsonl` store actuator/pipeline flows use
// (`traceLogDir()`, `active/shared/logs/traces/` or the active customer's
// equivalent) — no new tracer or persistence path is invented here, only a
// dir-override seam for hermetic tests (mirrors `KYBERION_KNOWLEDGE_DELIVERY_DIR`
// in `src/knowledge-feedback-loop.ts`).
export let warnedMissionTaskTraceFailureOnce = false;

export function missionTaskTraceDirOverride(): string | undefined {
  const override = getRegisteredEnvText('KYBERION_MISSION_TASK_TRACE_DIR')?.trim();
  return override ? pathResolver.rootResolve(override) : undefined;
}

export function warnMissionTaskTraceFailureOnce(context: string, error: unknown): void {
  if (warnedMissionTaskTraceFailureOnce) return;
  warnedMissionTaskTraceFailureOnce = true;
  const message = error instanceof Error ? error.message : String(error);
  logger.warn(`[MISSION_WORKER][KP-05] ${context}: ${message}`);
}

/**
 * Attach delivered knowledge to the current dispatch trace span. `knowledgeRefs`
 * (the trace schema field, `src/trace.ts`) is `string[]` — paths only — so
 * paths go there; per-ref scores ride along on a companion event's
 * attributes (`TraceEvent.attributes` already supports arbitrary
 * string/number/boolean values, unlike `knowledgeRefs` which every consumer,
 * e.g. chronos-mirror-v2's TraceViewer, expects to stay a plain string array).
 * Never throws — a tracing failure must never affect dispatch.
 */
export function attachDeliveredKnowledgeRefs(
  traceCtx: TraceContext,
  refs: DeliveredKnowledgeRef[] | undefined
): void {
  if (!refs || refs.length === 0) return;
  try {
    for (const ref of refs) traceCtx.addKnowledgeRef(ref.path);
    traceCtx.addEvent('knowledge_delivered', {
      knowledge_ref_count: refs.length,
      knowledge_refs_scored: JSON.stringify(
        refs.map((ref) => ({ path: ref.path, score: ref.score ?? null }))
      ),
    });
  } catch (err: any) {
    warnMissionTaskTraceFailureOnce(
      `Failed to attach delivered knowledge refs to mission task trace`,
      err
    );
  }
}

/**
 * Record the dispatch outcome on the trace span and persist it. Called from
 * `dispatchPlannedMissionTask`'s `finally` so it runs for every branch
 * (success, blocked, rework, busy-retry-null) without threading trace
 * bookkeeping through each of `dispatchPlannedMissionTaskCore`'s many return
 * points. Fail-open: any error here (span attribute, finalize, or persist)
 * is caught and warned once — it must never surface to the dispatch caller.
 */
export function finalizeMissionTaskTrace(
  traceCtx: TraceContext,
  input: Pick<DispatchPlannedMissionTaskInput, 'task' | 'teamRole'>,
  outcome: DispatchMissionTaskOutcome | null,
  gapRecorder?: GapRecorder
): void {
  try {
    const gapPhases = gapRecorder ? sanitizeGapSamples(gapRecorder.samples()) : [];
    traceCtx.setAttributes({
      task_id: input.task.task_id,
      team_role: input.teamRole,
      dispatched: outcome?.dispatched ?? false,
      result_schema_ok: outcome?.result_schema_ok ?? false,
      ...(gapPhases.length
        ? { gap_phase_total_ms: gapPhases.reduce((sum, item) => sum + item.ms, 0) }
        : {}),
    });
    if (gapPhases.length) {
      traceCtx.addEvent('gap_phases', {
        gap_phases: JSON.stringify(gapPhases),
        gap_phase_total_ms: gapPhases.reduce((sum, item) => sum + item.ms, 0),
      });
    }
    const trace = traceCtx.finalize();
    const dirOverride = missionTaskTraceDirOverride();
    persistTrace(trace, dirOverride ? { dir: dirOverride } : undefined);
  } catch (err: any) {
    warnMissionTaskTraceFailureOnce('Failed to persist mission task dispatch trace', err);
  }
}

export interface DispatchPlannedMissionTaskInput {
  missionId: string;
  task: PlannedNextTask;
  teamRole: string;
  assignment: {
    agent_id: string;
    authority_role?: string | null;
    model_hint?: { model_id?: string; tier?: string; effort?: string; route_reason?: string };
    organization_role_id?: string;
    perspective_ids?: string[];
    reasoning_route_id?: string;
    selection_reason_codes?: string[];
    provider?: string | null;
    modelId?: string | null;
  };
  allTasks: PlannedNextTask[];
  upstreamHandoffs?: Array<MissionGraphHandoff<DispatchMissionTaskOutcome, TaskResultBlock>>;
  /** PI-15: queue data captured once before a single-shot dispatch/retry pair. */
  queuedInputPrompt?: string;
  iterationPolicy: {
    max_rework_attempts: number;
    max_review_rounds: number;
  };
}

/**
 * KP-05: open a `mission_task_dispatch` trace span around a single task
 * dispatch (single-shot or goal-driven), attach whatever knowledge was
 * delivered into it, and persist the trace next to actuator/pipeline traces
 * (`persistTrace`, same JSONL store as `createActuatorTrace` in
 * `actuator-trace.ts`). Tracing is entirely best-effort: a failure anywhere
 * in this wrapper (span creation, attribute recording, persistence) is
 * caught in `finalizeMissionTaskTrace` and logged once — it must never
 * affect the dispatch outcome itself, which is why the real dispatch work
 * happens in `dispatchPlannedMissionTaskCore` / `dispatchGoalDrivenMissionTask`
 * and only the trace bookkeeping wraps it.
 */
/**
 * NI-02: resolve the worker's canonical nhi_id for trace attribution.
 * Prefers the ledger-backed identity NI-01 stamped on the live runtime
 * registry record at spawn; falls back to the deterministic name derivation
 * when the runtime is not up yet (dispatch opens its trace before
 * ensure/spawn). Best-effort — attribution must never affect dispatch.
 */
export function resolveDispatchActorNhiId(agentId: string): string | undefined {
  try {
    return agentRegistry.getRuntimeIdentity?.(agentId) ?? deriveAgentNhiId(agentId) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * NI-03: originate the mission dispatch delegation chain, root-first:
 *
 *   [0] the orchestrator (this worker's control loop) — its nhi_id when
 *       derivable, else the legacy 'kyberion:mission-orchestrator' actor.
 *       Its `granted_scope` is deliberately UNRESTRICTED: the orchestrator
 *       grants out of mission authority, not out of its own KD-05 execution
 *       tier (which is 'planner' — it never executes tools itself; encoding
 *       that tier here would make every implementer dispatch an attenuation
 *       violation).
 *   [1] the dispatched worker agent — its nhi_id (NI-01 runtime identity or
 *       derivation), its team_role, and the KD-05 capability tier that team
 *       role projects onto (resolveCapabilityProfileForTeamRole).
 *
 * Each further hop (worker → sub-worker) appends its own link in
 * agent-dispatch.ts. Best-effort by contract: chain origination must never
 * affect dispatch, so any failure returns undefined (chain-less legacy
 * behavior) rather than throwing.
 */
export function originateMissionDispatchDelegationChain(input: {
  teamRole: string;
  agentId: string;
}): DelegationChain | undefined {
  try {
    const orchestratorActor =
      resolveDispatchActorNhiId('mission-orchestrator') ?? 'kyberion:mission-orchestrator';
    const workerActor = resolveDispatchActorNhiId(input.agentId) ?? input.agentId;
    const workerTier = resolveCapabilityProfileForTeamRole(
      canonicalizeTeamRole(input.teamRole)
    ) as DelegationCapabilityTier;
    let chain = appendDelegationLink(
      [],
      buildDelegationLink({
        actor: orchestratorActor,
        team_role: 'orchestrator',
        granted_scope: {},
      })
    );
    chain = appendDelegationLink(
      chain,
      buildDelegationLink({
        actor: workerActor,
        team_role: input.teamRole,
        granted_scope: { capability_tier: workerTier },
      })
    );
    const attenuation = validateChainAttenuation(chain);
    if (!attenuation.ok) {
      logger.warn(
        `[MISSION_WORKER][NI-03] Originated delegation chain failed attenuation (${attenuation.violations.join('; ')}) — dispatching chain-less.`
      );
      return undefined;
    }
    return chain;
  } catch {
    return undefined;
  }
}

export async function dispatchPlannedMissionTask(
  input: DispatchPlannedMissionTaskInput
): Promise<DispatchMissionTaskOutcome | null> {
  // NI-02: stamp actor attribution on the dispatch trace. This is THE trace
  // creation point that knows which agent identity the task is dispatched to
  // (input.assignment.agent_id), so worker-attributed traces carry actorNhiId
  // from here without any per-call-site changes elsewhere.
  const actorNhiId = resolveDispatchActorNhiId(input.assignment.agent_id);
  // NI-03: originate the delegation chain at THE dispatch point (same
  // neighborhood as the NI-02 actorNhiId stamp) and record on the trace who
  // the dispatched work is ultimately done on behalf of — the chain's root
  // actor (the orchestrator, until user-rooted chains arrive via SO-03
  // steering sessions).
  const delegationChain = originateMissionDispatchDelegationChain({
    teamRole: input.teamRole,
    agentId: input.assignment.agent_id,
  });
  const gapRecorder = createGapRecorder();
  const onBehalfOf = delegationChain ? delegationChainRootActor(delegationChain) : undefined;
  const traceCtx = new TraceContext('mission_task_dispatch', {
    missionId: input.missionId,
    ...(actorNhiId ? { actorNhiId } : {}),
    ...(onBehalfOf ? { onBehalfOf } : {}),
  });
  let outcome: DispatchMissionTaskOutcome | null = null;
  let agentStartAdmitted = false;
  try {
    // PI-08: expose the governed system-prompt boundary before either the
    // single-shot or goal-driven agent starts. The hook receives metadata and
    // options, never the prompt body; prompt content remains behind the
    // existing visibility ledger at the actual dispatch boundary.
    const beforeAgentStart = await fireLifecycleHooks(
      getDefaultLifecycleHookEngine(),
      'before_agent_start',
      {
        matcher_value: input.task.task_id,
        mission_id: input.missionId,
        task_id: input.task.task_id,
        team_role: input.teamRole,
        agent_id: input.assignment.agent_id,
        systemPromptOptions: {
          missionId: input.missionId,
          taskId: input.task.task_id,
          teamRole: input.teamRole,
          agentId: input.assignment.agent_id,
          goalDriven: input.task.goal_driven === true,
          modelHint: input.assignment.model_hint,
          promptVisibility: 'ledgered',
        },
      }
    );
    if (beforeAgentStart.blocked) {
      throw new Error(
        `[HOOK_BLOCKED] before_agent_start blocked task ${input.task.task_id}: ${beforeAgentStart.reasons.join('; ')}`
      );
    }
    agentStartAdmitted = true;
    const missionInputQueue = getMissionAgentInputQueue({ missionId: input.missionId });
    const queuedInputPrompt = input.task.goal_driven
      ? undefined
      : renderAgentInputQueueEntries(
          await missionInputQueue.consumeForTurn(32, {
            taskId: input.task.task_id,
            agentId: input.assignment.agent_id,
          })
        );
    // KD-01 adoption: opt-in goal-driven execution runs a separate autonomous
    // loop instead of the single-shot dispatch below. Default OFF — the rest
    // of dispatchPlannedMissionTaskCore is unchanged when `goal_driven` is unset.
    const { dispatchPlannedMissionTaskCore } =
      await import('./mission-orchestration-worker-part-core.js');
    outcome = input.task.goal_driven
      ? await dispatchGoalDrivenMissionTask(
          {
            missionId: input.missionId,
            task: input.task,
            teamRole: input.teamRole,
            assignment: input.assignment,
          },
          traceCtx
        )
      : await dispatchPlannedMissionTaskCore(
          { ...input, ...(queuedInputPrompt ? { queuedInputPrompt } : {}) },
          traceCtx,
          delegationChain,
          gapRecorder
        );
    return outcome;
  } finally {
    // PI-08: this is the mission-worker receipt point. All retry, prompt
    // compaction, goal turns, acceptance review, and rework decisions inside
    // the dispatch have completed before this observer runs. A settled hook
    // cannot change the already-finalized task outcome.
    if (agentStartAdmitted) {
      try {
        const settled = await fireLifecycleHooks(getDefaultLifecycleHookEngine(), 'task_settled', {
          matcher_value: input.task.task_id,
          mission_id: input.missionId,
          task_id: input.task.task_id,
          team_role: input.teamRole,
          agent_id: input.assignment.agent_id,
          status: outcome ? (outcome.dispatched ? 'succeeded' : 'blocked') : 'failed',
        });
        if (settled.blocked) {
          logger.warn(
            `[PI-08] task_settled observer blocked after mission task finalization: ${settled.reasons.join('; ')}`
          );
        }
      } catch (err) {
        logger.warn(
          `[PI-08] task_settled observer failed after mission task finalization: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    finalizeMissionTaskTrace(traceCtx, input, outcome, gapRecorder);
  }
}
