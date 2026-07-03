import { a2aBridge } from './a2a-bridge.js';
import {
  buildMissionTeamView,
  resolveMissionTeamPlan,
  resolveMissionTeamReceiver,
} from './mission-team-plan-composer.js';
import { resolveQuestionInteractionPacket } from './question-resolver.js';
import { validateDelegatedTaskPreflight } from './delegation-preflight.js';
import {
  emitChannelSurfaceEvent,
  enqueueChronosOutboxMessage,
  enqueueSlackOutboxMessage,
  type PlanningPacket,
} from './channel-surface.js';
import { extractPlanningPacketBlocks, validatePlanningPacket } from './planning-packet-contract.js';
import { extractSurfaceBlocks } from './surface-response-blocks.js';
import {
  ensureMissionTeamRuntimeViaSupervisor,
  shutdownAllAgentRuntimes,
} from './agent-runtime-supervisor.js';
import { ledger } from './ledger.js';
import { logger } from './core.js';
import { buildExecutionEnv } from './authority.js';
import { missionDir, missionEvidenceDir } from './path-resolver.js';
import { pathResolver } from './path-resolver.js';
import {
  renderMissionContextPack,
  resolveMissionContextPack,
  saveMissionContextPack,
  type MissionContextPackPruningSummary,
} from './mission-context-pack.js';
import * as nodePath from 'node:path';
import { safeExec, safeExistsSync, safeReadFile, safeReaddir, safeWriteFile } from './secure-io.js';
import { emitMissionTaskEvent } from './mission-task-events.js';
import {
  enqueueMissionOrchestrationEvent,
  emitMissionOrchestrationObservation,
  loadMissionOrchestrationEvent,
  startMissionOrchestrationWorker,
  type MissionOrchestrationEvent,
} from './mission-orchestration-events.js';
import {
  appendMissionOrchestrationJournalEntry,
  appendMissionOrchestrationJournalStatus,
  loadMissionOrchestrationReplayPlan,
} from './mission-orchestration-journal.js';
import { recoverMissionRequestedTasks } from './mission-task-recovery.js';
import { emitIntentSnapshot, mapStageToLoopPhase } from './intent-snapshot-store.js';
import { summarizeHeuristics } from './heuristic-feedback.js';
import { getIntentExtractor } from './intent-extractor.js';
import { installAnthropicBackendsIfAvailable } from './reasoning-bootstrap.js';

let workerBackendsInstalled = false;

function ensureWorkerBackendsInstalled(): void {
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
function emitWorkerTransitionSnapshot(
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
  } catch (err: any) {
    // evidence dir may not yet exist on very first events; keep worker non-blocking
    logger.warn(
      `[worker] intent snapshot skipped for ${missionId}/${stageKey}: ${err?.message ?? err}`
    );
  }
}

/**
 * Like `emitWorkerTransitionSnapshot` but pulls a real IntentBody out of the
 * Slack payload text via the registered IntentExtractor. Use on the entry
 * transition (`intake`) where the user's original utterance is available —
 * this is the baseline against which later snapshots are compared for drift.
 */
