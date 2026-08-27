import { a2aBridge } from './a2a-bridge.js';
import { readHintsByCategory } from './src/feedback-loop.js';
import { resolveMissionTeamReceiver } from './mission-team-plan-composer.js';
import { resolveQuestionInteractionPacket } from './question-resolver.js';
import { parsePlanningReviewVerdict } from './mission-planning-packet.js';
import { extractSurfaceBlocks } from './surface-response-blocks.js';
import { renderStructuredOutputSchemaPrompt } from './structured-output-contracts.js';
import { evaluateMissionGate, writeMissionGateRecord } from './mission-gate-engine.js';
import { logger } from './core.js';
import { type DynamicInjectionProvider } from './dynamic-injection.js';
import { buildExecutionEnv } from './authority.js';
import { missionDir, missionEvidenceDir } from './path-resolver.js';
import { pathResolver } from './path-resolver.js';
import { type MissionContextPackPruningSummary } from './mission-context-pack.js';
import { appendPromptVisibilityRecord } from './prompt-visibility-ledger.js';
import {
  recordKnowledgeDelivery,
  type DeliveredKnowledgeRef,
} from './src/knowledge-feedback-loop.js';
import { findRelevantDistilledKnowledge } from './distill-knowledge-injector.js';
import * as nodePath from 'node:path';
import * as path from 'node:path';
import { safeExec, safeExistsSync, safeReadFile } from './secure-io.js';
import { emitMissionTaskEvent } from './mission-task-events.js';
import { createMissionProgressController } from './mission-orchestration-progress.js';
import {
  resolvePhaseGateMode,
  summarizeMissionGateState,
} from './mission-orchestration-phase-gates.js';
import { validatePlannedNextTasks } from './mission-orchestration-task-validation.js';
import {
  normalizeReviewFindings,
  resolveReviewTargetForTask,
} from './mission-orchestration-artifact-review.js';
export { resolveMissionPlanningPacket } from './mission-orchestration-planning.js';

export {
  evaluateMissionPhaseExitGates,
  loadMissionPhaseGateDefinitions,
  resolvePhaseGateMode,
} from './mission-orchestration-phase-gates.js';
import { emitIntentSnapshot, mapStageToLoopPhase } from './intent-snapshot-store.js';
import { evaluateMissionIntentDrift } from './mission-intent-delta.js';
import { getIntentExtractor } from './intent-extractor.js';
import { installAnthropicBackendsIfAvailable } from './reasoning-bootstrap.js';
import { getReasoningBackend } from './reasoning-backend.js';
import { type MissionGraphHandoff } from './mission-graph-handoff.js';
import { MissionWorkingMemory } from './mission-working-memory.js';
import {
  MAX_CARRYOVER_BACKGROUND_TASKS,
  WorkerContextCompactor,
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
  type PlannedNextTask,
  type SlackPayload,
  type TaskResultBlock,
} from './mission-orchestration-worker-contracts.js';

export let workerBackendsInstalled = false;
export function recordMissionVisiblePrompt(input: {
  missionId: string;
  taskId: string;
  content: string;
  form: string;
  contextPackId?: string;
  knowledgeRefs?: DeliveredKnowledgeRef[];
  securityScope?: import('./context-security-scope.js').ContextSecurityScope;
}): void {
  const tier = input.securityScope?.write_tier || 'public';
  appendPromptVisibilityRecord({
    missionPath: missionDir(input.missionId, tier),
    missionId: input.missionId,
    source: 'mission-orchestration-worker',
    form: input.form,
    content: input.content,
    ...(input.contextPackId ? { contextPackId: input.contextPackId } : {}),
    taskId: input.taskId,
    knowledgeRefs: (input.knowledgeRefs || []).map((ref) => ref.path),
  });
}

export const REVIEW_DIFF_MAX_LINES = 2000;

export function buildReviewDiffLines(missionId: string, task: PlannedNextTask): string[] {
  const role = String(task.assigned_to?.role || '').toLowerCase();
  if (role !== 'reviewer' && role !== 'qa') return [];
  const target = resolveReviewTargetForTask(task);
  if (!target) return [];
  const diffPath = path.join(
    missionDir(missionId, 'public'),
    'evidence',
    'prs',
    target,
    'diff.patch'
  );
  if (!safeExistsSync(diffPath)) return [];
  const diff = String(safeReadFile(diffPath, { encoding: 'utf8' }) || '');
  if (!diff.trim()) return [];
  const lines = diff.split('\n');
  const changedFiles = lines
    .filter((line) => line.startsWith('diff --git '))
    .map((line) => line.replace(/^diff --git a\/(\S+).*$/, '$1'));
  if (lines.length > REVIEW_DIFF_MAX_LINES) {
    return [
      `- Diff under review (evidence/prs/${target}/diff.patch — truncated to first ${REVIEW_DIFF_MAX_LINES} of ${lines.length} lines):`,
      '```diff',
      ...lines.slice(0, REVIEW_DIFF_MAX_LINES),
      '```',
      `- Changed files (${changedFiles.length}):`,
      ...changedFiles.map((file) => `  - ${file}`),
    ];
  }
  return [`- Diff under review (evidence/prs/${target}/diff.patch):`, '```diff', ...lines, '```'];
}

export function ensureWorkerBackendsInstalled(): void {
  if (workerBackendsInstalled) return;
  installAnthropicBackendsIfAvailable();
  workerBackendsInstalled = true;
}

