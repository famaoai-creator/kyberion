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
  workerBackendsInstalled,
  ensureWorkerBackendsInstalled,
  emitWorkerTransitionSnapshot,
  recordWorkerIntentDriftObservation,
  emitWorkerKickoffSnapshot,
  MISSION_CONTROLLER_TIMEOUT_MS,
  missionProgressController,
  areTaskDependenciesSatisfied,
  buildUnassignedRoleSummary,
  summarizeTaskResultForPrompt,
  buildUpstreamResultLines,
  buildGraphHandoffLines,
  buildTeamSnapshotLines,
  buildReviewFindingsLines,
  dispatchCompactors,
  compactionWorkingMemory,
  buildDispatchCarryover,
  buildDelegationNotificationLines,
  maybeCompactDispatchSections,
  TASK_EVENT_STATUS_MAP,
  resolveMissionType,
  runMissionController,
  recordMissionContextTask,
  taskResultFilePath,
  taskClarificationFilePath,
  summarizeTaskResultObservability,
  buildMissionGoalLines,
  buildRejectionLessonLines,
  buildAuthorityRoleProcedureInjectionProvider,
  buildTaskExecutionPrompt,
  NEEDS_KNOWLEDGE_RETRIEVAL_LIMIT,
  buildNeedsKnowledgeReinforcementLines,
  buildTaskResultRetryPrompt,
  parseTaskResultResponse,
  buildTaskClarificationPacket,
  looksLikePath,
  evaluateTaskAcceptanceGate,
  requestIndependentAcceptanceReview,
} from './mission-orchestration-worker-part-context.js';
import {
  buildTaskDispatchContext,
  TASK_DISPATCH_TIMEOUT_MS,
  resolveTaskDispatchTimeoutMs,
  withTaskDispatchTimeout,
  cascadeBlockedDependents,
  goalDrivenObjective,
  goalIdForWorkItem,
  goalJournalPath,
  resolveGoalBudget,
  persistGoalTerminal,
  runGoalDrivenWorkItem,
  provisionGoalDrivenTaskKnowledge,
  dispatchGoalDrivenMissionTask,
  warnedMissionTaskTraceFailureOnce,
  missionTaskTraceDirOverride,
  warnMissionTaskTraceFailureOnce,
  attachDeliveredKnowledgeRefs,
  finalizeMissionTaskTrace,
  resolveDispatchActorNhiId,
  originateMissionDispatchDelegationChain,
  dispatchPlannedMissionTask,
} from './mission-orchestration-worker-part-dispatch.js';
import { dispatchPlannedMissionTaskCore } from './mission-orchestration-worker-part-core.js';
import {
  stampTaskResultProvenance,
  recordMissionVisiblePrompt,
  taskResultResponseDeps,
  obtainTaskResultResponse,
  isDraftRefineCandidate,
  applyDraftRefineToDeliverable,
  isBestOfNCandidate,
  BEST_OF_APPROACHES,
  parseBestOfJudgeVerdict,
  obtainBestOfTaskResultResponse,
  publishTaskPrArtifacts,
  REVIEW_DIFF_MAX_LINES,
  buildReviewDiffLines,
  syncPlanningArtifacts,
  persistPlanningPacket,
  loadPlannedNextTasks,
  loadAllNextTasks,
  writeNextTasks,
  restoreMissionGraphRunTaskSnapshots,
  reconcileMissionProgress,
  markTaskBoardInProgress,
  dispatchCoreDeps,
  dispatchMissionNextTasksCore,
  dispatchMissionNextTasks,
  summarizeMissionTaskOutcomes,
  missionLifecycleHandlerDeps,
  processMissionOrchestrationEventPath,
} from './mission-orchestration-worker-part-results.js';
export type { DispatchMissionTaskOutcome } from './mission-orchestration-worker-part-context.js';
export type { GoalDrivenWorkItemSeams } from './mission-orchestration-worker-part-dispatch.js';
export type { GoalDrivenWorkItemResult } from './mission-orchestration-worker-part-dispatch.js';

export {
  buildDispatchCarryover,
  buildDelegationNotificationLines,
  maybeCompactDispatchSections,
  resolveTaskDispatchTimeoutMs,
  cascadeBlockedDependents,
  goalIdForWorkItem,
  runGoalDrivenWorkItem,
  provisionGoalDrivenTaskKnowledge,
  isDraftRefineCandidate,
  isBestOfNCandidate,
  persistPlanningPacket,
  reconcileMissionProgress,
  dispatchMissionNextTasks,
  processMissionOrchestrationEventPath,
};