async function emitWorkerKickoffSnapshot(missionId: string, payload: SlackPayload): Promise<void> {
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

const MISSION_CONTROLLER_TIMEOUT_MS = 600_000;

interface SlackPayload {
  channel: string;
  threadTs: string;
  sourceText?: string;
  proposal?: Record<string, unknown>;
  tier?: 'personal' | 'confidential' | 'public';
  persona?: string;
  missionType?: string;
  teamRoles?: string[];
}

interface MissionControlPayload {
  operation: 'resume' | 'refresh_team' | 'prewarm_team' | 'staff_team' | 'finish';
  requested_by_surface?: 'chronos';
}

interface SurfaceControlPayload {
  operation: 'reconcile' | 'status' | 'start' | 'stop';
  surfaceId?: string;
  requested_by_surface?: 'chronos';
}

interface PlannedNextTask {
  task_id: string;
  status?: string;
  assigned_to?: {
    role?: string;
    agent_id?: string;
  };
  description?: string;
  deliverable?: string;
  target_path?: string;
}

type TaskResultBlock = NonNullable<ReturnType<typeof extractSurfaceBlocks>['taskResults']>[number];
type OperatorInteractionPacket = NonNullable<ReturnType<typeof resolveQuestionInteractionPacket>>;

const TASK_EVENT_STATUS_MAP: Partial<
  Record<
    NonNullable<PlannedNextTask['status']>,
    'task_reviewed' | 'task_completed' | 'task_accepted'
  >
> = {
  reviewed: 'task_reviewed',
  completed: 'task_completed',
  accepted: 'task_accepted',
};

function resolveMissionType(payload: SlackPayload): string {
  if (typeof payload.missionType === 'string' && payload.missionType.trim()) {
    return payload.missionType;
  }
  const proposalMissionType = payload.proposal?.mission_type;
  return typeof proposalMissionType === 'string' && proposalMissionType.trim()
    ? proposalMissionType
    : 'development';
}

function runMissionController(env: NodeJS.ProcessEnv, args: string[]) {
  return safeExec('node', ['dist/scripts/mission_controller.js', ...args], {
    env,
    timeoutMs: MISSION_CONTROLLER_TIMEOUT_MS,
  });
}

function recordMissionContextTask(
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

function taskResultFilePath(missionId: string, taskId: string): string {
  return `${missionDir(missionId, 'public')}/evidence/task-result-${taskId}.json`;
}

function taskClarificationFilePath(missionId: string, taskId: string): string {
  return `${missionDir(missionId, 'public')}/evidence/task-clarification-${taskId}.json`;
}

function summarizeTaskResultObservability(input: {
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

function buildTaskExecutionPrompt(input: {
  missionId: string;
  task: PlannedNextTask;
  teamRole: string;
  agentId: string;
  taskModelHint?: { model_id?: string; tier?: string; effort?: string };
  missionContextPack: string;
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
    input.targetPath ? `Target path: ${input.targetPath}` : '',
    '',
    input.missionContextPack,
    '',
    'Return exactly one ```task_result``` block and nothing else structured.',
    'Schema: {"summary":"3 sentences max","artifacts":[{"path":"...","kind":"..."}],"verification_done":["..."],"gaps":["..."],"needs":["..."]}',
    'Do not paste file contents. Include only conclusions, artifact paths, verification steps, gaps, and needs.',
  ].filter(Boolean);
  return lines.join('\n');
}

function buildTaskResultRetryPrompt(input: {
  missionId: string;
  taskId: string;
  previousResponse: string;
  parseErrors: string[];
}): string {
  return [
    `The previous response for mission ${input.missionId} task ${input.taskId} was rejected.`,
    'Resend the answer as exactly one ```task_result``` block.',
    'Required fields: summary, artifacts, verification_done, gaps, needs.',
    'Do not include any other structured block.',
    'Errors:',
    ...input.parseErrors.map((error) => `- ${error}`),
    '',
    'Previous response excerpt:',
    input.previousResponse.slice(0, 1200),
  ].join('\n');
}

function parseTaskResultResponse(responseText: string): {
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

function buildTaskClarificationPacket(input: {
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

async function buildTaskDispatchContext(input: {
  missionId: string;
  task: PlannedNextTask;
  teamRole: string;
  agentId: string;
  taskModelHint?: { model_id?: string; tier?: string; effort?: string; route_reason?: string };
}): Promise<{
  prompt: string;
  missionContextPackId?: string;
  missionContextPackPath?: string;
  missionContextPackSummary: string;
  missionContextPackPruningSummary?: MissionContextPackPruningSummary;
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
  const missionContextPack = await resolveMissionContextPack({
    missionId: input.missionId,
    tier: (missionState.tier as 'personal' | 'confidential' | 'public') || 'public',
    recipientKind: 'agent',
    teamRole: input.teamRole,
    assigneePeerId: input.agentId,
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
  const missionContextPackPath = missionContextPack
    ? saveMissionContextPack(missionDir(input.missionId, 'public'), missionContextPack)
    : undefined;
  const missionContextPackText = missionContextPack
    ? renderMissionContextPack(missionContextPack)
    : [
        'Mission context pack unavailable; using degraded fallback context.',
        `- Mission: ${input.missionId}`,
        `- Task: ${input.task.task_id}`,
        input.teamRole ? `- Team role: ${input.teamRole}` : '',
        input.task.description ? `- Description: ${input.task.description}` : '',
      ]
        .filter(Boolean)
        .join('\n');
  const prompt = buildTaskExecutionPrompt({
    missionId: input.missionId,
    task: input.task,
    teamRole: input.teamRole,
    agentId: input.agentId,
    taskModelHint: input.taskModelHint,
    missionContextPack: missionContextPackText,
    targetPath: input.task.target_path || input.task.deliverable,
  });
  return {
    prompt,
    missionContextPackId: missionContextPack?.context_pack_id,
    missionContextPackPath,
    missionContextPackSummary: missionContextPack?.summary || 'degraded mission context pack',
    missionContextPackPruningSummary: missionContextPack?.pruning as
      | MissionContextPackPruningSummary
      | undefined,
  };
}

async function obtainTaskResultResponse(input: {
  missionId: string;
  task: PlannedNextTask;
  teamRole: string;
  agentId: string;
  taskModelHint?: { model_id?: string; tier?: string; effort?: string; route_reason?: string };
  prompt: string;
}): Promise<{
  executionMode: 'agent';
  responseText: string;
  taskResult?: TaskResultBlock;
  parseErrors: string[];
  surfaceParseErrors: string[];
  retried: boolean;
  notes: string[];
}> {
  const notes: string[] = [];
  let response = await a2aBridge.route({
    a2a_version: '1.0',
    header: {
      msg_id: `REQ-${Date.now().toString(36).toUpperCase()}-${input.task.task_id}`,
      sender: 'kyberion:mission-orchestrator',
      receiver: input.agentId,
      performative: 'request',
      timestamp: new Date().toISOString(),
    },
    payload: {
      intent: 'mission_task_execution',
      text: input.prompt,
      objective: input.task.description || input.task.task_id,
      acceptance_criteria: Array.isArray((input.task as any).acceptance_criteria)
        ? (input.task as any).acceptance_criteria.filter(
            (criterion: unknown) => typeof criterion === 'string' && criterion.trim()
          )
        : undefined,
      expected_outputs: [input.task.deliverable || '', input.task.target_path || '']
        .map((entry) => String(entry || '').trim())
        .filter(Boolean),
      rationale: input.task.deliverable
        ? `Deliver ${input.task.deliverable} for ${input.task.task_id}`
        : `Complete task ${input.task.task_id}`,
      prior_decisions:
        Array.isArray((input.task as any).dependencies) &&
        (input.task as any).dependencies.length > 0
          ? [`Dependencies: ${(input.task as any).dependencies.join(', ')}`]
          : undefined,
      context: {
        mission_id: input.missionId,
        team_role: input.teamRole,
        task_id: input.task.task_id,
        execution_mode: 'task',
        task_model_hint: input.taskModelHint,
      },
    },
  });
  let parsed = parseTaskResultResponse(String(response.payload?.text || ''));
  let taskResult = parsed.taskResult;
  let parseErrors = parsed.parseErrors;
  let surfaceParseErrors = parsed.surfaceParseErrors;
  const needsRetry = !taskResult || parseErrors.length > 0 || (taskResult.needs || []).length > 0;

  if (needsRetry) {
    if (taskResult?.needs?.length)
      notes.push(`task_result.needs requested: ${taskResult.needs.join('; ')}`);
    if (parseErrors.length > 0) notes.push(`task_result parse errors: ${parseErrors.join('; ')}`);
    if (surfaceParseErrors.length > 0)
      notes.push(`surface parse errors: ${surfaceParseErrors.join('; ')}`);
    response = await a2aBridge.route({
      a2a_version: '1.0',
      header: {
        msg_id: `REQ-${Date.now().toString(36).toUpperCase()}-${input.task.task_id}-retry`,
        sender: 'kyberion:mission-orchestrator',
        receiver: input.agentId,
        performative: 'request',
        timestamp: new Date().toISOString(),
      },
      payload: {
        intent: 'mission_task_execution',
        text: buildTaskResultRetryPrompt({
          missionId: input.missionId,
          taskId: input.task.task_id,
          previousResponse: String(response.payload?.text || ''),
          parseErrors: [
            ...(taskResult?.needs?.length
              ? [`needs unresolved: ${taskResult.needs.join('; ')}`]
              : []),
            ...parseErrors,
          ],
        }),
        objective: input.task.description || input.task.task_id,
        acceptance_criteria: Array.isArray((input.task as any).acceptance_criteria)
          ? (input.task as any).acceptance_criteria.filter(
              (criterion: unknown) => typeof criterion === 'string' && criterion.trim()
            )
          : undefined,
        expected_outputs: [input.task.deliverable || '', input.task.target_path || '']
          .map((entry) => String(entry || '').trim())
          .filter(Boolean),
        rationale: input.task.deliverable
          ? `Deliver ${input.task.deliverable} for ${input.task.task_id}`
          : `Complete task ${input.task.task_id}`,
        prior_decisions:
          Array.isArray((input.task as any).dependencies) &&
          (input.task as any).dependencies.length > 0
            ? [`Dependencies: ${(input.task as any).dependencies.join(', ')}`]
            : undefined,
        context: {
          mission_id: input.missionId,
          team_role: input.teamRole,
          task_id: input.task.task_id,
          execution_mode: 'task',
          task_model_hint: input.taskModelHint,
        },
      },
    });
    parsed = parseTaskResultResponse(String(response.payload?.text || ''));
    taskResult = parsed.taskResult;
    parseErrors = parsed.parseErrors;
    surfaceParseErrors = parsed.surfaceParseErrors;
    if (!taskResult) notes.push('task_result missing after retry');
    if (parseErrors.length > 0)
      notes.push(`task_result parse errors after retry: ${parseErrors.join('; ')}`);
    if (surfaceParseErrors.length > 0)
      notes.push(`surface parse errors after retry: ${surfaceParseErrors.join('; ')}`);
  }

  return {
    executionMode: 'agent',
    responseText: String(response.payload?.text || ''),
    taskResult,
    parseErrors,
    surfaceParseErrors,
    retried: needsRetry,
    notes,
  };
}

type MissionGateRecord = {
  gate_id?: string;
  verdict?: 'pass' | 'fail';
  reason?: string;
  failure_count?: number;
  checked_at?: string;
  should_realign?: boolean;
  next_status?: string;
};

function loadMissionStateSnapshot(missionId: string): Record<string, unknown> | null {
  const missionPath = missionDir(missionId, 'public');
  const statePath = `${missionPath}/mission-state.json`;
  if (!safeExistsSync(statePath)) return null;
  try {
    const parsed = JSON.parse(safeReadFile(statePath, { encoding: 'utf8' }) as string);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function loadMissionGateRecords(missionId: string): MissionGateRecord[] {
  const missionPath = missionDir(missionId, 'public');
  const gateDir = `${missionPath}/gates`;
  if (!safeExistsSync(gateDir)) return [];
  return safeReaddir(gateDir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => {
      try {
        const parsed = JSON.parse(
          safeReadFile(`${gateDir}/${entry}`, { encoding: 'utf8' }) as string
        );
        return parsed && typeof parsed === 'object' ? (parsed as MissionGateRecord) : null;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is MissionGateRecord => Boolean(entry));
}

function summarizeMissionGateState(missionId: string): { lines: string[]; reworkCount: number } {
  const records = loadMissionGateRecords(missionId);
  const latestByGate = new Map<string, MissionGateRecord>();
  for (const record of records) {
    const gateId = String(record.gate_id || '').trim();
    if (!gateId) continue;
    latestByGate.set(gateId, record);
  }
  const state = loadMissionStateSnapshot(missionId);
  const reworkCount =
    Number(
      state?.context && typeof state.context === 'object'
        ? (state.context as Record<string, unknown>).mission_finish_gate_failure_count
        : 0
    ) || 0;

  const lines = Array.from(latestByGate.entries()).map(([gateId, record]) => {
    const icon = record.verdict === 'pass' ? '✅' : '❌';
    const suffix = record.should_realign ? ' realign' : '';
    const note = record.reason ? ` - ${record.reason}` : '';
    return `${icon} ${gateId}${suffix}${note}`;
  });

  return { lines, reworkCount };
}

function syncPlanningArtifacts(missionId: string): void {
  const missionPath = missionDir(missionId, 'public');
  const planPath = `${missionPath}/PLAN.md`;
  const nextTasksPath = `${missionPath}/NEXT_TASKS.json`;
  const taskBoardPath = `${missionPath}/TASK_BOARD.md`;

  if (
    !safeExistsSync(planPath) ||
    !safeExistsSync(nextTasksPath) ||
    !safeExistsSync(taskBoardPath)
  ) {
    return;
  }

  const currentTaskBoard = safeReadFile(taskBoardPath, { encoding: 'utf8' }) as string;
  const gateSummary = summarizeMissionGateState(missionId);
  const gateSection =
    gateSummary.lines.length > 0
      ? [
          '',
          '### Gate Status',
          ...gateSummary.lines,
          `Rework count: ${gateSummary.reworkCount}`,
        ].join('\n')
      : '';
  const updatedTaskBoard = currentTaskBoard
    .replace('## Status: Planned', '## Status: Planning Ready')
    .replace('- [ ] Step 1: Research and Strategy', '- [x] Step 1: Research and Strategy')
    .replace(/(?:\n### Gate Status[\s\S]*?)?$/u, gateSection);

  if (updatedTaskBoard !== currentTaskBoard) {
    safeWriteFile(taskBoardPath, updatedTaskBoard);
  }

  const nextTasks = JSON.parse(safeReadFile(nextTasksPath, { encoding: 'utf8' }) as string);
  ledger.record('MISSION_PLAN_READY', {
    mission_id: missionId,
    role: 'planner',
    summary_path: 'PLAN.md',
    next_tasks_path: 'NEXT_TASKS.json',
    planned_task_count: Array.isArray(nextTasks) ? nextTasks.length : 0,
  });
  emitMissionTaskEvent({
    event_type: 'task_submitted',
    mission_id: missionId,
    task_id: 'planner-initial-plan',
    agent_id: 'nerve-agent',
    team_role: 'planner',
    decision: 'task_submitted',
    why: 'Planner produced PLAN.md and NEXT_TASKS.json for the mission kickoff.',
    policy_used: 'mission_orchestration_control_plane_v1',
    evidence: ['PLAN.md', 'NEXT_TASKS.json'],
    payload: {
      summary_path: 'PLAN.md',
      next_tasks_path: 'NEXT_TASKS.json',
    },
  });
  emitMissionTaskEvent({
    event_type: 'task_completed',
    mission_id: missionId,
    task_id: 'planner-initial-plan',
    agent_id: 'nerve-agent',
    team_role: 'planner',
    decision: 'task_completed',
    why: 'Planner initial planning task completed with mission plan and next tasks.',
    policy_used: 'mission_orchestration_control_plane_v1',
    evidence: ['PLAN.md', 'NEXT_TASKS.json'],
    payload: {
      completion: 'planning_artifacts_ready',
    },
  });
}

export function persistPlanningPacket(missionId: string, packet: PlanningPacket): void {
  const validation = validatePlanningPacket(packet);
  if (!validation.valid || !validation.value) {
    throw new Error(`Invalid planning packet for ${missionId}: ${validation.errors.join('; ')}`);
  }
  const missionPath = missionDir(missionId, 'public');
  safeWriteFile(`${missionPath}/PLAN.md`, validation.value.plan_markdown.trimEnd() + '\n');
  const derivedTasks = validation.value.next_tasks.map((task, index) => {
    const taskId =
      typeof task.task_id === 'string' && task.task_id.trim()
        ? task.task_id.trim()
        : `task-${index + 1}`;
    const description = task.description.trim();
    const deliverable =
      typeof task.deliverable === 'string' && task.deliverable.trim()
        ? task.deliverable.trim()
        : undefined;
    const targetPath =
      typeof task.target_path === 'string' && task.target_path.trim()
        ? task.target_path.trim()
        : undefined;
    const dependencies = Array.isArray(task.dependencies)
      ? [
          ...new Set(
            task.dependencies.map((dependency) => String(dependency || '').trim()).filter(Boolean)
          ),
        ]
      : [];
    const acceptanceCriteria =
      Array.isArray(task.acceptance_criteria) && task.acceptance_criteria.length > 0
        ? task.acceptance_criteria
            .map((criterion) => String(criterion || '').trim())
            .filter(Boolean)
        : [description];
    const expectedOutputFormat =
      task.expected_output_format || (targetPath ? 'files' : deliverable ? 'files' : 'text');
    const estimatedScope =
      task.estimated_scope ||
      (description.length > 240 || dependencies.length > 1 || targetPath?.includes('/')
        ? 'L'
        : description.length > 120 || deliverable || dependencies.length === 1
          ? 'M'
          : 'S');
    const risk =
      task.risk || (estimatedScope === 'L' ? 'high' : estimatedScope === 'M' ? 'medium' : 'low');
    return {
      task_id: taskId,
      status: 'planned' as const,
      assigned_to: {
        role: task.team_role,
      },
      description,
      ...(deliverable ? { deliverable } : {}),
      ...(targetPath ? { target_path: targetPath } : {}),
      dependencies,
      acceptance_criteria: acceptanceCriteria,
      risk,
      expected_output_format: expectedOutputFormat,
      estimated_scope: estimatedScope,
    };
  });
  const nextTasks = validation.value.next_tasks.map((task, index) => ({
    ...derivedTasks[index],
  }));
  safeWriteFile(`${missionPath}/NEXT_TASKS.json`, JSON.stringify(nextTasks, null, 2));
}

function loadPlannedNextTasks(missionId: string): PlannedNextTask[] {
  return loadAllNextTasks(missionId).filter((task) => (task.status || 'planned') === 'planned');
}

function loadAllNextTasks(missionId: string): PlannedNextTask[] {
  const missionPath = missionDir(missionId, 'public');
  const nextTasksPath = `${missionPath}/NEXT_TASKS.json`;
  if (!safeExistsSync(nextTasksPath)) return [];
  const tasks = JSON.parse(
    safeReadFile(nextTasksPath, { encoding: 'utf8' }) as string
  ) as PlannedNextTask[];
  return Array.isArray(tasks) ? tasks : [];
}

function writeNextTasks(missionId: string, tasks: PlannedNextTask[]): void {
  const missionPath = missionDir(missionId, 'public');
  safeWriteFile(`${missionPath}/NEXT_TASKS.json`, JSON.stringify(tasks, null, 2));
}

function readExistingTaskEventKeys(missionId: string): Set<string> {
  const taskEventsPath = `${missionDir(missionId, 'public')}/coordination/events/task-events.jsonl`;
  if (!safeExistsSync(taskEventsPath)) return new Set();
  const raw = safeReadFile(taskEventsPath, { encoding: 'utf8' }) as string;
  return new Set(
    raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          const parsed = JSON.parse(line) as { event_type?: string; task_id?: string };
          return parsed.event_type && parsed.task_id
            ? `${parsed.event_type}:${parsed.task_id}`
            : null;
        } catch {
          return null;
        }
      })
      .filter((value): value is string => Boolean(value))
  );
}

function reconcileTaskOutcomeEvents(missionId: string): void {
  const tasks = loadAllNextTasks(missionId).filter(
    (task) => task.status && task.status !== 'planned' && task.status !== 'requested'
  );
  const seen = readExistingTaskEventKeys(missionId);

  for (const task of tasks) {
    const eventType = task.status ? TASK_EVENT_STATUS_MAP[task.status] : undefined;
    const teamRole = task.assigned_to?.role;
    if (!eventType || !teamRole) continue;
    const dedupeKey = `${eventType}:${task.task_id}`;
    if (seen.has(dedupeKey)) continue;
    emitMissionTaskEvent({
      event_type: eventType,
      mission_id: missionId,
      task_id: task.task_id,
      agent_id: task.assigned_to?.agent_id,
      team_role: teamRole,
      decision: eventType,
      why: `Task ${task.task_id} transitioned to ${task.status}.`,
      policy_used: 'mission_orchestration_control_plane_v1',
      evidence: task.deliverable ? [String(task.deliverable)] : [],
      payload: {
        description: task.description,
        deliverable: task.deliverable,
        status: task.status,
      },
    });
    seen.add(dedupeKey);
  }
}

export function reconcileMissionProgress(missionId: string): void {
  const missionPath = missionDir(missionId, 'public');
  const taskBoardPath = `${missionPath}/TASK_BOARD.md`;
  if (!safeExistsSync(taskBoardPath)) return;

  const tasks = loadAllNextTasks(missionId);
  const acceptedCount = tasks.filter((task) => task.status === 'accepted').length;
  const reviewedCount = tasks.filter((task) => task.status === 'reviewed').length;
  const completedCount = tasks.filter((task) => task.status === 'completed').length;
  const requestedCount = tasks.filter((task) => task.status === 'requested').length;

  reconcileTaskOutcomeEvents(missionId);

  const currentTaskBoard = safeReadFile(taskBoardPath, { encoding: 'utf8' }) as string;
  const gateSummary = summarizeMissionGateState(missionId);
  const gateSection =
    gateSummary.lines.length > 0
      ? [
          '',
          '### Gate Status',
          ...gateSummary.lines,
          `Rework count: ${gateSummary.reworkCount}`,
        ].join('\n')
      : '';
  let updatedTaskBoard = currentTaskBoard;

  if (acceptedCount > 0) {
    updatedTaskBoard = updatedTaskBoard
      .replace(/## Status: .+/u, '## Status: Review Accepted')
      .replace('- [~] Step 2: Implementation', '- [x] Step 2: Implementation')
      .replace('- [ ] Step 2: Implementation', '- [x] Step 2: Implementation')
      .replace('- [ ] Step 3: Validation', '- [x] Step 3: Validation');
  } else if (reviewedCount > 0 || completedCount > 0) {
    updatedTaskBoard = updatedTaskBoard
      .replace(/## Status: .+/u, '## Status: Validation Ready')
      .replace('- [~] Step 2: Implementation', '- [x] Step 2: Implementation')
      .replace('- [ ] Step 2: Implementation', '- [x] Step 2: Implementation')
      .replace('- [ ] Step 3: Validation', '- [~] Step 3: Validation');
  } else if (requestedCount > 0) {
    updatedTaskBoard = updatedTaskBoard
      .replace(/## Status: .+/u, '## Status: Execution Ready')
      .replace('- [ ] Step 2: Implementation', '- [~] Step 2: Implementation');
  }

  if (gateSection) {
    if (/### Gate Status[\s\S]*$/u.test(updatedTaskBoard)) {
      updatedTaskBoard = updatedTaskBoard.replace(/(?:\n### Gate Status[\s\S]*)$/u, gateSection);
    } else {
      updatedTaskBoard = `${updatedTaskBoard.trimEnd()}${gateSection}\n`;
    }
  }

  if (updatedTaskBoard !== currentTaskBoard) {
    safeWriteFile(taskBoardPath, updatedTaskBoard);
  }

  if (acceptedCount > 0 || reviewedCount > 0 || completedCount > 0) {
    ledger.record('MISSION_TASK_OUTCOMES_RECONCILED', {
      mission_id: missionId,
      accepted_count: acceptedCount,
      reviewed_count: reviewedCount,
      completed_count: completedCount,
      requested_count: requestedCount,
    });
  }
}

function markTaskBoardInProgress(missionId: string): void {
  const missionPath = missionDir(missionId, 'public');
  const taskBoardPath = `${missionPath}/TASK_BOARD.md`;
  if (!safeExistsSync(taskBoardPath)) return;
  const currentTaskBoard = safeReadFile(taskBoardPath, { encoding: 'utf8' }) as string;
  const updatedTaskBoard = currentTaskBoard
    .replace('## Status: Planning Ready', '## Status: Execution Ready')
    .replace('- [ ] Step 2: Implementation', '- [~] Step 2: Implementation');
  if (updatedTaskBoard !== currentTaskBoard) {
    safeWriteFile(taskBoardPath, updatedTaskBoard);
  }
}

export async function dispatchMissionNextTasks(
  missionId: string
): Promise<Array<{ task_id: string; team_role: string; agent_id: string }>> {
  ensureWorkerBackendsInstalled();
  const nextTasksPath = `${missionDir(missionId, 'public')}/NEXT_TASKS.json`;
  if (!safeExistsSync(nextTasksPath)) return [];
  const allTasks = JSON.parse(
    safeReadFile(nextTasksPath, { encoding: 'utf8' }) as string
  ) as PlannedNextTask[];
  const plannedTasks = Array.isArray(allTasks)
    ? allTasks.filter((task) => (task.status || 'planned') === 'planned')
    : [];
  if (plannedTasks.length === 0) return [];

  const uniqueRoles = Array.from(
    new Set(
      plannedTasks
        .map((task) => task.assigned_to?.role)
        .filter((role): role is string => Boolean(role))
    )
  );
  if (uniqueRoles.length > 0) {
    await ensureMissionTeamRuntimeViaSupervisor({
      missionId,
      teamRoles: uniqueRoles,
      requestedBy: 'mission_orchestration_worker',
      reason: 'Prewarm roles required by planner-produced NEXT_TASKS.',
      timeoutMs: MISSION_CONTROLLER_TIMEOUT_MS,
    });
  }

  const dispatched: Array<{ task_id: string; team_role: string; agent_id: string }> = [];
  const plan = resolveMissionTeamPlan({ missionId });
  const teamView = buildMissionTeamView(plan);

  for (const task of plannedTasks) {
    const teamRole = task.assigned_to?.role;
    if (!teamRole) continue;
    const assignment = resolveMissionTeamReceiver({ missionId, teamRole });
    if (!assignment?.agent_id) continue;
    const preflight = validateDelegatedTaskPreflight({
      task: {
        task_id: task.task_id,
        team_role: teamRole,
        deliverable: task.deliverable,
        target_path: task.target_path,
      },
      assignment,
    });
    emitMissionOrchestrationObservation({
      decision: preflight.allowed ? 'delegation_preflight_passed' : 'delegation_preflight_blocked',
      event_type: 'delegation_preflight_checked',
      requested_by: 'mission_orchestration_worker',
      mission_id: missionId,
      resource_id: task.task_id,
      operation: preflight.allowed ? 'allow' : 'block',
      why: preflight.reason,
      evidence: preflight.target_path ? [preflight.target_path] : [],
      payload: {
        team_role: teamRole,
        target_path: preflight.target_path,
        target_scope_class: preflight.target_scope_class,
        warnings: preflight.warnings,
      },
    });
    if (!preflight.allowed) {
      task.status = 'blocked';
      continue;
    }

    const dispatchContext = await buildTaskDispatchContext({
      missionId,
      task,
      teamRole,
      agentId: assignment.agent_id,
      taskModelHint: assignment.model_hint,
    });
    const response = await obtainTaskResultResponse({
      missionId,
      task,
      teamRole,
      agentId: assignment.agent_id,
      taskModelHint: assignment.model_hint,
      prompt: dispatchContext.prompt,
    });
    const taskResultNeeds = response.taskResult?.needs || [];
    const taskResultObservability = summarizeTaskResultObservability({
      pruning: dispatchContext.missionContextPackPruningSummary,
      taskResult: response.taskResult,
      parseErrors: response.parseErrors,
    });
    const taskResultBlocked =
      !response.taskResult || response.parseErrors.length > 0 || taskResultNeeds.length > 0;
    const clarificationPacket =
      taskResultNeeds.length > 0 && response.taskResult
        ? buildTaskClarificationPacket({
            missionId,
            task,
            taskResult: response.taskResult,
          })
        : undefined;
    const clarificationPacketPath = clarificationPacket
      ? taskClarificationFilePath(missionId, task.task_id)
      : undefined;

    if (taskResultBlocked && clarificationPacket && clarificationPacketPath) {
      safeWriteFile(
        clarificationPacketPath,
        JSON.stringify(
          {
            mission_id: missionId,
            task_id: task.task_id,
            task_result: response.taskResult,
            clarification_packet: clarificationPacket,
            clarification_packet_path: clarificationPacketPath,
            needs: taskResultNeeds,
            status: 'needs_input',
            written_at: new Date().toISOString(),
          },
          null,
          2
        )
      );
      task.status = 'blocked';
      emitMissionTaskEvent({
        event_type: 'task_reviewed',
        mission_id: missionId,
        task_id: task.task_id,
        agent_id: assignment.agent_id,
        team_role: teamRole,
        decision: 'task_reviewed',
        why: 'Task result still needs clarification before the work can continue.',
        policy_used: 'mission_orchestration_control_plane_v1',
        evidence: task.deliverable ? [String(task.deliverable)] : [],
        payload: {
          description: task.description,
          deliverable: task.deliverable,
          clarification_packet_path: clarificationPacketPath,
          needs: taskResultNeeds,
          task_result: response.taskResult,
          task_result_errors: response.parseErrors,
          ...taskResultObservability,
        },
      });
      recordMissionContextTask(missionId, `Blocked work item ${task.task_id}`, {
        next_step: 'resolve the missing inputs before retrying the work item',
        work_item_id: task.task_id,
        team_role: teamRole,
        assignee_peer_id: assignment.agent_id,
        execution_mode: response.executionMode,
        context_pack_id: dispatchContext.missionContextPackId,
        context_pack_path: dispatchContext.missionContextPackPath,
        context_pack_summary: dispatchContext.missionContextPackSummary,
        context_pack_pruning_summary: dispatchContext.missionContextPackPruningSummary,
        ...taskResultObservability,
      });
      continue;
    }

    if (taskResultBlocked) {
      task.status = 'blocked';
      emitMissionTaskEvent({
        event_type: 'task_reviewed',
        mission_id: missionId,
        task_id: task.task_id,
        agent_id: assignment.agent_id,
        team_role: teamRole,
        decision: 'task_reviewed',
        why: 'Task result did not satisfy the structured response contract.',
        policy_used: 'mission_orchestration_control_plane_v1',
        evidence: task.deliverable ? [String(task.deliverable)] : [],
        payload: {
          description: task.description,
          deliverable: task.deliverable,
          task_result: response.taskResult,
          task_result_errors: response.parseErrors,
          notes: response.notes,
          ...taskResultObservability,
        },
      });
      recordMissionContextTask(missionId, `Blocked work item ${task.task_id}`, {
        next_step: 'repair the structured task result response before retrying',
        work_item_id: task.task_id,
        team_role: teamRole,
        assignee_peer_id: assignment.agent_id,
        execution_mode: response.executionMode,
        context_pack_id: dispatchContext.missionContextPackId,
        context_pack_path: dispatchContext.missionContextPackPath,
        context_pack_summary: dispatchContext.missionContextPackSummary,
        context_pack_pruning_summary: dispatchContext.missionContextPackPruningSummary,
        ...taskResultObservability,
      });
      continue;
    }

    task.status = 'requested';
    emitMissionTaskEvent({
      event_type: 'task_issued',
      mission_id: missionId,
      task_id: task.task_id,
      agent_id: assignment.agent_id,
      team_role: teamRole,
      decision: 'task_issued',
      why: 'Planner-produced follow-up task was delegated to the assigned mission team role.',
      policy_used: 'mission_orchestration_control_plane_v1',
      evidence: task.deliverable ? [String(task.deliverable)] : [],
      payload: {
        description: task.description,
        deliverable: task.deliverable,
        task_model_hint: assignment.model_hint,
        mission_context_pack_path: dispatchContext.missionContextPackPath,
        mission_context_pack_summary: dispatchContext.missionContextPackSummary,
        task_result: response.taskResult,
        task_result_retried: response.retried,
        ...taskResultObservability,
      },
    });
    recordMissionContextTask(missionId, `Dispatched work item ${task.task_id}`, {
      next_step: 'await the dispatched response and continue reconciliation',
      work_item_id: task.task_id,
      team_role: teamRole,
      assignee_peer_id: assignment.agent_id,
      execution_mode: response.executionMode,
      context_pack_id: dispatchContext.missionContextPackId,
      context_pack_path: dispatchContext.missionContextPackPath,
      context_pack_summary: dispatchContext.missionContextPackSummary,
      context_pack_pruning_summary: dispatchContext.missionContextPackPruningSummary,
      ...taskResultObservability,
    });
    dispatched.push({
      task_id: task.task_id,
      team_role: teamRole,
      agent_id: assignment.agent_id,
    });
  }

  writeNextTasks(missionId, allTasks);
  markTaskBoardInProgress(missionId);
  reconcileMissionProgress(missionId);
  ledger.record('MISSION_FOLLOWUP_DISPATCHED', {
    mission_id: missionId,
    dispatched_task_count: dispatched.length,
    task_ids: dispatched.map((task) => task.task_id),
  });
  return dispatched;
}

function emitSlackMissionEvent(
  payload: SlackPayload,
  missionId: string,
  decision: string,
  why: string,
  extra: Record<string, unknown> = {}
): void {
  emitChannelSurfaceEvent('slack_bridge', 'slack', 'missions', {
    correlation_id: missionId,
    decision,
    why,
    policy_used: 'mission_orchestration_control_plane_v1',
    agent_id: 'mission_controller',
    resource_id: missionId,
    slack_channel: payload.channel,
    thread_ts: payload.threadTs,
    ...extra,
  });
}

function buildPlannerKickoffPrompt(
  missionId: string,
  plan: ReturnType<typeof resolveMissionTeamPlan>,
  payload: SlackPayload,
  teamView: Record<string, unknown>,
  validationFeedback?: string[]
): string {
  const sections = [
    `Kick off planning for mission ${missionId}.`,
    `Mission type: ${plan.mission_type}.`,
    `Original source request: ${payload.sourceText || ''}`,
    'Create the initial plan, define deliverables, and prepare the next delegated tasks.',
    'Return exactly one ```planning_packet``` block and no other structured block for the plan.',
    'The planning packet must match this contract:',
    JSON.stringify(
      {
        mission_id: missionId,
        summary: 'optional string',
        plan_markdown: 'non-empty markdown string',
        next_tasks: [
          {
            task_id: 'string',
            team_role: 'string',
            description: 'string',
            deliverable: 'optional string',
            target_path: 'optional string',
            dependencies: ['optional task_id strings'],
            acceptance_criteria: ['optional verification statements'],
            risk: 'low|medium|high|approval_required|high_stakes',
            expected_output_format: 'text|files|structured',
            estimated_scope: 'S|M|L',
          },
        ],
      },
      null,
      2
    ),
    validationFeedback && validationFeedback.length > 0
      ? `Previous response failed validation:\n- ${validationFeedback.join('\n- ')}`
      : '',
    '',
    'Mission team context:',
    JSON.stringify(
      {
        mission_id: plan.mission_id,
        mission_type: plan.mission_type,
        team: teamView,
      },
      null,
      2
    ),
  ].filter(Boolean);

  return sections.join('\n');
}

function buildPlannerRetryPrompt(
  missionId: string,
  validationErrors: string[],
  previousResponseText: string
): string {
  return [
    `The previous planning response for mission ${missionId} was rejected.`,
    'Return the same mission planning answer again, but fix the contract violations below.',
    'Return exactly one ```planning_packet``` block and nothing else that is structured.',
    'Contract violations:',
    ...validationErrors.map((error) => `- ${error}`),
    '',
    'Previous response excerpt:',
    previousResponseText.slice(0, 1200),
  ].join('\n');
}

type PlanningReviewVerdict = {
  approve: boolean;
  gaps: string[];
  rationale?: string;
  raw_text: string;
  parsed?: Record<string, unknown>;
};

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  const content = fenced ? fenced[1].trim() : trimmed;
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return content.slice(start, end + 1);
}

function parsePlanningReviewVerdict(text: string): PlanningReviewVerdict {
  const rawText = String(text || '');
  const json = extractJsonObject(rawText);
  const gaps: string[] = [];
  let approve = false;
  let rationale: string | undefined;
  let parsed: Record<string, unknown> | undefined;

  if (json) {
    try {
      const candidate = JSON.parse(json) as Record<string, unknown>;
      parsed = candidate;
      approve =
        candidate.approve === true || candidate.approve === 'true' || candidate.approved === true;
      rationale = typeof candidate.rationale === 'string' ? candidate.rationale.trim() : undefined;
      if (Array.isArray(candidate.gaps)) {
        gaps.push(...candidate.gaps.map((entry) => String(entry || '').trim()).filter(Boolean));
      }
      if (Array.isArray(candidate.findings)) {
        gaps.push(...candidate.findings.map((entry) => String(entry || '').trim()).filter(Boolean));
      }
    } catch {
      // fall through to text heuristics
    }
  }

  if (!approve && gaps.length === 0) {
    const lowered = rawText.toLowerCase();
    approve =
      /\bapprove(?:d|s|al)?\b/.test(lowered) &&
      !/\b(reject|block|gap|missing|refut)\b/.test(lowered);
    if (/gaps?|missing|block|reject|refut/.test(lowered)) {
      gaps.push(rawText.trim().slice(0, 500));
    }
  }

  return {
    approve,
    gaps,
    ...(rationale ? { rationale } : {}),
    raw_text: rawText,
    ...(parsed ? { parsed } : {}),
  };
}

function packetRequiresIndependentReview(packet: PlanningPacket): boolean {
  return packet.next_tasks.some(
    (task) => task.risk === 'approval_required' || task.risk === 'high_stakes'
  );
}

function buildPlanningReviewPrompt(input: {
  missionId: string;
  plan: ReturnType<typeof resolveMissionTeamPlan>;
  payload: SlackPayload;
  teamView: Record<string, unknown>;
  packet: PlanningPacket;
  plannerFeedback?: string[];
}): string {
  const highRiskTasks = input.packet.next_tasks.filter(
    (task) => task.risk === 'approval_required' || task.risk === 'high_stakes'
  );
  const sections = [
    `Review the planning packet for mission ${input.missionId}.`,
    'You are an independent reviewer in a separate context from the planner.',
    'Return JSON only: {"approve": boolean, "gaps": string[], "rationale": string}.',
    'Approve only if the plan can reach the deliverable with no missing dependencies, verification, or high-risk gaps.',
    '',
    'Mission request:',
    input.payload.sourceText || '',
    '',
    'Mission team context:',
    JSON.stringify(
      {
        mission_id: input.plan.mission_id,
        mission_type: input.plan.mission_type,
        team: input.teamView,
      },
      null,
      2
    ),
    '',
    'Planning packet to review:',
    JSON.stringify(input.packet, null, 2),
    highRiskTasks.length > 0
      ? `High-risk tasks requiring independent approval:\n- ${highRiskTasks.map((task) => `${task.task_id}: ${task.description}`).join('\n- ')}`
      : '',
    input.plannerFeedback && input.plannerFeedback.length > 0
      ? `Planner revision guidance:\n- ${input.plannerFeedback.join('\n- ')}`
      : '',
  ].filter(Boolean);
  return sections.join('\n');
}

async function requestPlanningReviewText(
  missionId: string,
  payload: SlackPayload,
  reviewerAgentId: string,
  prompt: string
): Promise<string> {
  const response = await a2aBridge.route({
    a2a_version: '1.0',
    header: {
      msg_id: `REQ-${Date.now().toString(36).toUpperCase()}-REVIEW`,
      sender: 'kyberion:mission-orchestrator',
      receiver: reviewerAgentId,
      performative: 'request',
      timestamp: new Date().toISOString(),
    },
    payload: {
      intent: 'mission_kickoff_plan_review',
      text: prompt,
      context: {
        channel: 'slack',
        slack_channel: payload.channel,
        thread: payload.threadTs,
        execution_mode: 'task',
        mission_id: missionId,
        team_role: 'reviewer',
      },
    },
  });
  return String(response.payload?.text || '');
}

async function requestPlanningPacketText(
  missionId: string,
  payload: SlackPayload,
  plannerAgentId: string,
  prompt: string
): Promise<string> {
  const response = await a2aBridge.route({
    a2a_version: '1.0',
    header: {
      msg_id: `REQ-${Date.now().toString(36).toUpperCase()}`,
      sender: 'kyberion:mission-orchestrator',
      receiver: plannerAgentId,
      performative: 'request',
      timestamp: new Date().toISOString(),
    },
    payload: {
      intent: 'mission_kickoff_planning',
      text: prompt,
      context: {
        channel: 'slack',
        slack_channel: payload.channel,
        thread: payload.threadTs,
        execution_mode: 'task',
        mission_id: missionId,
        team_role: 'planner',
      },
    },
  });
  return String(response.payload?.text || '');
}

export async function resolveMissionPlanningPacket(
  missionId: string,
  plan: ReturnType<typeof resolveMissionTeamPlan>,
  payload: SlackPayload,
  plannerAgentId: string,
  teamView: Record<string, unknown>
): Promise<PlanningPacket> {
  const kickoffPrompt = buildPlannerKickoffPrompt(missionId, plan, payload, teamView);
  let kickoffText = await requestPlanningPacketText(
    missionId,
    payload,
    plannerAgentId,
    kickoffPrompt
  );
  let kickoffBlocks = extractPlanningPacketBlocks(kickoffText);
  let planningPacket = kickoffBlocks.planningPackets[0];

  if (!planningPacket) {
    const retryPrompt = buildPlannerRetryPrompt(
      missionId,
      kickoffBlocks.planningPacketErrors.length > 0
        ? kickoffBlocks.planningPacketErrors
        : ['missing planning_packet block'],
      kickoffText
    );
    kickoffText = await requestPlanningPacketText(missionId, payload, plannerAgentId, retryPrompt);
    kickoffBlocks = extractPlanningPacketBlocks(kickoffText);
    planningPacket = kickoffBlocks.planningPackets[0];
  }

  if (!planningPacket) {
    throw new Error(
      `Planner response for ${missionId} failed planning_packet validation after retry: ${
        kickoffBlocks.planningPacketErrors.length > 0
          ? kickoffBlocks.planningPacketErrors.join('; ')
          : 'no planning_packet block returned'
      }`
    );
  }

  if (packetRequiresIndependentReview(planningPacket)) {
    const reviewerAssignment = resolveMissionTeamReceiver({ missionId, teamRole: 'reviewer' });
    const reviewerAgentId = reviewerAssignment?.agent_id || plannerAgentId;
    let reviewText = await requestPlanningReviewText(
      missionId,
      payload,
      reviewerAgentId,
      buildPlanningReviewPrompt({
        missionId,
        plan,
        payload,
        teamView,
        packet: planningPacket,
      })
    );
    let reviewVerdict = parsePlanningReviewVerdict(reviewText);
    if (!reviewVerdict.approve) {
      const retryPrompt = buildPlannerRetryPrompt(
        missionId,
        reviewVerdict.gaps.length > 0
          ? reviewVerdict.gaps
          : [reviewVerdict.rationale || 'planning review rejected the packet'],
        kickoffText
      );
      kickoffText = await requestPlanningPacketText(
        missionId,
        payload,
        plannerAgentId,
        retryPrompt
      );
      kickoffBlocks = extractPlanningPacketBlocks(kickoffText);
      planningPacket = kickoffBlocks.planningPackets[0];
      if (!planningPacket) {
        throw new Error(
          `Planner response for ${missionId} failed planning_packet validation after review retry: ${
            kickoffBlocks.planningPacketErrors.length > 0
              ? kickoffBlocks.planningPacketErrors.join('; ')
              : 'no planning_packet block returned'
          }`
        );
      }

      reviewText = await requestPlanningReviewText(
        missionId,
        payload,
        reviewerAgentId,
        buildPlanningReviewPrompt({
          missionId,
          plan,
          payload,
          teamView,
          packet: planningPacket,
          plannerFeedback: reviewVerdict.gaps,
        })
      );
      reviewVerdict = parsePlanningReviewVerdict(reviewText);
      if (!reviewVerdict.approve) {
        throw new Error(
          `Planning review rejected packet for ${missionId}: ${
            reviewVerdict.gaps.length > 0
              ? reviewVerdict.gaps.join('; ')
              : reviewVerdict.rationale || 'no review gaps returned'
          }`
        );
      }
    }
  }

  return planningPacket;
}

function summarizeMissionTaskOutcomes(missionId: string): {
  acceptedCount: number;
  reviewedCount: number;
  completedCount: number;
  requestedCount: number;
} {
  const tasks = loadAllNextTasks(missionId);
  return {
    acceptedCount: tasks.filter((task) => task.status === 'accepted').length,
    reviewedCount: tasks.filter((task) => task.status === 'reviewed').length,
    completedCount: tasks.filter((task) => task.status === 'completed').length,
    requestedCount: tasks.filter((task) => task.status === 'requested').length,
  };
}

async function handleMissionIssueRequested(event: MissionOrchestrationEvent<SlackPayload>) {
  const payload = event.payload;
  const missionId = event.mission_id;
  const env = buildExecutionEnv(process.env, 'mission_controller');
  const tier = payload.tier || 'public';
  const persona = payload.persona || 'Ecosystem Architect';
  const missionType = resolveMissionType(payload);

  runMissionController(env, ['start', missionId, tier, persona, 'default', missionType]);
  emitSlackMissionEvent(
    payload,
    missionId,
    'mission_issued',
    'Mission was issued from an orchestration event.',
    {
      mission_type: missionType,
      tier,
    }
  );

  const nextEvent = enqueueMissionOrchestrationEvent({
    eventType: 'mission_team_prewarm_requested',
    missionId,
    requestedBy: 'mission_orchestration_worker',
    correlationId: event.correlation_id || event.event_id,
    causationId: event.event_id,
    payload: {
      ...payload,
      teamRoles: payload.teamRoles?.length ? payload.teamRoles : ['planner'],
    },
  });
  startMissionOrchestrationWorker(nextEvent);
}

async function handleMissionTeamPrewarmRequested(event: MissionOrchestrationEvent<SlackPayload>) {
  const payload = event.payload;
  const missionId = event.mission_id;

  emitSlackMissionEvent(
    payload,
    missionId,
    'mission_orchestration_started',
    'Background mission orchestration started.'
  );

  const runtimePlan = await ensureMissionTeamRuntimeViaSupervisor({
    missionId,
    teamRoles: payload.teamRoles?.length ? payload.teamRoles : ['planner'],
    requestedBy: 'mission_orchestration_worker',
    reason: 'Prewarm agent runtime before kickoff.',
    timeoutMs: MISSION_CONTROLLER_TIMEOUT_MS,
  });

  emitSlackMissionEvent(
    payload,
    missionId,
    'mission_team_staffed',
    'Required team runtimes were prewarmed.',
    {
      assignments: runtimePlan.runtime_plan.assignments.map((assignment) => ({
        team_role: assignment.team_role,
        agent_id: assignment.agent_id,
        runtime_status: assignment.runtime_status,
      })),
    }
  );

  const nextEvent = enqueueMissionOrchestrationEvent({
    eventType: 'mission_kickoff_requested',
    missionId,
    requestedBy: 'mission_orchestration_worker',
    correlationId: event.correlation_id || event.event_id,
    causationId: event.event_id,
    payload,
  });
  startMissionOrchestrationWorker(nextEvent);
}

async function handleMissionKickoffRequested(event: MissionOrchestrationEvent<SlackPayload>) {
  const payload = event.payload;
  const missionId = event.mission_id;
  await emitWorkerKickoffSnapshot(missionId, payload);
  const env = buildExecutionEnv(process.env, 'mission_controller');

  runMissionController(env, [
    'record-task',
    missionId,
    'Initial planning kickoff from mission orchestration event',
    JSON.stringify({
      source: 'slack',
      channel: payload.channel,
      threadTs: payload.threadTs,
      sourceText: payload.sourceText,
      proposal: payload.proposal,
    }),
  ]);

  const plan = resolveMissionTeamPlan({ missionId });
  const plannerAssignment = resolveMissionTeamReceiver({ missionId, teamRole: 'planner' });
  if (!plannerAssignment?.agent_id) {
    throw new Error(`Planner assignment not found for ${missionId}`);
  }

  const teamView = buildMissionTeamView(plan);
  const planningPacket = await resolveMissionPlanningPacket(
    missionId,
    plan,
    payload,
    plannerAssignment.agent_id,
    teamView
  );
  const kickoffExcerpt = JSON.stringify(planningPacket).slice(0, 240);
  logger.info(
    `[MISSION_ORCHESTRATION] Planner kickoff complete for ${missionId}: ${kickoffExcerpt}`
  );
  persistPlanningPacket(missionId, planningPacket);
  syncPlanningArtifacts(missionId);
  reconcileMissionProgress(missionId);
  emitSlackMissionEvent(
    payload,
    missionId,
    'mission_kickoff_completed',
    'Planner kickoff request was delivered.',
    {
      planner_agent_id: plannerAssignment.agent_id,
      planned_task_count: planningPacket.next_tasks.length,
    }
  );
  const nextEvent = enqueueMissionOrchestrationEvent({
    eventType: 'mission_followup_requested',
    missionId,
    requestedBy: 'mission_orchestration_worker',
    correlationId: event.correlation_id || event.event_id,
    causationId: event.event_id,
    payload,
  });
  startMissionOrchestrationWorker(nextEvent);
  await shutdownAllAgentRuntimes('mission_orchestration_worker');
}

async function handleMissionFollowupRequested(event: MissionOrchestrationEvent<SlackPayload>) {
  const payload = event.payload;
  const missionId = event.mission_id;
  emitWorkerTransitionSnapshot(missionId, 'execution', `Mission ${missionId} follow-up dispatched`);
  emitSlackMissionEvent(
    payload,
    missionId,
    'mission_followup_requested',
    'Planner artifacts were reconciled and follow-up delegation started.'
  );
  const dispatched = await dispatchMissionNextTasks(missionId);
  emitSlackMissionEvent(
    payload,
    missionId,
    'mission_followup_dispatched',
    'Planner-produced follow-up tasks were delegated.',
    {
      dispatched_tasks: dispatched,
    }
  );
  const nextEvent = enqueueMissionOrchestrationEvent({
    eventType: 'mission_reconciliation_requested',
    missionId,
    requestedBy: 'mission_orchestration_worker',
    correlationId: event.correlation_id || event.event_id,
    causationId: event.event_id,
    payload,
  });
  startMissionOrchestrationWorker(nextEvent);
  await shutdownAllAgentRuntimes('mission_orchestration_worker');
}

async function handleMissionReconciliationRequested(
  event: MissionOrchestrationEvent<SlackPayload>
) {
  const payload = event.payload;
  const missionId = event.mission_id;
  emitWorkerTransitionSnapshot(
    missionId,
    'verification',
    `Mission ${missionId} reconciling outcomes`
  );
  reconcileMissionProgress(missionId);
  emitSlackMissionEvent(
    payload,
    missionId,
    'mission_reconciliation_completed',
    'Mission task outcomes were reconciled into mission state.'
  );
  const summary = summarizeMissionTaskOutcomes(missionId);
  const gateSummary = summarizeMissionGateState(missionId);
  emitSlackMissionEvent(
    payload,
    missionId,
    'mission_owner_notified',
    'Owner summary emitted after reconciliation.',
    {
      accepted_count: summary.acceptedCount,
      reviewed_count: summary.reviewedCount,
      completed_count: summary.completedCount,
      requested_count: summary.requestedCount,
      gate_rework_count: gateSummary.reworkCount,
      gate_statuses: gateSummary.lines,
    }
  );
  enqueueSlackOutboxMessage({
    correlationId: missionId,
    channel: payload.channel,
    threadTs: payload.threadTs,
    source: 'system',
    text: [
      `Mission ${missionId} progress update.`,
      `Accepted: ${summary.acceptedCount}`,
      `Reviewed: ${summary.reviewedCount}`,
      `Completed: ${summary.completedCount}`,
      `Requested: ${summary.requestedCount}`,
      `Gate rework count: ${gateSummary.reworkCount}`,
      ...(gateSummary.lines.length > 0 ? ['Gate status:', ...gateSummary.lines] : []),
    ].join('\n'),
  });
  enqueueChronosOutboxMessage({
    correlationId: missionId,
    threadTs: missionId,
    source: 'system',
    text: [
      `Mission ${missionId} progress update.`,
      `Accepted: ${summary.acceptedCount}`,
      `Reviewed: ${summary.reviewedCount}`,
      `Completed: ${summary.completedCount}`,
      `Requested: ${summary.requestedCount}`,
      `Gate rework count: ${gateSummary.reworkCount}`,
      ...(gateSummary.lines.length > 0 ? ['Gate status:', ...gateSummary.lines] : []),
    ].join('\n'),
  });
  // Continue lifecycle: enqueue distillation
  const nextEvent = enqueueMissionOrchestrationEvent({
    eventType: 'mission_distillation_requested',
    missionId,
    requestedBy: 'mission_orchestration_worker',
    correlationId: event.correlation_id || event.event_id,
    causationId: event.event_id,
    payload,
  });
  startMissionOrchestrationWorker(nextEvent);
  await shutdownAllAgentRuntimes('mission_orchestration_worker');
}

async function handleMissionDistillationRequested(event: MissionOrchestrationEvent<SlackPayload>) {
  const payload = event.payload;
  const missionId = event.mission_id;
  emitWorkerTransitionSnapshot(
    missionId,
    'retrospective',
    `Mission ${missionId} distilling knowledge`
  );

  // Capture a heuristic validation snapshot alongside CLI distillation so
  // the retrospective phase closes the intent-loop "learn" stage even if
  // no heuristics have been validated yet.
  try {
    const report = summarizeHeuristics(10);
    const evidenceDir = missionEvidenceDir(missionId);
    if (evidenceDir) {
      safeWriteFile(
        nodePath.join(evidenceDir, 'heuristic-feedback-report.json'),
        `${JSON.stringify(report, null, 2)}\n`,
        { mkdir: true }
      );
    }
  } catch (err: any) {
    logger.warn(`[worker] heuristic summary skipped for ${missionId}: ${err?.message ?? err}`);
  }

  // Run distillation via mission controller CLI
  const env = buildExecutionEnv(process.env, 'mission_controller');
  try {
    runMissionController(env, ['distill', missionId]);
    emitSlackMissionEvent(
      payload,
      missionId,
      'mission_distillation_completed',
      'Mission knowledge was distilled into reusable learnings.'
    );
  } catch (error: any) {
    emitSlackMissionEvent(
      payload,
      missionId,
      'mission_distillation_failed',
      `Distillation failed: ${error.message}. Manual review recommended.`
    );
  }

  // Continue to completion
  const nextEvent2 = enqueueMissionOrchestrationEvent({
    eventType: 'mission_completion_requested',
    missionId,
    requestedBy: 'mission_orchestration_worker',
    correlationId: event.correlation_id || event.event_id,
    causationId: event.event_id,
    payload,
  });
  startMissionOrchestrationWorker(nextEvent2);
  await shutdownAllAgentRuntimes('mission_orchestration_worker');
}

async function handleMissionCompletionRequested(event: MissionOrchestrationEvent<SlackPayload>) {
  const payload = event.payload;
  const missionId = event.mission_id;
  emitWorkerTransitionSnapshot(missionId, 'delivery', `Mission ${missionId} completing lifecycle`);

  const env = buildExecutionEnv(process.env, 'mission_controller');
  try {
    runMissionController(env, ['finish', missionId]);
    emitSlackMissionEvent(
      payload,
      missionId,
      'mission_completed',
      'Mission lifecycle completed. Artifacts and learnings are archived.'
    );
  } catch (error: any) {
    emitSlackMissionEvent(
      payload,
      missionId,
      'mission_completion_failed',
      `Completion failed: ${error.message}. Manual intervention required.`
    );
  }

  enqueueSlackOutboxMessage({
    correlationId: missionId,
    channel: payload.channel,
    threadTs: payload.threadTs,
    source: 'system',
    text: `Mission ${missionId} lifecycle completed.`,
  });
  enqueueChronosOutboxMessage({
    correlationId: missionId,
    threadTs: missionId,
    source: 'system',
    text: `Mission ${missionId} lifecycle completed.`,
  });
  await shutdownAllAgentRuntimes('mission_orchestration_worker');
}

async function handleMissionControlRequested(
  event: MissionOrchestrationEvent<MissionControlPayload>
) {
  const env = buildExecutionEnv(process.env, 'mission_controller');
  const missionId = event.mission_id;
  const operation = event.payload.operation;

  switch (operation) {
    case 'resume':
      {
        const replayPlan = loadMissionOrchestrationReplayPlan(missionId);
        const recovery = recoverMissionRequestedTasks(missionId);
        if (replayPlan.next_event) {
          startMissionOrchestrationWorker(replayPlan.next_event);
        }
        emitMissionOrchestrationObservation({
          decision: 'mission_resume_replay_planned',
          event_type: 'mission_control_requested',
          requested_by: event.requested_by,
          mission_id: missionId,
          next_event_id: replayPlan.next_event?.event_id,
          next_event_type: replayPlan.next_event?.event_type,
          replay_count: replayPlan.replay_count,
          recovered_task_count: recovery.reissued_count,
          waiting_task_count: recovery.waiting_count,
        });
      }
      runMissionController(env, ['resume', missionId]);
      break;
    case 'refresh_team':
      runMissionController(env, ['team', missionId, '--refresh']);
      break;
    case 'prewarm_team':
      runMissionController(env, ['prewarm', missionId]);
      break;
    case 'staff_team':
      runMissionController(env, ['staff', missionId]);
      break;
    case 'finish':
      runMissionController(env, ['finish', missionId]);
      break;
    default:
      throw new Error(`Unsupported mission control operation: ${String(operation)}`);
  }

  emitMissionOrchestrationObservation({
    decision: 'mission_control_action_applied',
    event_type: 'mission_control_action_applied',
    requested_by: event.requested_by,
    mission_id: missionId,
    operation,
    why: 'Event-driven mission control action executed by the orchestration worker.',
  });
}

async function handleSurfaceControlRequested(
  event: MissionOrchestrationEvent<SurfaceControlPayload>
) {
  const operation = event.payload.operation;
  const surfaceId = event.payload.surfaceId;
  const env = buildExecutionEnv(process.env, 'surface_runtime');
  const args = ['dist/scripts/surface_runtime.js', '--action'];

  if (operation === 'reconcile' || operation === 'status') {
    args.push(operation);
  } else if ((operation === 'start' || operation === 'stop') && surfaceId) {
    args.push(operation, '--surface', surfaceId);
  } else {
    throw new Error(`Unsupported surface control operation: ${String(operation)}`);
  }

  safeExec('node', args, {
    cwd: pathResolver.rootDir(),
    env,
    timeoutMs: MISSION_CONTROLLER_TIMEOUT_MS,
  });
  emitMissionOrchestrationObservation({
    decision: 'surface_control_action_applied',
    event_type: 'surface_control_action_applied',
    requested_by: event.requested_by,
    resource_id: surfaceId || 'surface-runtime',
    mission_id: event.mission_id,
    operation,
    why: 'Event-driven surface control action executed by the orchestration worker.',
  });
}

export async function processMissionOrchestrationEventPath(eventPath: string): Promise<void> {
  ensureWorkerBackendsInstalled();
  const event = loadMissionOrchestrationEvent<SlackPayload>(eventPath);
  emitMissionOrchestrationObservation({
    decision: 'mission_orchestration_event_started',
    event_id: event.event_id,
    event_type: event.event_type,
    mission_id: event.mission_id,
  });

  try {
    switch (event.event_type) {
      case 'mission_issue_requested':
        await handleMissionIssueRequested(event);
        break;
      case 'mission_team_prewarm_requested':
        await handleMissionTeamPrewarmRequested(event);
        break;
      case 'mission_kickoff_requested':
        await handleMissionKickoffRequested(event);
        break;
      case 'mission_followup_requested':
        await handleMissionFollowupRequested(event);
        break;
      case 'mission_reconciliation_requested':
        await handleMissionReconciliationRequested(event);
        break;
      case 'mission_distillation_requested':
        await handleMissionDistillationRequested(event);
        break;
      case 'mission_completion_requested':
        await handleMissionCompletionRequested(event);
        break;
      case 'mission_control_requested':
        await handleMissionControlRequested(
          event as unknown as MissionOrchestrationEvent<MissionControlPayload>
        );
        break;
      case 'surface_control_requested':
        await handleSurfaceControlRequested(
          event as unknown as MissionOrchestrationEvent<SurfaceControlPayload>
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
    });
    emitMissionOrchestrationObservation({
      decision: 'mission_orchestration_event_completed',
      event_id: event.event_id,
      event_type: event.event_type,
      mission_id: event.mission_id,
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
    });
    emitMissionOrchestrationObservation({
      decision: 'mission_orchestration_event_failed',
      event_id: event.event_id,
      event_type: event.event_type,
      mission_id: event.mission_id,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