/**
 * Emit a lifecycle intent snapshot for a worker-driven stage transition.
 * Failures are swallowed so the worker's main work path is never blocked
 * by an evidence-writing mishap (e.g. mission evidence dir still being
 * created). The snapshot produces an append-only trail in
 * active/missions/<id>/evidence/intent-snapshots.jsonl and, as soon as
 * two snapshots exist, paired deltas in intent-deltas.jsonl.
 */
export function emitWorkerTransitionSnapshot(
  missionId: string,
  stageKey: string,
  goalHint?: string
): void {
  if (!missionId) return;
  try {
    emitIntentSnapshot({
      missionId,
      stage: stageKey,
      source: 'worker_transition',
      intent: {
        goal:
          goalHint ?? `Mission ${missionId} progressing through ${mapStageToLoopPhase(stageKey)}`,
      },
    });
    recordWorkerIntentDriftObservation(missionId, stageKey);
  } catch (err: any) {
    // evidence dir may not yet exist on very first events; keep worker non-blocking
    logger.warn(
      `[worker] intent snapshot skipped for ${missionId}/${stageKey}: ${err?.message ?? err}`
    );
  }
}

/**
 * IL-03: inspect the original user intent after every worker transition.
 * This is deliberately warn-first: the phase-exit evaluator below is the
 * enforcement boundary, while this record makes drift visible while work is
 * still running instead of only at completion.
 */
export function recordWorkerIntentDriftObservation(missionId: string, stage: string): void {
  if (resolvePhaseGateMode() === 'off') return;
  const summary = evaluateMissionIntentDrift(missionId);
  if (!summary || summary.verdict === 'no_history') return;
  try {
    writeMissionGateRecord({
      missionId,
      gateId: 'INTENT_DRIFT',
      evidenceDir: `${missionDir(missionId, 'public')}/gates`,
      payload: {
        phase: stage,
        position: 'execution',
        source: 'worker_transition',
        verdict: summary.passed ? 'pass' : 'fail',
        reason: summary.message,
        drift_score: summary.drift_score,
        checked_at: summary.checked_at,
      },
    });
  } catch (err: any) {
    logger.warn(
      `[worker] intent drift observation skipped for ${missionId}/${stage}: ${err?.message ?? err}`
    );
  }
  if (!summary.passed) {
    logger.warn(`[worker] intent drift detected for ${missionId}/${stage}: ${summary.message}`);
  }
}

/**
 * Like `emitWorkerTransitionSnapshot` but pulls a real IntentBody out of the
 * Slack payload text via the registered IntentExtractor. Use on the entry
 * transition (`intake`) where the user's original utterance is available —
 * this is the baseline against which later snapshots are compared for drift.
 */
export async function emitWorkerKickoffSnapshot(
  missionId: string,
  payload: SlackPayload
): Promise<void> {
  if (!missionId) return;
  const text = (payload as any)?.text;
  if (!text || typeof text !== 'string' || !text.trim()) {
    emitWorkerTransitionSnapshot(missionId, 'intake', `Mission ${missionId} kickoff requested`);
    return;
  }
  try {
    const intent = await getIntentExtractor().extract({ text });
    emitIntentSnapshot({
      missionId,
      stage: 'intake',
      source: 'user_prompt',
      intent,
    });
  } catch (err: any) {
    logger.warn(
      `[worker] kickoff intent extraction failed for ${missionId}: ${err?.message ?? err}`
    );
    emitWorkerTransitionSnapshot(missionId, 'intake', `Mission ${missionId} kickoff requested`);
  }
}

export const MISSION_CONTROLLER_TIMEOUT_MS = 600_000;

export const missionProgressController = createMissionProgressController({
  validatePlannedNextTasks,
  summarizeMissionGateState,
});

export interface DispatchMissionTaskOutcome {
  task_id: string;
  team_role: string;
  agent_id: string;
  dispatched: boolean;
  allowSameInvocationRedispatch?: boolean;
  redispatchTaskIds?: string[];
  dispatch_error?: string;
  context_chars?: number;
  pruned_chars?: number;
  rollup_used: boolean;
  result_schema_ok: boolean;
  needs_count: number;
}

export function areTaskDependenciesSatisfied(
  task: PlannedNextTask,
  tasks: PlannedNextTask[]
): boolean {
  const dependencies = Array.isArray(task.dependencies)
    ? task.dependencies
        .map((dependency: unknown) => String(dependency || '').trim())
        .filter(Boolean)
    : [];
  if (dependencies.length === 0) return true;
  const statusByTaskId = new Map(
    tasks.map((entry) => [entry.task_id, String(entry.status || 'planned')])
  );
  return dependencies.every((dependency) => statusByTaskId.get(dependency) === 'completed');
}

export function buildUnassignedRoleSummary(task: PlannedNextTask, teamRole?: string): string {
  const roleLabel = teamRole || 'unassigned';
  return `Task ${task.task_id} is blocked because role ${roleLabel} is not assigned.`;
}

export function summarizeTaskResultForPrompt(task: PlannedNextTask): string | null {
  const result = task.last_result;
  if (!result) return null;
  const summary = String(result.summary || '').trim();
  const artifacts = Array.isArray(result.artifacts)
    ? result.artifacts
        .map((artifact) => String(artifact?.path || '').trim())
        .filter(Boolean)
        .join(', ')
    : '';
  const verification = Array.isArray(result.verification_done)
    ? result.verification_done
        .map((entry) => String(entry || '').trim())
        .filter(Boolean)
        .join('; ')
    : '';
  const gaps = Array.isArray(result.gaps)
    ? result.gaps
        .map((entry) => String(entry || '').trim())
        .filter(Boolean)
        .join('; ')
    : '';
  return [
    summary ? `summary=${summary}` : '',
    artifacts ? `artifacts=${artifacts}` : '',
    verification ? `verification=${verification}` : '',
    gaps ? `gaps=${gaps}` : '',
  ]
    .filter(Boolean)
    .join(' / ');
}

export function buildUpstreamResultLines(
  task: PlannedNextTask,
  tasks: PlannedNextTask[]
): string[] {
  const dependencies = Array.isArray(task.dependencies)
    ? task.dependencies.map((dependency) => String(dependency || '').trim()).filter(Boolean)
    : [];
  if (dependencies.length === 0) return ['- none'];
  const byTaskId = new Map(tasks.map((entry) => [entry.task_id, entry]));
  return dependencies.slice(0, 10).map((dependency) => {
    const upstream = byTaskId.get(dependency);
    const role = upstream?.assigned_to?.role || 'unassigned';
    const summary = upstream ? summarizeTaskResultForPrompt(upstream) : null;
    if (!upstream) {
      return `- ${dependency}: missing from NEXT_TASKS.json`;
    }
    if (!summary) {
      const deliverable = upstream.deliverable || upstream.target_path || 'TASK_BOARD';
      return `- ${dependency} [${role}]: completed (result summary unavailable — read the deliverable path from TASK_BOARD; deliverable=${deliverable})`;
    }
    return `- ${dependency} [${role}]: ${summary}`;
  });
}

export function buildGraphHandoffLines(
  handoffs: Array<MissionGraphHandoff<DispatchMissionTaskOutcome, TaskResultBlock>>
): string[] {
  if (handoffs.length === 0) return [];
  return [
    'Graph handoff payloads from direct predecessor tasks (authoritative for this dispatch):',
    ...handoffs.slice(0, 10).map((handoff) => {
      const summary = handoff.task_result
        ? summarizeTaskResultForPrompt({
            task_id: handoff.from_task_id,
            last_result: handoff.task_result,
          } as PlannedNextTask)
        : null;
      return `- ${handoff.from_task_id}: status=${handoff.status}${summary ? ` / ${summary}` : ''}`;
    }),
  ];
}

export function buildTeamSnapshotLines(tasks: PlannedNextTask[]): string[] {
  const lines = tasks.slice(0, 20).map((task) => {
    const role = task.assigned_to?.role || 'unassigned';
    const agent = task.assigned_to?.agent_id || 'unassigned';
    const status = String(task.status || 'planned');
    const symbol =
      status === 'completed'
        ? '✅'
        : status === 'blocked'
          ? '⛔'
          : status === 'reviewed'
            ? '📝'
            : status === 'rework'
              ? '🔁'
              : status === 'accepted'
                ? '✅'
                : '⏳';
    const deliverable = task.deliverable || task.target_path || 'n/a';
    return `- ${task.task_id} [${role}/${agent}] ${symbol} ${status} ${deliverable}`;
  });
  if (tasks.length > 20) {
    lines.push(`... ${tasks.length - 20} more`);
  }
  return lines.length > 0 ? lines : ['- none'];
}

export function buildReviewFindingsLines(task: PlannedNextTask): string[] {
  const findings = normalizeReviewFindings(
    task.review_findings ||
      task.rework_packet?.findings ||
      (task.last_result as TaskResultBlock | undefined)?.review_findings ||
      []
  );
  if (findings.length === 0) return ['- none'];
  return findings
    .slice(0, 10)
    .map((finding) => `- ${finding.severity} @ ${finding.location}: ${finding.instruction}`);
}

// ---------------------------------------------------------------------------
// OH-01: dispatch-context auto-compaction. The mission loop's accumulating
// sections (upstream task results, team snapshot) are treated as the worker
// transcript; the mission context pack and goal are pinned and never elided.
// ---------------------------------------------------------------------------

export const dispatchCompactors = new Map<string, WorkerContextCompactor>();
export const compactionWorkingMemory = new MissionWorkingMemory();

export function buildDispatchCarryover(input: {
  task: PlannedNextTask;
  allTasks: PlannedNextTask[];
  missionGoalLines: string[];
}): CompactionCarryover {
  const settled = input.allTasks.filter((task) =>
    ['completed', 'accepted', 'reviewed'].includes(String(task.status || ''))
  );
  const activeArtifacts = Array.from(
    new Set(
      settled
        .map((task) => task.deliverable || task.target_path || '')
        .map((value) => value.trim())
        .filter(Boolean)
    )
  ).slice(0, 10);
  const verifiedState = settled
    .slice(0, 10)
    .map((task) => `${task.task_id}: ${String(task.status)}`);
  // KC-06: still-running delegated tasks survive the compaction boundary as
  // structured data, so the worker can still reference them post-compaction.
  let activeBackgroundTasks: ActiveBackgroundTaskRef[] = [];
  try {
    activeBackgroundTasks = listActiveDelegatedTaskRecords(MAX_CARRYOVER_BACKGROUND_TASKS).map(
      (record) => ({
        delegation_id: record.delegation_id,
        instruction_excerpt: record.instruction.replace(/\s+/g, ' ').trim().slice(0, 120),
        started_at: record.created_at,
      })
    );
  } catch {
    // Snapshot is best-effort; carryover must never fail dispatch.
  }
  return {
    goal: input.missionGoalLines.filter(Boolean).join(' ').trim() || 'mission goal unavailable',
    active_artifacts: activeArtifacts,
    verified_state: verifiedState,
    next_step: `${input.task.task_id}: ${input.task.description || input.task.deliverable || 'execute assigned task'}`,
    ...(activeBackgroundTasks.length > 0 ? { active_background_tasks: activeBackgroundTasks } : {}),
  };
}

/**
 * KC-06: claim up to 4 pending background-delegation completion notifications
 * and render them as a delimited prompt section. Claiming marks them delivered,
 * so each completion reaches worker context exactly once. Best-effort — a
 * store failure never blocks dispatch.
 */
export function buildDelegationNotificationLines(
  limit = DELEGATION_NOTIFICATION_CLAIM_LIMIT,
  filter: { missionId?: string; taskId?: string; owner?: string } = {}
): string[] {
  try {
    return renderDelegationNotificationLines(claimPendingDelegationNotifications(limit, filter));
  } catch (error) {
    logger.warn(
      `[MISSION_WORKER] delegation notification claim failed (non-fatal): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return [];
  }
}

export async function maybeCompactDispatchSections(input: {
  missionId: string;
  task: PlannedNextTask;
  allTasks: PlannedNextTask[];
  agentId: string;
  missionContextPackText: string;
  missionGoalLines: string[];
  upstreamResultLines: string[];
  teamSnapshotLines: string[];
  securityScope?: import('./context-security-scope.js').ContextSecurityScope;
  force?: boolean;
  reason?: CompactionReason;
}): Promise<{ upstreamResultLines: string[]; teamSnapshotLines: string[] }> {
  let compactor = dispatchCompactors.get(input.missionId);
  if (!compactor) {
    compactor = new WorkerContextCompactor({
      missionId: input.missionId,
      writerAgent: 'mission-orchestration-worker',
      workingMemory: compactionWorkingMemory,
      summarize: async (transcript) => {
        const summaryPrompt = [
          'Summarize this mission worker history for a successor agent.',
          'Keep: completed work, artifact paths, verified outcomes, unresolved blockers, and immediate next steps. Be concise and factual.',
          '',
          transcript,
        ].join('\n');
        recordMissionVisiblePrompt({
          missionId: input.missionId,
          taskId: `${input.task.task_id}-compaction`,
          content: summaryPrompt,
          form: 'compaction_summary',
          securityScope: input.securityScope,
        });
        return getReasoningBackend().prompt(summaryPrompt);
      },
    });
    dispatchCompactors.set(input.missionId, compactor);
  }
  const TEAM_SNAPSHOT_SECTION = 'team-snapshot';
  const messages: WorkerContextMessage[] = [
    { role: 'system', content: input.missionContextPackText, pinned: true, pairId: 'context-pack' },
    {
      role: 'user',
      content: input.missionGoalLines.join('\n'),
      pinned: true,
      pairId: 'mission-goal',
    },
    ...input.upstreamResultLines.map((line) => ({
      role: 'tool_result' as const,
      content: line,
    })),
    {
      role: 'assistant' as const,
      content: input.teamSnapshotLines.join('\n'),
      pairId: TEAM_SNAPSHOT_SECTION,
    },
  ];
  const evidenceDir = missionEvidenceDir(input.missionId);
  const result = await compactor.maybeCompact(messages, {
    carryover: buildDispatchCarryover(input),
    taskId: input.task.task_id,
    ...(evidenceDir ? { summaryDir: path.join(evidenceDir, 'compaction') } : {}),
    ...(input.force ? { force: true } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
  });
  if (!result.compacted) {
    return {
      upstreamResultLines: input.upstreamResultLines,
      teamSnapshotLines: input.teamSnapshotLines,
    };
  }
  try {
    emitMissionTaskEvent({
      event_type: 'participant_context_resolved',
      mission_id: input.missionId,
      task_id: input.task.task_id,
      agent_id: input.agentId,
      decision: 'context_compacted',
      why: 'Dispatch context exceeded the token-window threshold; applied OH-01 auto-compaction.',
      policy_used: 'worker_context_compaction_v1',
      evidence: result.summaryArtifactPath ? [result.summaryArtifactPath] : [],
      payload: {
        stage: result.stage,
        tokens_before: result.tokensBefore,
        tokens_after: result.tokensAfter,
        threshold_tokens: result.thresholdTokens,
        ...(result.summaryError ? { summary_error: result.summaryError } : {}),
      },
    });
  } catch (eventError) {
    logger.warn(
      `[MISSION_WORKER] context_compacted event emission failed (non-fatal): ${
        eventError instanceof Error ? eventError.message : String(eventError)
      }`
    );
  }
  const survivingTeamSnapshot = result.messages.find(
    (message) => message.pairId === TEAM_SNAPSHOT_SECTION
  );
  const pinnedSections = new Set(['context-pack', 'mission-goal', TEAM_SNAPSHOT_SECTION]);
  const compactedUpstreamLines = result.messages
    .filter((message) => !pinnedSections.has(message.pairId ?? ''))
    .map((message) => message.content);
  return {
    upstreamResultLines: compactedUpstreamLines.length > 0 ? compactedUpstreamLines : ['- none'],
    teamSnapshotLines: survivingTeamSnapshot
      ? survivingTeamSnapshot.content.split('\n')
      : ['- (older team activity included in the compaction summary above)'],
  };
}

export type OperatorInteractionPacket = NonNullable<
  ReturnType<typeof resolveQuestionInteractionPacket>
>;

export const TASK_EVENT_STATUS_MAP: Partial<
  Record<
    NonNullable<PlannedNextTask['status']>,
    'task_reviewed' | 'task_completed' | 'task_accepted'
  >
> = {
  reviewed: 'task_reviewed',
  completed: 'task_completed',
  accepted: 'task_accepted',
};

export function resolveMissionType(payload: SlackPayload): string {
  if (typeof payload.missionType === 'string' && payload.missionType.trim()) {
    return payload.missionType;
  }
  const proposalMissionType = payload.proposal?.mission_type;
  return typeof proposalMissionType === 'string' && proposalMissionType.trim()
    ? proposalMissionType
    : 'development';
}

export function runMissionController(env: NodeJS.ProcessEnv, args: string[]) {
  return safeExec('node', ['dist/scripts/mission_controller.js', ...args], {
    env,
    timeoutMs: MISSION_CONTROLLER_TIMEOUT_MS,
  });
}

export function recordMissionContextTask(
  missionId: string,
  description: string,
  details: Record<string, unknown>
): void {
  try {
    const env = buildExecutionEnv(process.env, 'mission_controller');
    runMissionController(env, ['record-task', missionId, description, JSON.stringify(details)]);
  } catch (err: any) {
    logger.warn(`[worker] record-task skipped for ${missionId}: ${err?.message ?? err}`);
  }
}

export function taskResultFilePath(missionId: string, taskId: string): string {
  return `${missionDir(missionId, 'public')}/evidence/task-result-${taskId}.json`;
}

export function taskClarificationFilePath(missionId: string, taskId: string): string {
  return `${missionDir(missionId, 'public')}/evidence/task-clarification-${taskId}.json`;
}

export function summarizeTaskResultObservability(input: {
  pruning?: MissionContextPackPruningSummary;
  taskResult?: TaskResultBlock;
  parseErrors: string[];
}): {
  context_chars?: number;
  pruned_chars?: number;
  rollup_used: boolean;
  result_schema_ok: boolean;
  needs_count: number;
} {
  const contextChars = input.pruning?.estimated_chars;
  const prunedChars = input.pruning
    ? Math.max(0, input.pruning.estimated_chars - input.pruning.budget_chars)
    : undefined;
  const needsCount = input.taskResult?.needs?.length || 0;
  return {
    ...(typeof contextChars === 'number' && Number.isFinite(contextChars)
      ? { context_chars: contextChars }
      : {}),
    ...(typeof prunedChars === 'number' && Number.isFinite(prunedChars)
      ? { pruned_chars: prunedChars }
      : {}),
    rollup_used: Boolean(input.pruning?.rollup_path),
    result_schema_ok: Boolean(
      input.taskResult && input.parseErrors.length === 0 && needsCount === 0
    ),
    needs_count: needsCount,
  };
}

/**
 * The mission's interpreted goal (why the work exists — not the task wording).
 * Without this section every worker optimizes for its task's 字面 and the
 * team drifts from the user's actual purpose (IL-01/E2E-03 follow-up).
 */
export function buildMissionGoalLines(missionState: Record<string, unknown>): string[] {
  const intent = (missionState?.intent || {}) as {
    goal_summary?: string;
    success_condition?: string;
  };
  const outcome = (missionState?.outcome_contract || {}) as {
    requested_result?: string;
    success_criteria?: string[];
  };
  const goalSummary = String(intent.goal_summary || outcome.requested_result || '').trim();
  const successCondition = String(
    intent.success_condition || (outcome.success_criteria || []).join('; ') || ''
  ).trim();
  if (!goalSummary && !successCondition) return [];
  return [
    '## Mission goal (the user purpose this task serves — optimize for THIS, not just the task wording)',
    ...(goalSummary ? [`- Goal: ${goalSummary}`] : []),
    ...(successCondition ? [`- Success condition: ${successCondition}`] : []),
    '- If your task as written conflicts with or cannot advance this goal, say so in gaps/needs instead of completing it literally.',
    '',
  ];
}

/**
 * LC-12 v2: surface the last few human-rejection lessons (persisted by
 * review-reentry) directly in the worker brief, so same-shape work stops
 * repeating a rejection the operator already explained. Ephemeral advisory
 * lines — deliberately outside the context-pack pruning budget.
 */
export function buildRejectionLessonLines(): string[] {
  try {
    return readHintsByCategory('human-rejection')
      .slice(-3)
      .map((hint) => `- ${hint.hint}`);
  } catch {
    return [];
  }
}

/**
 * Each team-role assignment carries its own `authority_role` (e.g. a
 * `tester` task's assignee might be authorized as `qa_lead`, an
 * `implementer` task's as `software_developer`) — a different, finer-grained
 * concept than the single mission-wide `assigned_persona` that
 * syncRoleProcedure (mission-governance.ts) mirrors at mission activation.
 * That mission-wide copy is fine as an audit artifact, but injecting it into
 * every task regardless of which role is actually doing the work would hand
 * a reviewer/tester the mission owner's procedure instead of their own.
 * This provider instead reads knowledge/product/roles/{authorityRole}/
 * PROCEDURE.md directly, per-task, and is registered under a role-specific
 * provider id so each authority_role's procedure is injected once (on that
 * role's first task) rather than on every single task dispatch.
 */
export function buildAuthorityRoleProcedureInjectionProvider(
  authorityRole: string
): DynamicInjectionProvider {
  return {
    id: `authority-role-procedure:${authorityRole}`,
    oneShot: true,
    collect: () => {
      const procedurePath = pathResolver.knowledge(`product/roles/${authorityRole}/PROCEDURE.md`);
      if (!safeExistsSync(procedurePath)) return null;
      const content = String(safeReadFile(procedurePath, { encoding: 'utf8' }) || '').trim();
      if (!content) return null;
      return [`## Role procedure (${authorityRole})`, content].join('\n\n');
    },
  };
}

export function buildTaskExecutionPrompt(input: {
  missionId: string;
  task: PlannedNextTask;
  teamRole: string;
  agentId: string;
  taskModelHint?: { model_id?: string; tier?: string; effort?: string };
  missionContextPack: string;
  missionGoalLines: string[];
  upstreamResultLines: string[];
  teamSnapshotLines: string[];
  reviewFindingsLines: string[];
  artifactReviewLines: string[];
  rejectionLessonLines?: string[];
  delegationNotificationLines?: string[];
  dynamicInjectionLines?: string[];
  targetPath?: string;
}): string {
  const lines = [
    `Execute task ${input.task.task_id} for mission ${input.missionId}.`,
    `Assigned team role: ${input.teamRole}.`,
    `Assigned agent: ${input.agentId}.`,
    input.taskModelHint
      ? `Model hint: ${input.taskModelHint.model_id || 'unknown'} (${input.taskModelHint.tier || 'n/a'}/${input.taskModelHint.effort || 'n/a'})`
      : '',
    input.task.description ? `Description: ${input.task.description}` : '',
    input.task.deliverable ? `Deliverable: ${input.task.deliverable}` : '',
    resolveReviewTargetForTask(input.task)
      ? `Review target: ${resolveReviewTargetForTask(input.task)}`
      : '',
    input.targetPath ? `Target path: ${input.targetPath}` : '',
    // Workers run with the repository root as cwd, so a bare relative
    // deliverable ('evidence/…') used to land at the repo root. Anchor all
    // artifact IO to the mission directory; the acceptance gate resolves
    // reported artifact paths against this same root.
    `Artifact root: ${missionDir(input.missionId, 'public')}`,
    'Write every artifact under the artifact root; deliverable and target paths are relative to it. Report artifact paths relative to the artifact root. Never write to the repository root or outside the mission directory.',
    '',
    ...input.missionGoalLines,
    ...(input.dynamicInjectionLines ?? []),
    '## Upstream results (inputs you MUST build on)',
    ...input.upstreamResultLines,
    '',
    '## Team snapshot (do not duplicate; stay consistent with completed work)',
    ...input.teamSnapshotLines,
    'Already completed work must keep terminology, structure, and style aligned.',
    'Do not trespass into another task’s scope; if needed, put it in needs.',
    '',
    ...(input.delegationNotificationLines ?? []),
    ...(input.reviewFindingsLines.length > 0 &&
    !(input.reviewFindingsLines.length === 1 && input.reviewFindingsLines[0] === '- none')
      ? ['## Review findings to address', ...input.reviewFindingsLines, '']
      : []),
    ...input.artifactReviewLines,
    ...(input.rejectionLessonLines && input.rejectionLessonLines.length > 0
      ? [
          '## Recent human-rejection lessons (avoid repeating these)',
          ...input.rejectionLessonLines,
          '',
        ]
      : []),
    input.missionContextPack,
    '',
    'Return exactly one ```task_result``` block and nothing else structured.',
    `Schema: ${renderStructuredOutputSchemaPrompt('task_result')}`,
    resolveReviewTargetForTask(input.task)
      ? 'For review tasks, put concrete findings into review_findings[] using severity, location, and instruction. Keep gaps for unresolved blockers.'
      : 'Do not paste file contents. Include only conclusions, artifact paths, verification steps, gaps, and needs.',
    // KP-05: optional bridge back to the knowledge provisioning loop — report
    // which "Knowledge hints" above (by path) actually helped or didn't, and
    // any topic you needed but were not given.
    'Optionally include knowledge_feedback: {used, not_used, missing_topics} to report which of the knowledge hints above (by path) helped, which did not, and which topics were needed but missing.',
  ].filter(Boolean);
  return lines.join('\n');
}

// KP-04: how many fresh (not-already-delivered) hints the needs-driven
// second-round retrieval appends to the retry prompt. Kept small — this is a
// targeted delta, not a re-render of the full context pack.
export const NEEDS_KNOWLEDGE_RETRIEVAL_LIMIT = 3;

/**
 * KP-04: when a `task_result` reports unresolved `needs`, the pre-KP-04
 * retry prompt only re-sent the same objective/context and asked again — it
 * never looked anything up. This targets a fresh, small retrieval using the
 * needs strings themselves as the query (`findRelevantDistilledKnowledge`,
 * the same entry point `loadKnowledgeHintsIfPossible` in
 * mission-context-pack.ts uses), excludes any path already delivered in the
 * first-round context pack (`deliveredKnowledgeRefs`), and records what it
 * delivers via `recordKnowledgeDelivery` so KP-05 telemetry sees this
 * second round too. Fails open: a retrieval error must never block the
 * retry — it just means no delta section gets appended.
 */
export async function buildNeedsKnowledgeReinforcementLines(input: {
  missionId: string;
  taskId: string;
  teamRole?: string;
  needs: string[];
  deliveredKnowledgeRefs: DeliveredKnowledgeRef[];
  securityScope?: import('./context-security-scope.js').ContextSecurityScope;
}): Promise<string[]> {
  if (input.needs.length === 0) return [];
  try {
    const excludePaths = new Set(input.deliveredKnowledgeRefs.map((ref) => ref.path));
    const found = await findRelevantDistilledKnowledge({
      topic: input.needs.join(' '),
      limit: NEEDS_KNOWLEDGE_RETRIEVAL_LIMIT * 2,
      minScore: 0.08,
    });
    const fresh = found
      .filter((entry) => !excludePaths.has(entry.path))
      .slice(0, NEEDS_KNOWLEDGE_RETRIEVAL_LIMIT);
    if (fresh.length === 0) return [];

    recordKnowledgeDelivery({
      missionId: input.missionId,
      taskId: input.taskId,
      teamRole: input.teamRole,
      recipientKind: 'agent',
      ...(input.securityScope?.tenant_slug
        ? {
            scope: {
              tier: input.securityScope.write_tier,
              tenant_slug: input.securityScope.tenant_slug,
              mission_id: input.securityScope.mission_id,
              task_id: input.taskId,
            },
          }
        : {}),
      refs: fresh.map((entry) => ({
        path: entry.path,
        ...(typeof entry.score === 'number' ? { score: entry.score } : {}),
        ...(entry.title ? { title: entry.title } : {}),
      })),
    });

    const lines = [
      'Additional knowledge retrieved for the unresolved needs (not in the original context pack):',
    ];
    for (const entry of fresh) {
      lines.push(`- ${entry.title} (${entry.path})`);
      lines.push(`  ${entry.excerpt.trim().replace(/\s+/g, ' ').slice(0, 200)}`);
    }
    return lines;
  } catch (err: any) {
    logger.warn(
      `[MISSION_WORKER] KP-04 needs-driven knowledge retrieval failed for ${input.missionId}/${input.taskId}: ${err?.message || err}`
    );
    return [];
  }
}

export function buildTaskResultRetryPrompt(input: {
  missionId: string;
  taskId: string;
  previousResponse: string;
  parseErrors: string[];
  /** KP-04: compact delta section from buildNeedsKnowledgeReinforcementLines. */
  knowledgeDeltaLines?: string[];
}): string {
  return [
    `The previous response for mission ${input.missionId} task ${input.taskId} was rejected.`,
    'Resend the answer as exactly one ```task_result``` block.',
    `Schema: ${renderStructuredOutputSchemaPrompt('task_result')}`,
    'Do not include any other structured block.',
    'Errors:',
    ...input.parseErrors.map((error) => `- ${error}`),
    ...(input.knowledgeDeltaLines && input.knowledgeDeltaLines.length > 0
      ? ['', ...input.knowledgeDeltaLines]
      : []),
    '',
    'Previous response excerpt:',
    input.previousResponse.slice(0, 1200),
  ].join('\n');
}

export function parseTaskResultResponse(responseText: string): {
  taskResult?: TaskResultBlock;
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

export function buildTaskClarificationPacket(input: {
  missionId: string;
  task: PlannedNextTask;
  taskResult: TaskResultBlock;
}): OperatorInteractionPacket | undefined {
  const needs = input.taskResult.needs || [];
  if (needs.length === 0) return undefined;
  return resolveQuestionInteractionPacket(
    {
      text: [
        `Mission ${input.missionId} task ${input.task.task_id}`,
        input.task.description,
        input.task.deliverable,
        input.taskResult.summary,
        `Unresolved needs: ${needs.join('; ')}`,
      ]
        .filter(Boolean)
        .join('\n'),
      requiredInputs: needs,
      supplementalQuestions: needs.map((need, index) => ({
        id: `task_result_need_${index + 1}`,
        question: `Please provide ${need.replace(/_/g, ' ')}.`,
        reason: 'The task result still needs this input before the task can proceed.',
        required_input: need,
        impact: 'The work item remains blocked until the missing input is available.',
      })),
      maxQuestions: Math.min(3, Math.max(1, needs.length)),
    },
    `Clarification needed for task ${input.task.task_id}`,
    'The task result still has unresolved needs_input and cannot be marked complete yet.'
  );
}

export function looksLikePath(value: string): boolean {
  return /[\\/]/u.test(value) || /\.[A-Za-z0-9]+$/u.test(value);
}

export async function evaluateTaskAcceptanceGate(input: {
  missionId: string;
  task: PlannedNextTask;
  taskResult?: TaskResultBlock;
  targetPath?: string;
}): Promise<{ passed: boolean; reasons: string[]; recordPath?: string }> {
  const missionPath = missionDir(input.missionId, 'public');
  const evidencePaths = [
    ...(input.task.target_path ? [input.task.target_path] : []),
    ...(input.targetPath ? [input.targetPath] : []),
    ...(input.taskResult?.artifacts || [])
      .map((artifact) => String(artifact?.path || '').trim())
      .filter(Boolean),
    ...(input.task.deliverable && looksLikePath(input.task.deliverable)
      ? [input.task.deliverable]
      : []),
  ]
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)
    .map((entry) => (nodePath.isAbsolute(entry) ? entry : nodePath.join(missionPath, entry)));
  const acceptanceCriteria = Array.isArray(input.task.acceptance_criteria)
    ? input.task.acceptance_criteria.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];
  const verificationNotes = input.taskResult?.verification_done || [];
  const summary = String(input.taskResult?.summary || '').trim();
  const reasons: string[] = [];
  const criteriaMisses = acceptanceCriteria.filter(
    (criterion) =>
      ![summary, ...verificationNotes].some((note) =>
        String(note || '')
          .toLowerCase()
          .includes(criterion.toLowerCase())
      )
  );
  if (criteriaMisses.length > 0) {
    reasons.push(`Missing acceptance evidence for: ${criteriaMisses.join(', ')}`);
  }
  if (!input.taskResult) {
    reasons.push('Missing structured task result.');
  }
  if (input.taskResult && (input.taskResult.gaps || []).length > 0) {
    reasons.push(`Task result reported gaps: ${input.taskResult.gaps.join('; ')}`);
  }

  const gate = await evaluateMissionGate({
    missionId: input.missionId,
    gate: {
      id: `task-acceptance-${input.task.task_id}`,
      title: `Task acceptance gate for ${input.task.task_id}`,
      checks: [
        {
          kind: 'schema_valid',
          params: {
            schema: 'task_result',
            value: input.taskResult,
          },
        },
        {
          kind: 'evidence_exists',
          params: {
            paths: evidencePaths,
          },
        },
        {
          kind: 'custom',
          params: {
            evaluate: () => ({
              passed: reasons.length === 0,
              reason: reasons.join('; '),
            }),
          },
        },
      ],
    },
    evidenceDir: `${missionDir(input.missionId, 'public')}/gates`,
  });

  return {
    passed: gate.verdict === 'pass',
    reasons: [...gate.reasons, ...reasons],
    recordPath: gate.evidence_path,
  };
}

export interface IndependentAcceptanceReview {
  approve: boolean;
  gaps: string[];
  rationale?: string;
  reviewerAgentId: string;
}

/**
 * Ask the mission's reviewer runtime for a semantic accept/reject verdict on
 * a task result. Returns null when separation of duties cannot be satisfied
 * (no reviewer staffed, reviewer is the same actor as the worker, or the
 * worker itself holds a review role) or when the reviewer ask fails — the
 * caller then falls back to the deterministic gate verdict.
 */
export async function requestIndependentAcceptanceReview(input: {
  missionId: string;
  task: PlannedNextTask;
  taskResult?: unknown;
  workerAgentId: string;
  workerTeamRole: string;
  securityScope?: unknown;
}): Promise<IndependentAcceptanceReview | null> {
  if (input.workerTeamRole === 'reviewer' || input.workerTeamRole === 'qa') return null;
  const reviewerAssignment = resolveMissionTeamReceiver({
    missionId: input.missionId,
    teamRole: 'reviewer',
  });
  const reviewerAgentId = reviewerAssignment?.agent_id;
  if (!reviewerAgentId || reviewerAgentId === input.workerAgentId) {
    logger.info(
      `[MISSION_WORKER] Independent acceptance review skipped for ${input.task.task_id}: ${
        reviewerAgentId ? 'reviewer is the same actor as the worker' : 'no reviewer staffed'
      }.`
    );
    return null;
  }

  const prompt = [
    `You are the independent reviewer for mission ${input.missionId}.`,
    `Judge whether the following task result satisfies the task and its acceptance criteria.`,
    `Task: ${input.task.description || input.task.task_id}`,
    input.task.deliverable ? `Deliverable: ${input.task.deliverable}` : '',
    input.task.acceptance_criteria?.length
      ? `Acceptance criteria:\n- ${input.task.acceptance_criteria.join('\n- ')}`
      : '',
    '',
    'Task result:',
    JSON.stringify(input.taskResult ?? null, null, 2).slice(0, 6000),
    '',
    'Return JSON only: { "approve": boolean, "gaps": string[], "rationale": string }',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const response = await a2aBridge.route({
      a2a_version: '1.0',
      header: {
        msg_id: `REQ-${Date.now().toString(36).toUpperCase()}-${input.task.task_id}-acceptance`,
        sender: 'kyberion:mission-orchestrator',
        receiver: reviewerAgentId,
        performative: 'request',
        timestamp: new Date().toISOString(),
      },
      payload: {
        intent: 'mission_task_execution',
        text: prompt,
        objective: `Independent acceptance review for ${input.task.task_id}`,
        context: {
          mission_id: input.missionId,
          team_role: 'reviewer',
          task_id: `${input.task.task_id}-acceptance-review`,
          execution_mode: 'task',
          security_scope: input.securityScope,
        },
      },
    });
    const verdict = parsePlanningReviewVerdict(String(response.payload?.text || ''));
    // Only a schema-valid verdict counts. A missing or malformed verdict is
    // reviewer unavailability, not a rejection — degrade to the deterministic
    // gate instead of failing work on a broken review response.
    if (!verdict.parsed) {
      logger.warn(
        `[MISSION_WORKER] Independent acceptance review for ${input.task.task_id} returned no valid verdict (${verdict.gaps.join('; ')}); falling back to the deterministic gate.`
      );
      return null;
    }
    return {
      approve: verdict.approve,
      gaps: verdict.gaps,
      ...(verdict.rationale ? { rationale: verdict.rationale } : {}),
      reviewerAgentId,
    };
  } catch (err: any) {
    logger.warn(
      `[MISSION_WORKER] Independent acceptance review failed for ${input.task.task_id}: ${err?.message || err}`
    );
    return null;
  }
}
