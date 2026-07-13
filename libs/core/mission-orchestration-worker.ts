import { a2aBridge, AgentBusyError } from './a2a-bridge.js';
import {
  buildMissionTeamView,
  resolveMissionTeamPlan,
  resolveMissionTeamReceiver,
} from './mission-team-plan-composer.js';
import { resolveTaskModelHint } from './reasoning-model-routing.js';
import { type TaskModelPhaseKind } from './reasoning-level-policy.js';
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
  PlanningReviewVerdictSchema,
  renderStructuredOutputSchemaPrompt,
} from './structured-output-contracts.js';
import { evaluateMissionGate, type MissionGateDefinition } from './mission-gate-engine.js';
import {
  resolveArtifactReviewerProfile,
  type ArtifactReviewerProfile,
} from './mission-review-gates.js';
import {
  hashArtifactForReview,
  inferArtifactReviewKind,
  type ArtifactReviewReceipt,
} from './artifact-review.js';
import { draftRefine } from './draft-refine.js';
import {
  ensureMissionTeamRuntimeViaSupervisor,
  shutdownAllAgentRuntimes,
} from './agent-runtime-supervisor.js';
import { ledger } from './ledger.js';
import {
  claimWorkItem,
  importExternalWorkItem,
  releaseWorkItem,
  updateWorkItem,
} from './work-coordination.js';
import { logger } from './core.js';
import { buildWorkingPrinciplesLines } from './working-principles.js';
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
import * as path from 'node:path';
import {
  safeExec,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeReaddir,
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
  operation:
    | 'resume'
    | 'pause'
    | 'cancel'
    | 'refresh_team'
    | 'prewarm_team'
    | 'staff_team'
    | 'finish';
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
  rework_count?: number;
  assigned_to?: {
    role?: string;
    agent_id?: string;
  };
  description?: string;
  deliverable?: string;
  target_path?: string;
  dependencies?: string[];
  acceptance_criteria?: string[];
  risk?: string;
  expected_output_format?: 'text' | 'files' | 'structured';
  estimated_scope?: 'S' | 'M' | 'L';
  review_target?: string;
  review_round?: number;
  artifact_review_profile?: ArtifactReviewerProfile & {
    artifact_path?: string;
    artifact_sha256?: string;
    implementer_agent_ids: string[];
  };
  artifact_review_receipt?: string;
  reconciliation?: Record<string, unknown> & {
    evidence?: Array<{
      path: string;
      sha256?: string;
      kind: 'artifact' | 'test_report' | 'review' | 'trace' | 'receipt';
    }>;
  };
  last_result?: TaskResultBlock;
  review_findings?: Array<{
    severity: 'must_fix' | 'should_fix' | 'nit';
    location: string;
    instruction: string;
  }>;
  rework_packet?: {
    from_task: string;
    findings: Array<{
      severity: 'must_fix' | 'should_fix' | 'nit';
      location: string;
      instruction: string;
    }>;
    round: number;
  };
}

const PLANNED_NEXT_TASK_STATUS_PRIORITY: Record<string, number> = {
  requested: 0,
  planned: 1,
  rework: 2,
  blocked: 3,
  reviewed: 4,
  accepted: 5,
  completed: 6,
};

function validatePlannedNextTasks(rawTasks: unknown, missionId: string): PlannedNextTask[] {
  if (!Array.isArray(rawTasks)) {
    throw new Error(`Invalid NEXT_TASKS.json for ${missionId}: expected an array`);
  }

  const taskIds = new Set<string>();
  const tasks = rawTasks.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(
        `Invalid NEXT_TASKS.json for ${missionId}: task ${index + 1} is not an object`
      );
    }
    const task = entry as Record<string, unknown>;
    const taskId = String(task.task_id || '').trim();
    if (!taskId) {
      throw new Error(
        `Invalid NEXT_TASKS.json for ${missionId}: task ${index + 1} is missing task_id`
      );
    }
    if (taskIds.has(taskId)) {
      throw new Error(`Invalid NEXT_TASKS.json for ${missionId}: duplicate task_id ${taskId}`);
    }
    taskIds.add(taskId);

    const dependencies = Array.isArray(task.dependencies)
      ? task.dependencies.map((dependency) => String(dependency || '').trim()).filter(Boolean)
      : [];
    const acceptanceCriteria = Array.isArray(task.acceptance_criteria)
      ? task.acceptance_criteria.map((criterion) => String(criterion || '').trim()).filter(Boolean)
      : [];
    const assignedRole =
      typeof (task.assigned_to as Record<string, unknown> | undefined)?.role === 'string'
        ? String((task.assigned_to as Record<string, unknown>).role || '').trim()
        : '';
    const reviewTarget =
      typeof task.review_target === 'string' && task.review_target.trim()
        ? task.review_target.trim()
        : '';
    const deliverable =
      typeof task.deliverable === 'string' && task.deliverable.trim()
        ? task.deliverable.trim()
        : '';
    if (assignedRole === 'reviewer' || assignedRole === 'qa') {
      if (dependencies.length === 0) {
        throw new Error(
          `Invalid NEXT_TASKS.json for ${missionId}: reviewer task ${taskId} must depend on at least one completed task`
        );
      }
      if (!reviewTarget) {
        throw new Error(
          `Invalid NEXT_TASKS.json for ${missionId}: reviewer task ${taskId} is missing review_target`
        );
      }
      if (!dependencies.includes(reviewTarget)) {
        throw new Error(
          `Invalid NEXT_TASKS.json for ${missionId}: reviewer task ${taskId} must depend on review_target ${reviewTarget}`
        );
      }
      const expectedDeliverable = `REVIEW-${reviewTarget}.md`;
      if (!deliverable || nodePath.basename(deliverable) !== expectedDeliverable) {
        throw new Error(
          `Invalid NEXT_TASKS.json for ${missionId}: reviewer task ${taskId} must use deliverable ${expectedDeliverable}`
        );
      }
    }

    return {
      task_id: taskId,
      ...(typeof task.status === 'string' && task.status.trim()
        ? { status: task.status.trim() }
        : {}),
      ...(typeof task.rework_count === 'number' && Number.isFinite(task.rework_count)
        ? { rework_count: task.rework_count }
        : {}),
      ...(task.assigned_to && typeof task.assigned_to === 'object'
        ? {
            assigned_to: {
              ...(typeof (task.assigned_to as Record<string, unknown>).role === 'string' &&
              String((task.assigned_to as Record<string, unknown>).role || '').trim()
                ? { role: String((task.assigned_to as Record<string, unknown>).role).trim() }
                : {}),
              ...(typeof (task.assigned_to as Record<string, unknown>).agent_id === 'string' &&
              String((task.assigned_to as Record<string, unknown>).agent_id || '').trim()
                ? {
                    agent_id: String((task.assigned_to as Record<string, unknown>).agent_id).trim(),
                  }
                : {}),
            },
          }
        : {}),
      ...(typeof task.description === 'string' && task.description.trim()
        ? { description: task.description.trim() }
        : {}),
      ...(deliverable ? { deliverable } : {}),
      ...(typeof task.target_path === 'string' && task.target_path.trim()
        ? { target_path: task.target_path.trim() }
        : {}),
      dependencies,
      acceptance_criteria: acceptanceCriteria,
      ...(typeof task.risk === 'string' && task.risk.trim() ? { risk: task.risk.trim() } : {}),
      ...(typeof task.expected_output_format === 'string' && task.expected_output_format.trim()
        ? {
            expected_output_format:
              task.expected_output_format.trim() as PlannedNextTask['expected_output_format'],
          }
        : {}),
      ...(typeof task.estimated_scope === 'string' && task.estimated_scope.trim()
        ? { estimated_scope: task.estimated_scope.trim() as PlannedNextTask['estimated_scope'] }
        : {}),
      ...(reviewTarget ? { review_target: reviewTarget } : {}),
      ...(typeof task.review_round === 'number' && Number.isFinite(task.review_round)
        ? { review_round: task.review_round }
        : {}),
      ...(task.artifact_review_profile && typeof task.artifact_review_profile === 'object'
        ? {
            artifact_review_profile:
              task.artifact_review_profile as PlannedNextTask['artifact_review_profile'],
          }
        : {}),
      ...(typeof task.artifact_review_receipt === 'string' && task.artifact_review_receipt.trim()
        ? { artifact_review_receipt: task.artifact_review_receipt.trim() }
        : {}),
      ...(task.reconciliation && typeof task.reconciliation === 'object'
        ? { reconciliation: task.reconciliation as PlannedNextTask['reconciliation'] }
        : {}),
      ...(task.last_result && typeof task.last_result === 'object'
        ? { last_result: task.last_result as PlannedNextTask['last_result'] }
        : {}),
      ...(Array.isArray(task.review_findings)
        ? {
            review_findings: task.review_findings
              .map((finding) => {
                if (!finding || typeof finding !== 'object') return null;
                const entry = finding as Record<string, unknown>;
                const severity = String(entry.severity || '').trim();
                const location = String(entry.location || '').trim();
                const instruction = String(entry.instruction || '').trim();
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
                (finding): finding is NonNullable<PlannedNextTask['review_findings']>[number] =>
                  Boolean(finding)
              ),
          }
        : {}),
      ...(task.rework_packet && typeof task.rework_packet === 'object'
        ? {
            rework_packet: {
              from_task: String(
                (task.rework_packet as Record<string, unknown>).from_task || ''
              ).trim(),
              findings: Array.isArray((task.rework_packet as Record<string, unknown>).findings)
                ? ((task.rework_packet as Record<string, unknown>).findings as unknown[])
                    .map((finding) => {
                      if (!finding || typeof finding !== 'object') return null;
                      const entry = finding as Record<string, unknown>;
                      const severity = String(entry.severity || '').trim();
                      const location = String(entry.location || '').trim();
                      const instruction = String(entry.instruction || '').trim();
                      if (
                        (severity !== 'must_fix' &&
                          severity !== 'should_fix' &&
                          severity !== 'nit') ||
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
                      ): finding is NonNullable<
                        PlannedNextTask['rework_packet']
                      >['findings'][number] => Boolean(finding)
                    )
                : [],
              round: (() => {
                const rawRound = (task.rework_packet as Record<string, unknown>).round;
                return typeof rawRound === 'number' && Number.isFinite(rawRound) ? rawRound : 0;
              })(),
            },
          }
        : {}),
    } satisfies PlannedNextTask;
  });

  const adjacency = new Map<string, string[]>();
  for (const task of tasks) {
    for (const dependency of task.dependencies || []) {
      if (!taskIds.has(dependency)) {
        throw new Error(
          `Invalid NEXT_TASKS.json for ${missionId}: task ${task.task_id} depends on missing task ${dependency}`
        );
      }
    }
    adjacency.set(task.task_id, [...(task.dependencies || [])]);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): void => {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) {
      throw new Error(
        `Invalid NEXT_TASKS.json for ${missionId}: dependency cycle detected at ${taskId}`
      );
    }
    visiting.add(taskId);
    for (const dependency of adjacency.get(taskId) || []) {
      visit(dependency);
    }
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of tasks) {
    visit(task.task_id);
  }

  // E2E-03 Task 6: code changes are review-mandatory. A code_change mission
  // whose plan has implement work but no reviewer/qa task is a planner
  // contract violation — block before dispatch, not after damage.
  if (missionClassOf(missionId) === 'code_change') {
    const hasImplementWork = tasks.some((task) => {
      const role = String(task.assigned_to?.role || '').toLowerCase();
      return role !== 'reviewer' && role !== 'qa' && role !== 'planner';
    });
    const hasReviewTask = tasks.some((task) => {
      const role = String(task.assigned_to?.role || '').toLowerCase();
      return role === 'reviewer' || role === 'qa';
    });
    if (hasImplementWork && !hasReviewTask) {
      throw new Error(
        `Invalid NEXT_TASKS.json for ${missionId}: code_change missions require at least one reviewer/qa task (planner contract violation)`
      );
    }
  }

  return tasks;
}

function missionClassOf(missionId: string): string | undefined {
  const state = loadMissionStateSnapshot(missionId);
  const missionClass = String(
    (state?.classification as Record<string, unknown> | undefined)?.mission_class || ''
  ).trim();
  return missionClass || undefined;
}

function missionRiskProfileOf(missionId: string): string | undefined {
  const state = loadMissionStateSnapshot(missionId);
  const riskProfile = String(
    (state?.classification as Record<string, unknown> | undefined)?.risk_profile || ''
  ).trim();
  return riskProfile || undefined;
}

interface DispatchMissionTaskOutcome {
  task_id: string;
  team_role: string;
  agent_id: string;
  dispatched: boolean;
  allowSameInvocationRedispatch?: boolean;
  redispatchTaskIds?: string[];
  context_chars?: number;
  pruned_chars?: number;
  rollup_used: boolean;
  result_schema_ok: boolean;
  needs_count: number;
}

function areTaskDependenciesSatisfied(task: PlannedNextTask, tasks: PlannedNextTask[]): boolean {
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

function buildUnassignedRoleSummary(task: PlannedNextTask, teamRole?: string): string {
  const roleLabel = teamRole || 'unassigned';
  return `Task ${task.task_id} is blocked because role ${roleLabel} is not assigned.`;
}

function resolveReviewTargetForTask(task: PlannedNextTask): string | undefined {
  if (typeof task.review_target === 'string' && task.review_target.trim()) {
    return task.review_target.trim();
  }
  const deliverable = String(task.deliverable || '').trim();
  const match = deliverable.match(/(?:^|\/)REVIEW-(.+)\.md$/u);
  return match?.[1] ? match[1] : undefined;
}

function resolveReviewArtifact(input: {
  missionId: string;
  reviewTask: PlannedNextTask;
  tasks: PlannedNextTask[];
}): {
  targetTask: PlannedNextTask;
  absolutePath?: string;
  repositoryPath?: string;
  kind: 'doc' | 'deck' | 'code' | 'media';
  sha256?: string;
  implementerAgentIds: string[];
} | null {
  const reviewTarget = resolveReviewTargetForTask(input.reviewTask);
  if (!reviewTarget) return null;
  const targetTask = input.tasks.find((task) => task.task_id === reviewTarget);
  if (!targetTask) return null;
  const missionPath = missionDir(input.missionId, 'public');
  const diffPath = nodePath.join(missionPath, 'evidence', 'prs', reviewTarget, 'diff.patch');
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
  let absolutePath: string | undefined;
  for (const candidate of candidates) {
    const possiblePaths = nodePath.isAbsolute(candidate)
      ? [candidate]
      : [nodePath.join(missionPath, candidate), pathResolver.rootResolve(candidate)];
    absolutePath = possiblePaths.find((possible) => safeExistsSync(possible));
    if (absolutePath) break;
  }
  const kind = inferArtifactReviewKind(
    String(targetTask.target_path || absolutePath || targetTask.deliverable || '')
  );
  const targetRole = String(targetTask.assigned_to?.role || '').trim();
  const resolvedAgent =
    targetRole && !targetTask.assigned_to?.agent_id
      ? resolveMissionTeamReceiver({ missionId: input.missionId, teamRole: targetRole })?.agent_id
      : undefined;
  const implementerAgentIds = Array.from(
    new Set(
      [targetTask.assigned_to?.agent_id, resolvedAgent].filter((value): value is string =>
        Boolean(value)
      )
    )
  );
  return {
    targetTask,
    ...(absolutePath
      ? {
          absolutePath,
          repositoryPath: pathResolver.toRepoRelative(absolutePath),
          sha256: hashArtifactForReview(absolutePath),
        }
      : {}),
    kind,
    implementerAgentIds,
  };
}

function prepareArtifactReviewTask(input: {
  missionId: string;
  reviewTask: PlannedNextTask;
  tasks: PlannedNextTask[];
}): ReturnType<typeof resolveReviewArtifact> {
  const artifact = resolveReviewArtifact(input);
  if (!artifact) return null;
  input.reviewTask.artifact_review_profile = {
    ...resolveArtifactReviewerProfile({
      artifactKind: artifact.kind,
      missionClass: missionClassOf(input.missionId),
      riskProfile:
        missionRiskProfileOf(input.missionId) || artifact.targetTask.risk || input.reviewTask.risk,
    }),
    ...(artifact.repositoryPath ? { artifact_path: artifact.repositoryPath } : {}),
    ...(artifact.sha256 ? { artifact_sha256: artifact.sha256 } : {}),
    implementer_agent_ids: artifact.implementerAgentIds,
  };
  return artifact;
}

function buildArtifactReviewLines(task: PlannedNextTask): string[] {
  const profile = task.artifact_review_profile;
  if (!profile) return [];
  return [
    '## Artifact quality review mandate',
    `- Specialist perspectives: ${profile.required_reviewer_roles.join(', ')}`,
    `- Independence required: ${profile.independence_required}`,
    profile.implementer_agent_ids.length > 0
      ? `- Must be independent from: ${profile.implementer_agent_ids.join(', ')}`
      : '- Implementer identity unavailable; explicitly report any independence uncertainty.',
    profile.artifact_path ? `- Artifact: ${profile.artifact_path}` : '- Artifact path unavailable.',
    profile.artifact_sha256 ? `- Artifact SHA-256: ${profile.artifact_sha256}` : '',
    `- ${profile.rationale}`,
    '- Try to falsify every acceptance criterion. Report concrete defects rather than affirming the author.',
    '- Use must_fix only for defects that block acceptance; should_fix and nit do not block completion.',
    '',
  ].filter(Boolean);
}

function persistArtifactReviewReceipt(input: {
  missionId: string;
  reviewTask: PlannedNextTask;
  teamRole: 'reviewer' | 'qa';
  reviewerAgentId: string;
  artifact: NonNullable<ReturnType<typeof resolveReviewArtifact>>;
  findings: Array<{
    severity: 'must_fix' | 'should_fix' | 'nit';
    location: string;
    instruction: string;
  }>;
  reviewRound: number;
}): string | null {
  const profile = input.reviewTask.artifact_review_profile;
  if (!profile || !input.artifact.repositoryPath || !input.artifact.sha256) return null;
  const blocking = input.findings.some((finding) => finding.severity === 'must_fix');
  const missionPath = missionDir(input.missionId, 'public');
  const relativePath = `evidence/reviews/${input.reviewTask.task_id}-r${input.reviewRound}.json`;
  const receiptPath = nodePath.join(missionPath, relativePath);
  const receipt: ArtifactReviewReceipt = {
    kind: 'artifact-review-receipt',
    version: '1.0.0',
    review_id: `${input.reviewTask.task_id}-r${input.reviewRound}`,
    mission_id: input.missionId,
    review_task_id: input.reviewTask.task_id,
    review_target_task_id: input.artifact.targetTask.task_id,
    artifact: {
      path: input.artifact.repositoryPath,
      sha256: input.artifact.sha256,
      kind: input.artifact.kind,
    },
    reviewer: {
      agent_id: input.reviewerAgentId,
      team_role: input.teamRole,
      specialist_roles: profile.required_reviewer_roles,
      independent_from: profile.implementer_agent_ids,
      independence_verified:
        profile.implementer_agent_ids.length > 0 &&
        !profile.implementer_agent_ids.includes(input.reviewerAgentId),
    },
    verdict: blocking ? 'changes_requested' : 'approved',
    findings: input.findings.map((finding) => ({
      severity: finding.severity === 'must_fix' ? 'blocking' : 'suggestion',
      category: 'artifact_quality',
      description: finding.instruction,
      ...(finding.severity === 'must_fix' ? { required_action: finding.instruction } : {}),
      location: finding.location,
    })),
    acceptance_criteria: input.reviewTask.acceptance_criteria?.length
      ? input.reviewTask.acceptance_criteria
      : [input.reviewTask.description || `Review ${input.artifact.targetTask.task_id}`],
    reviewed_at: new Date().toISOString(),
  };
  safeMkdir(nodePath.dirname(receiptPath), { recursive: true });
  safeWriteFile(receiptPath, JSON.stringify(receipt, null, 2));
  input.reviewTask.artifact_review_receipt = relativePath;
  return relativePath;
}

function normalizeReviewFindings(
  findings: unknown
): Array<{ severity: 'must_fix' | 'should_fix' | 'nit'; location: string; instruction: string }> {
  if (!Array.isArray(findings)) return [];
  return findings
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const finding = entry as Record<string, unknown>;
      const severity = String(finding.severity || '').trim();
      const location = String(finding.location || '').trim();
      const instruction = String(finding.instruction || '').trim();
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
        entry
      ): entry is {
        severity: 'must_fix' | 'should_fix' | 'nit';
        location: string;
        instruction: string;
      } => Boolean(entry)
    );
}

function summarizeTaskResultForPrompt(task: PlannedNextTask): string | null {
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

function buildUpstreamResultLines(task: PlannedNextTask, tasks: PlannedNextTask[]): string[] {
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

function buildTeamSnapshotLines(tasks: PlannedNextTask[]): string[] {
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

function buildReviewFindingsLines(task: PlannedNextTask): string[] {
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

/**
 * The mission's interpreted goal (why the work exists — not the task wording).
 * Without this section every worker optimizes for its task's 字面 and the
 * team drifts from the user's actual purpose (IL-01/E2E-03 follow-up).
 */
function buildMissionGoalLines(missionState: Record<string, unknown>): string[] {
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

function buildTaskExecutionPrompt(input: {
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
    '',
    ...input.missionGoalLines,
    ...buildWorkingPrinciplesLines(input.teamRole),
    '## Upstream results (inputs you MUST build on)',
    ...input.upstreamResultLines,
    '',
    '## Team snapshot (do not duplicate; stay consistent with completed work)',
    ...input.teamSnapshotLines,
    'Already completed work must keep terminology, structure, and style aligned.',
    'Do not trespass into another task’s scope; if needed, put it in needs.',
    '',
    ...(input.reviewFindingsLines.length > 0 &&
    !(input.reviewFindingsLines.length === 1 && input.reviewFindingsLines[0] === '- none')
      ? ['## Review findings to address', ...input.reviewFindingsLines, '']
      : []),
    ...input.artifactReviewLines,
    input.missionContextPack,
    '',
    'Return exactly one ```task_result``` block and nothing else structured.',
    `Schema: ${renderStructuredOutputSchemaPrompt('task_result')}`,
    resolveReviewTargetForTask(input.task)
      ? 'For review tasks, put concrete findings into review_findings[] using severity, location, and instruction. Keep gaps for unresolved blockers.'
      : 'Do not paste file contents. Include only conclusions, artifact paths, verification steps, gaps, and needs.',
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
    `Schema: ${renderStructuredOutputSchemaPrompt('task_result')}`,
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

function looksLikePath(value: string): boolean {
  return /[\\/]/u.test(value) || /\.[A-Za-z0-9]+$/u.test(value);
}

async function evaluateTaskAcceptanceGate(input: {
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

async function buildTaskDispatchContext(input: {
  missionId: string;
  task: PlannedNextTask;
  teamRole: string;
  agentId: string;
  taskModelHint?: { model_id?: string; tier?: string; effort?: string; route_reason?: string };
  allTasks: PlannedNextTask[];
}): Promise<{
  prompt: string;
  missionContextPackId?: string;
  missionContextPackPath?: string;
  missionContextPackSummary: string;
  missionContextPackPruningSummary?: MissionContextPackPruningSummary;
  securityScope?: import('./context-security-scope.js').ContextSecurityScope;
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
  const upstreamResultLines = [
    ...buildUpstreamResultLines(input.task, input.allTasks),
    ...buildReviewDiffLines(input.missionId, input.task),
  ];
  const teamSnapshotLines = buildTeamSnapshotLines(input.allTasks);
  const reviewFindingsLines = buildReviewFindingsLines(input.task);
  if (input.teamRole === 'reviewer' || input.teamRole === 'qa') {
    prepareArtifactReviewTask({
      missionId: input.missionId,
      reviewTask: input.task,
      tasks: input.allTasks,
    });
  }
  const artifactReviewLines = buildArtifactReviewLines(input.task);
  const promptSupplementChars =
    upstreamResultLines.join('\n').length +
    teamSnapshotLines.join('\n').length +
    reviewFindingsLines.join('\n').length +
    artifactReviewLines.join('\n').length +
    256;
  const prompt = buildTaskExecutionPrompt({
    missionId: input.missionId,
    task: input.task,
    teamRole: input.teamRole,
    agentId: input.agentId,
    taskModelHint: input.taskModelHint,
    missionContextPack: missionContextPackText,
    missionGoalLines: buildMissionGoalLines(missionState),
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
  };
}

// MO-03 Task 2.3: per-task wall-clock budget derived from estimated_scope.
// A hung dispatch must not stall the whole wave silently — on timeout the
// task is marked blocked(timeout) and downstream dependents cascade to
// blocked(dependency) instead of waiting forever.
const TASK_DISPATCH_TIMEOUT_MS: Record<'S' | 'M' | 'L', number> = {
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

async function withTaskDispatchTimeout(
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

async function dispatchPlannedMissionTask(input: {
  missionId: string;
  task: PlannedNextTask;
  teamRole: string;
  assignment: {
    agent_id: string;
    model_hint?: { model_id?: string; tier?: string; effort?: string; route_reason?: string };
    organization_role_id?: string;
    perspective_ids?: string[];
    reasoning_route_id?: string;
    selection_reason_codes?: string[];
    provider?: string | null;
    modelId?: string | null;
  };
  allTasks: PlannedNextTask[];
}): Promise<DispatchMissionTaskOutcome | null> {
  const workItemSourceRef = `mission:${input.missionId}:${input.task.task_id}`;
  const workItem = importExternalWorkItem({
    source: 'local',
    sourceRef: workItemSourceRef,
    title: input.task.description || input.task.task_id,
    description: input.task.description || input.task.task_id,
    status: 'ready',
    priority: 'normal',
    projectId: input.missionId,
    assigneePeerId: input.assignment.agent_id,
    labels: [`mission:${input.missionId}`, `team_role:${input.teamRole}`],
    dependencies: Array.isArray(input.task.dependencies) ? input.task.dependencies : [],
    metadata: {
      deliverable: input.task.deliverable,
      target_path: input.task.target_path,
      acceptance_criteria: input.task.acceptance_criteria,
      risk: input.task.risk,
      estimated_scope: input.task.estimated_scope,
      task_id: input.task.task_id,
      mission_id: input.missionId,
    },
  });
  const claimed = claimWorkItem({
    itemId: workItem.item_id,
    actorPeerId: 'mission-orchestration-worker',
    purpose: `dispatch mission task ${input.missionId}/${input.task.task_id}`,
    expectedVersion: workItem.version,
    idempotencyKey: workItemSourceRef,
    metadata: {
      mission_id: input.missionId,
      task_id: input.task.task_id,
      team_role: input.teamRole,
      deliverable: input.task.deliverable,
      target_path: input.task.target_path,
      acceptance_criteria: input.task.acceptance_criteria,
      risk: input.task.risk,
      estimated_scope: input.task.estimated_scope,
    },
  });
  let dispatchContext;
  let response;
  try {
    dispatchContext = await buildTaskDispatchContext({
      missionId: input.missionId,
      task: input.task,
      teamRole: input.teamRole,
      agentId: input.assignment.agent_id,
      taskModelHint: input.assignment.model_hint,
      allTasks: input.allTasks,
    });
    const dispatchArgs = {
      missionId: input.missionId,
      task: input.task,
      teamRole: input.teamRole,
      agentId: input.assignment.agent_id,
      taskModelHint: input.assignment.model_hint,
      prompt: dispatchContext.prompt,
      securityScope: dispatchContext.securityScope,
    };
    response = isBestOfNCandidate({ teamRole: input.teamRole, task: input.task })
      ? await obtainBestOfTaskResultResponse(dispatchArgs)
      : await obtainTaskResultResponse(dispatchArgs);
  } catch (err: any) {
    if (err instanceof AgentBusyError || err?.name === 'AgentBusyError') {
      logger.warn(
        `[MISSION_WORKER] Agent ${input.assignment.agent_id} is busy. Resetting task ${input.task.task_id} to planned for retry.`
      );
      input.task.status = 'planned';
      try {
        releaseWorkItem({
          itemId: workItem.item_id,
          actorPeerId: 'mission-orchestration-worker',
          expectedVersion: claimed.item.version,
          leaseId: claimed.lease.lease_id,
        });
      } catch (releaseErr: any) {
        logger.error(`[MISSION_WORKER] Failed to release work item claim: ${releaseErr.message}`);
      }
      return null;
    }
    throw err;
  }
  emitMissionTaskEvent({
    event_type: 'participant_context_resolved',
    mission_id: input.missionId,
    task_id: input.task.task_id,
    agent_id: input.assignment.agent_id,
    team_role: input.teamRole,
    decision: 'dispatch_context_compiled',
    why: 'Record the resolved execution actor, perspective, model route, and security scope.',
    policy_used: 'participant_context_v1',
    evidence: dispatchContext.missionContextPackPath
      ? [dispatchContext.missionContextPackPath]
      : [],
    payload: {
      organization_role_id: input.assignment.organization_role_id,
      perspective_ids: input.assignment.perspective_ids,
      reasoning_route_id: input.assignment.reasoning_route_id,
      selection_reason_codes: input.assignment.selection_reason_codes,
      provider: input.assignment.provider,
      model_id: input.assignment.modelId,
      security_scope: dispatchContext.securityScope,
      context_pack_id: dispatchContext.missionContextPackId,
    },
  });
  const taskResultNeeds = response.taskResult?.needs || [];
  const reviewFindings = normalizeReviewFindings(
    response.taskResult?.review_findings ||
      (input.teamRole === 'reviewer' || input.teamRole === 'qa'
        ? (response.taskResult?.gaps || []).map((gap) => ({
            severity: 'must_fix' as const,
            location: reviewTarget || input.task.deliverable || input.task.task_id,
            instruction: String(gap || '').trim(),
          }))
        : [])
  );
  if (response.taskResult) {
    input.task.last_result = {
      ...response.taskResult,
      review_findings:
        reviewFindings.length > 0 ? reviewFindings : response.taskResult.review_findings,
    };
  }
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
          missionId: input.missionId,
          task: input.task,
          taskResult: response.taskResult,
        })
      : undefined;
  const clarificationPacketPath = clarificationPacket
    ? taskClarificationFilePath(input.missionId, input.task.task_id)
    : undefined;

  if (taskResultBlocked && clarificationPacket && clarificationPacketPath) {
    updateWorkItem({
      itemId: claimed.item.item_id,
      expectedVersion: claimed.item.version,
      status: 'blocked',
      metadata: {
        summary: 'Task result needs clarification before completion',
        blocked_reason: 'task_result_needs_input',
        mission_id: input.missionId,
        task_id: input.task.task_id,
        team_role: input.teamRole,
      },
    });
    safeWriteFile(
      clarificationPacketPath,
      JSON.stringify(
        {
          mission_id: input.missionId,
          task_id: input.task.task_id,
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
    input.task.status = 'blocked';
    emitMissionTaskEvent({
      event_type: 'task_reviewed',
      mission_id: input.missionId,
      task_id: input.task.task_id,
      agent_id: input.assignment.agent_id,
      team_role: input.teamRole,
      decision: 'task_reviewed',
      why: 'Task result still needs clarification before the work can continue.',
      policy_used: 'mission_orchestration_control_plane_v1',
      evidence: input.task.deliverable ? [String(input.task.deliverable)] : [],
      payload: {
        description: input.task.description,
        deliverable: input.task.deliverable,
        clarification_packet_path: clarificationPacketPath,
        needs: taskResultNeeds,
        task_result: response.taskResult,
        task_result_errors: response.parseErrors,
        ...taskResultObservability,
      },
    });
    recordMissionContextTask(input.missionId, `Blocked work item ${input.task.task_id}`, {
      next_step: 'resolve the missing inputs before retrying the work item',
      work_item_id: input.task.task_id,
      team_role: input.teamRole,
      assignee_peer_id: input.assignment.agent_id,
      execution_mode: response.executionMode,
      context_pack_id: dispatchContext.missionContextPackId,
      context_pack_path: dispatchContext.missionContextPackPath,
      context_pack_summary: dispatchContext.missionContextPackSummary,
      context_pack_pruning_summary: dispatchContext.missionContextPackPruningSummary,
      ...taskResultObservability,
    });
    return {
      task_id: input.task.task_id,
      team_role: input.teamRole,
      agent_id: input.assignment.agent_id,
      dispatched: false,
      ...taskResultObservability,
    };
  }

  if (taskResultBlocked) {
    updateWorkItem({
      itemId: claimed.item.item_id,
      expectedVersion: claimed.item.version,
      status: 'blocked',
      metadata: {
        summary: 'Task result did not satisfy the structured response contract',
        blocked_reason: 'task_result_unstructured',
        mission_id: input.missionId,
        task_id: input.task.task_id,
        team_role: input.teamRole,
      },
    });
    input.task.status = 'blocked';
    emitMissionTaskEvent({
      event_type: 'task_reviewed',
      mission_id: input.missionId,
      task_id: input.task.task_id,
      agent_id: input.assignment.agent_id,
      team_role: input.teamRole,
      decision: 'task_reviewed',
      why: 'Task result did not satisfy the structured response contract.',
      policy_used: 'mission_orchestration_control_plane_v1',
      evidence: input.task.deliverable ? [String(input.task.deliverable)] : [],
      payload: {
        description: input.task.description,
        deliverable: input.task.deliverable,
        task_result: response.taskResult,
        task_result_errors: response.parseErrors,
        notes: response.notes,
        ...taskResultObservability,
      },
    });
    recordMissionContextTask(input.missionId, `Blocked work item ${input.task.task_id}`, {
      next_step: 'repair the structured task result response before retrying',
      work_item_id: input.task.task_id,
      team_role: input.teamRole,
      assignee_peer_id: input.assignment.agent_id,
      execution_mode: response.executionMode,
      context_pack_id: dispatchContext.missionContextPackId,
      context_pack_path: dispatchContext.missionContextPackPath,
      context_pack_summary: dispatchContext.missionContextPackSummary,
      context_pack_pruning_summary: dispatchContext.missionContextPackPruningSummary,
      ...taskResultObservability,
    });
    return {
      task_id: input.task.task_id,
      team_role: input.teamRole,
      agent_id: input.assignment.agent_id,
      dispatched: false,
      ...taskResultObservability,
    };
  }

  const reviewTarget = resolveReviewTargetForTask(input.task);
  const isArtifactReview = input.teamRole === 'reviewer' || input.teamRole === 'qa';
  const targetTask =
    isArtifactReview && reviewTarget
      ? input.allTasks.find((task) => task.task_id === reviewTarget)
      : undefined;
  const reviewArtifact = isArtifactReview
    ? prepareArtifactReviewTask({
        missionId: input.missionId,
        reviewTask: input.task,
        tasks: input.allTasks,
      })
    : null;
  if (isArtifactReview && targetTask && !reviewArtifact?.absolutePath) {
    reviewFindings.push({
      severity: 'must_fix',
      location: reviewTarget || input.task.task_id,
      instruction: 'Review target artifact is unavailable for hash-bound quality review.',
    });
  }
  const hasMustFixFindings = reviewFindings.some((finding) => finding.severity === 'must_fix');
  if (isArtifactReview && reviewTarget) {
    input.task.review_findings = reviewFindings;
    const currentReviewRound = Math.max(
      Number(input.task.review_round || 0),
      Number(input.task.rework_count || 0)
    );
    const nextReviewRound = currentReviewRound + 1;
    if (reviewArtifact?.absolutePath) {
      persistArtifactReviewReceipt({
        missionId: input.missionId,
        reviewTask: input.task,
        teamRole: input.teamRole as 'reviewer' | 'qa',
        reviewerAgentId: input.assignment.agent_id,
        artifact: reviewArtifact,
        findings: reviewFindings,
        reviewRound: nextReviewRound,
      });
    }
    if (!targetTask) {
      updateWorkItem({
        itemId: claimed.item.item_id,
        expectedVersion: claimed.item.version,
        status: 'blocked',
        metadata: {
          summary: response.taskResult?.summary || input.task.description || input.task.task_id,
          blocked_reason: `missing review target ${reviewTarget}`,
          mission_id: input.missionId,
          task_id: input.task.task_id,
          team_role: input.teamRole,
        },
      });
      input.task.status = 'blocked';
      emitMissionTaskEvent({
        event_type: 'task_reviewed',
        mission_id: input.missionId,
        task_id: input.task.task_id,
        agent_id: input.assignment.agent_id,
        team_role: input.teamRole,
        decision: 'task_reviewed',
        why: `Reviewer task references missing review target ${reviewTarget}.`,
        policy_used: 'mission_orchestration_control_plane_v1',
        evidence: input.task.deliverable ? [String(input.task.deliverable)] : [],
        payload: {
          description: input.task.description,
          deliverable: input.task.deliverable,
          review_target: reviewTarget,
          task_result: response.taskResult,
          review_findings: reviewFindings,
          ...taskResultObservability,
        },
      });
      return {
        task_id: input.task.task_id,
        team_role: input.teamRole,
        agent_id: input.assignment.agent_id,
        dispatched: false,
        allowSameInvocationRedispatch: false,
        redispatchTaskIds: [],
        ...taskResultObservability,
      };
    }

    if (hasMustFixFindings && currentReviewRound >= 2) {
      updateWorkItem({
        itemId: claimed.item.item_id,
        expectedVersion: claimed.item.version,
        status: 'blocked',
        metadata: {
          summary: response.taskResult?.summary || input.task.description || input.task.task_id,
          blocked_reason: 'review_rework_round_limit',
          mission_id: input.missionId,
          task_id: input.task.task_id,
          team_role: input.teamRole,
        },
      });
      input.task.status = 'blocked';
      input.task.review_round = nextReviewRound;
      input.task.rework_count = nextReviewRound;
      targetTask.status = 'blocked';
      targetTask.rework_count = Math.max(Number(targetTask.rework_count || 0), nextReviewRound);
      targetTask.rework_packet = {
        from_task: input.task.task_id,
        findings: reviewFindings,
        round: nextReviewRound,
      };
      emitMissionTaskEvent({
        event_type: 'task_reviewed',
        mission_id: input.missionId,
        task_id: input.task.task_id,
        agent_id: input.assignment.agent_id,
        team_role: input.teamRole,
        decision: 'task_reviewed',
        why: 'Review findings exceeded the re-review limit.',
        policy_used: 'mission_orchestration_control_plane_v1',
        evidence: input.task.deliverable ? [String(input.task.deliverable)] : [],
        payload: {
          description: input.task.description,
          deliverable: input.task.deliverable,
          review_target: reviewTarget,
          task_result: response.taskResult,
          review_findings: reviewFindings,
          review_round: nextReviewRound,
          ...taskResultObservability,
        },
      });
      emitMissionOrchestrationObservation({
        event_type: 'mission_owner_notified',
        decision: 'mission_owner_notified',
        mission_id: input.missionId,
        task_id: input.task.task_id,
        team_role: input.teamRole,
        reason: 'Review findings exceeded the re-review limit.',
        gate_rework_count: nextReviewRound,
        gate_reasons: reviewFindings.map(
          (finding) => `${finding.location}: ${finding.instruction}`
        ),
      });
      return {
        task_id: input.task.task_id,
        team_role: input.teamRole,
        agent_id: input.assignment.agent_id,
        dispatched: false,
        allowSameInvocationRedispatch: false,
        redispatchTaskIds: [],
        ...taskResultObservability,
      };
    }

    if (hasMustFixFindings) {
      targetTask.status = 'rework';
      targetTask.rework_count = Math.max(Number(targetTask.rework_count || 0), nextReviewRound);
      targetTask.rework_packet = {
        from_task: input.task.task_id,
        findings: reviewFindings,
        round: nextReviewRound,
      };
      targetTask.review_findings = reviewFindings;
      input.task.status = 'planned';
      input.task.review_round = nextReviewRound;
      input.task.rework_count = nextReviewRound;
      releaseWorkItem({
        itemId: claimed.item.item_id,
        expectedVersion: claimed.item.version,
        leaseId: claimed.lease.lease_id,
        actorPeerId: 'mission-orchestration-worker',
        summary: response.taskResult?.summary || input.task.description || input.task.task_id,
        metadata: {
          summary: response.taskResult?.summary || input.task.description || input.task.task_id,
          blocked_reason: 'review_rework_requested',
          mission_id: input.missionId,
          task_id: input.task.task_id,
          team_role: input.teamRole,
          review_target: reviewTarget,
          review_round: nextReviewRound,
        },
      });
      emitMissionTaskEvent({
        event_type: 'task_reviewed',
        mission_id: input.missionId,
        task_id: input.task.task_id,
        agent_id: input.assignment.agent_id,
        team_role: input.teamRole,
        decision: 'task_reviewed',
        why: 'Review requested rework on the target task.',
        policy_used: 'mission_orchestration_control_plane_v1',
        evidence: input.task.deliverable ? [String(input.task.deliverable)] : [],
        payload: {
          description: input.task.description,
          deliverable: input.task.deliverable,
          review_target: reviewTarget,
          task_result: response.taskResult,
          review_findings: reviewFindings,
          review_round: nextReviewRound,
          rework_requested: true,
          ...taskResultObservability,
        },
      });
      recordMissionContextTask(
        input.missionId,
        `Review rework requested for ${input.task.task_id}`,
        {
          next_step: 're-dispatch the target task with review findings to address',
          work_item_id: input.task.task_id,
          team_role: input.teamRole,
          assignee_peer_id: input.assignment.agent_id,
          review_target: reviewTarget,
          review_round: nextReviewRound,
          review_findings: reviewFindings,
          ...taskResultObservability,
        }
      );
      return {
        task_id: input.task.task_id,
        team_role: input.teamRole,
        agent_id: input.assignment.agent_id,
        dispatched: false,
        allowSameInvocationRedispatch: true,
        redispatchTaskIds: [targetTask.task_id],
        ...taskResultObservability,
      };
    }
  }

  if (isDraftRefineCandidate({ teamRole: input.teamRole, task: input.task })) {
    await applyDraftRefineToDeliverable({
      missionId: input.missionId,
      task: input.task,
      teamRole: input.teamRole,
    });
  }

  const acceptance = await evaluateTaskAcceptanceGate({
    missionId: input.missionId,
    task: input.task,
    taskResult: response.taskResult,
  });

  if (!acceptance.passed) {
    const currentReworkCount = Number(input.task.rework_count || 0);
    const nextReworkCount = currentReworkCount + 1;
    const gateReason = acceptance.reasons.join('; ') || 'task acceptance gate failed';

    if (currentReworkCount < 1) {
      input.task.rework_count = nextReworkCount;
      input.task.status = 'planned';
      releaseWorkItem({
        itemId: claimed.item.item_id,
        expectedVersion: claimed.item.version,
        leaseId: claimed.lease.lease_id,
        actorPeerId: 'mission-orchestration-worker',
        summary: response.taskResult?.summary || input.task.description || input.task.task_id,
        metadata: {
          summary: response.taskResult?.summary || input.task.description || input.task.task_id,
          blocked_reason: gateReason,
          mission_id: input.missionId,
          task_id: input.task.task_id,
          team_role: input.teamRole,
          task_result_retried: response.retried,
          rework_count: nextReworkCount,
          rework_requested: true,
        },
      });
      emitMissionTaskEvent({
        event_type: 'task_reviewed',
        mission_id: input.missionId,
        task_id: input.task.task_id,
        agent_id: input.assignment.agent_id,
        team_role: input.teamRole,
        decision: 'task_reviewed',
        why: 'Task acceptance gate failed; rework requested once.',
        policy_used: 'mission_orchestration_control_plane_v1',
        evidence: input.task.deliverable ? [String(input.task.deliverable)] : [],
        payload: {
          description: input.task.description,
          deliverable: input.task.deliverable,
          task_model_hint: input.assignment.model_hint,
          task_result: response.taskResult,
          task_result_retried: response.retried,
          gate_reasons: acceptance.reasons,
          gate_record_path: acceptance.recordPath,
          rework_count: nextReworkCount,
          rework_requested: true,
          ...taskResultObservability,
        },
      });
      recordMissionContextTask(input.missionId, `Rework requested for ${input.task.task_id}`, {
        next_step: 'retry the work item once after repairing the acceptance gaps',
        work_item_id: input.task.task_id,
        team_role: input.teamRole,
        assignee_peer_id: input.assignment.agent_id,
        execution_mode: response.executionMode,
        context_pack_id: dispatchContext.missionContextPackId,
        context_pack_path: dispatchContext.missionContextPackPath,
        context_pack_summary: dispatchContext.missionContextPackSummary,
        context_pack_pruning_summary: dispatchContext.missionContextPackPruningSummary,
        gate_reasons: acceptance.reasons,
        gate_record_path: acceptance.recordPath,
        rework_count: nextReworkCount,
        rework_requested: true,
        ...taskResultObservability,
      });
      return {
        task_id: input.task.task_id,
        team_role: input.teamRole,
        agent_id: input.assignment.agent_id,
        dispatched: false,
        allowSameInvocationRedispatch: false,
        redispatchTaskIds: [],
        ...taskResultObservability,
      };
    }

    updateWorkItem({
      itemId: claimed.item.item_id,
      expectedVersion: claimed.item.version,
      status: 'blocked',
      metadata: {
        summary: response.taskResult?.summary || input.task.description || input.task.task_id,
        blocked_reason: gateReason,
        mission_id: input.missionId,
        task_id: input.task.task_id,
        team_role: input.teamRole,
        task_result_retried: response.retried,
        rework_count: nextReworkCount,
      },
    });
    input.task.status = 'blocked';
    input.task.rework_count = nextReworkCount;
    emitMissionTaskEvent({
      event_type: 'task_reviewed',
      mission_id: input.missionId,
      task_id: input.task.task_id,
      agent_id: input.assignment.agent_id,
      team_role: input.teamRole,
      decision: 'task_reviewed',
      why: 'Task acceptance gate failed after rework limit.',
      policy_used: 'mission_orchestration_control_plane_v1',
      evidence: input.task.deliverable ? [String(input.task.deliverable)] : [],
      payload: {
        description: input.task.description,
        deliverable: input.task.deliverable,
        task_model_hint: input.assignment.model_hint,
        task_result: response.taskResult,
        task_result_retried: response.retried,
        gate_reasons: acceptance.reasons,
        gate_record_path: acceptance.recordPath,
        rework_count: nextReworkCount,
        rework_requested: false,
        ...taskResultObservability,
      },
    });
    emitMissionOrchestrationObservation({
      event_type: 'mission_owner_notified',
      decision: 'mission_owner_notified',
      mission_id: input.missionId,
      task_id: input.task.task_id,
      team_role: input.teamRole,
      reason: 'Task acceptance gate failed after rework limit.',
      gate_rework_count: nextReworkCount,
      gate_reasons: acceptance.reasons,
      gate_record_path: acceptance.recordPath,
    });
    recordMissionContextTask(input.missionId, `Blocked work item ${input.task.task_id}`, {
      next_step: 'notify owner and request human intervention',
      work_item_id: input.task.task_id,
      team_role: input.teamRole,
      assignee_peer_id: input.assignment.agent_id,
      execution_mode: response.executionMode,
      context_pack_id: dispatchContext.missionContextPackId,
      context_pack_path: dispatchContext.missionContextPackPath,
      context_pack_summary: dispatchContext.missionContextPackSummary,
      context_pack_pruning_summary: dispatchContext.missionContextPackPruningSummary,
      gate_reasons: acceptance.reasons,
      gate_record_path: acceptance.recordPath,
      rework_count: nextReworkCount,
      ...taskResultObservability,
    });
    return {
      task_id: input.task.task_id,
      team_role: input.teamRole,
      agent_id: input.assignment.agent_id,
      dispatched: false,
      allowSameInvocationRedispatch: false,
      redispatchTaskIds: [],
      ...taskResultObservability,
    };
  }

  updateWorkItem({
    itemId: claimed.item.item_id,
    expectedVersion: claimed.item.version,
    status: 'done',
    metadata: {
      summary: response.taskResult?.summary || input.task.description || input.task.task_id,
      mission_id: input.missionId,
      task_id: input.task.task_id,
      team_role: input.teamRole,
      task_result_retried: response.retried,
    },
  });
  input.task.status = 'completed';
  let prRef: string | undefined;
  try {
    prRef = publishTaskPrArtifacts({
      missionId: input.missionId,
      task: input.task,
      teamRole: input.teamRole,
      taskResult: response.taskResult,
    });
  } catch (err: any) {
    logger.warn(
      `[MISSION_WORKER] PR artifact publication failed for ${input.task.task_id}: ${err?.message || err}`
    );
  }
  emitMissionTaskEvent({
    event_type: 'task_completed',
    mission_id: input.missionId,
    task_id: input.task.task_id,
    agent_id: input.assignment.agent_id,
    team_role: input.teamRole,
    decision: 'task_completed',
    why: 'Task acceptance gate passed.',
    policy_used: 'mission_orchestration_control_plane_v1',
    evidence: input.task.deliverable ? [String(input.task.deliverable)] : [],
    payload: {
      description: input.task.description,
      deliverable: input.task.deliverable,
      task_model_hint: input.assignment.model_hint,
      mission_context_pack_path: dispatchContext.missionContextPackPath,
      mission_context_pack_summary: dispatchContext.missionContextPackSummary,
      work_item_id: claimed.item.item_id,
      work_item_lease_id: claimed.lease.lease_id,
      work_item_status: claimed.item.status,
      task_result: response.taskResult,
      task_result_retried: response.retried,
      gate_record_path: acceptance.recordPath,
      ...(prRef ? { pr_ref: prRef } : {}),
      ...taskResultObservability,
    },
  });
  recordMissionContextTask(input.missionId, `Completed work item ${input.task.task_id}`, {
    next_step: 'continue reconciliation and update the task board',
    task_id: input.task.task_id,
    team_role: input.teamRole,
    assignee_peer_id: input.assignment.agent_id,
    execution_mode: response.executionMode,
    context_pack_id: dispatchContext.missionContextPackId,
    context_pack_path: dispatchContext.missionContextPackPath,
    context_pack_summary: dispatchContext.missionContextPackSummary,
    context_pack_pruning_summary: dispatchContext.missionContextPackPruningSummary,
    work_item_id: claimed.item.item_id,
    work_item_lease_id: claimed.lease.lease_id,
    work_item_status: claimed.item.status,
    gate_record_path: acceptance.recordPath,
    ...taskResultObservability,
  });
  return {
    task_id: input.task.task_id,
    team_role: input.teamRole,
    agent_id: input.assignment.agent_id,
    dispatched: true,
    ...taskResultObservability,
  };
}

async function obtainTaskResultResponse(input: {
  missionId: string;
  task: PlannedNextTask;
  teamRole: string;
  agentId: string;
  taskModelHint?: { model_id?: string; tier?: string; effort?: string; route_reason?: string };
  prompt: string;
  securityScope?: import('./context-security-scope.js').ContextSecurityScope;
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
        security_scope: input.securityScope,
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
          security_scope: input.securityScope,
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
  if (process.env.KYBERION_DRAFT_REFINE === '0') return false;
  const role = String(input.teamRole || '').toLowerCase();
  if (role === 'reviewer' || role === 'qa' || role === 'planner') return false;
  const risk = String(input.task.risk || '').toLowerCase();
  if (risk !== 'high' && risk !== 'high_stakes') return false;
  const deliverable = String(input.task.deliverable || '').toLowerCase();
  return (
    deliverable.endsWith('.md') || deliverable.endsWith('.markdown') || deliverable.endsWith('.txt')
  );
}

async function applyDraftRefineToDeliverable(input: {
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
  if (process.env.KYBERION_BEST_OF_N === '0') return false;
  const role = String(input.teamRole || '').toLowerCase();
  if (role === 'reviewer' || role === 'qa' || role === 'planner') return false;
  const risk = String(input.task.risk || '').toLowerCase();
  return risk === 'high' || risk === 'high_stakes';
}

const BEST_OF_APPROACHES = [
  { key: 'A', directive: 'アプローチA: 最小実装優先 — deliver the smallest correct change first.' },
  {
    key: 'B',
    directive:
      'アプローチB: 堅牢性優先 — prioritize robustness: edge cases, failure handling, verification.',
  },
] as const;

function parseBestOfJudgeVerdict(
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

async function obtainBestOfTaskResultResponse(input: {
  missionId: string;
  task: PlannedNextTask;
  teamRole: string;
  agentId: string;
  taskModelHint?: { model_id?: string; tier?: string; effort?: string; route_reason?: string };
  prompt: string;
  securityScope?: import('./context-security-scope.js').ContextSecurityScope;
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
      safeWriteFile(
        path.join(alternativesDir, `${input.task.task_id}-candidate-${loser.key}.json`),
        JSON.stringify(
          {
            task_id: input.task.task_id,
            candidate: loser.key,
            winner: winnerKey,
            judge_rationale: verdict?.rationale,
            merge_hints: verdict?.merge_hints,
            task_result: loser.response.taskResult,
          },
          null,
          2
        )
      );
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

function publishTaskPrArtifacts(input: {
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
  safeWriteFile(
    path.join(prDir, 'diff.patch'),
    diff || `(no committed changes for task ${input.task.task_id})\n`
  );
  safeWriteFile(
    path.join(prDir, 'PR.md'),
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
  );
  return `evidence/prs/${input.task.task_id}/PR.md`;
}

const REVIEW_DIFF_MAX_LINES = 2000;

function buildReviewDiffLines(missionId: string, task: PlannedNextTask): string[] {
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

// ── MO-02 Task 4: phase exit gates ─────────────────────────────────────────
// Process templates declare entry/exit gates per phase; planning persists
// them to gates/definitions/. Until now nothing evaluated them at runtime.
// Exit gates are evaluated before the completion event fires. Rollout is
// staged per the repo's warn→enforce rule: default mode 'warn' records and
// notifies without blocking; KYBERION_PHASE_GATE_MODE=enforce blocks the
// completion event and, after repeated failures, recommends realignment
// (circuit breaker). 'off' disables evaluation entirely.

export interface PersistedPhaseGateDefinition {
  phase: string;
  position: 'entry' | 'exit';
  gate: MissionGateDefinition;
}

export function resolvePhaseGateMode(): 'off' | 'warn' | 'enforce' {
  const raw = String(process.env.KYBERION_PHASE_GATE_MODE || 'warn').toLowerCase();
  if (raw === 'enforce') return 'enforce';
  if (raw === 'off') return 'off';
  return 'warn';
}

export function loadMissionPhaseGateDefinitions(missionId: string): PersistedPhaseGateDefinition[] {
  const defsDir = `${missionDir(missionId, 'public')}/gates/definitions`;
  if (!safeExistsSync(defsDir)) return [];
  return safeReaddir(defsDir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => {
      try {
        const parsed = JSON.parse(
          safeReadFile(`${defsDir}/${entry}`, { encoding: 'utf8' }) as string
        );
        if (!parsed || typeof parsed !== 'object') return null;
        const gate = (parsed as Record<string, unknown>).gate;
        if (!gate || typeof gate !== 'object') return null;
        return {
          phase: String((parsed as Record<string, unknown>).phase || ''),
          position: (parsed as Record<string, unknown>).position === 'entry' ? 'entry' : 'exit',
          gate: gate as MissionGateDefinition,
        } satisfies PersistedPhaseGateDefinition;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is PersistedPhaseGateDefinition => Boolean(entry));
}

// reviewer_approved template checks carry only { task_id } — the runtime
// outcome lives in NEXT_TASKS.json. Resolve it here so the gate engine sees
// the review verdict instead of failing on missing params.
function enrichGateWithTaskOutcomes(
  missionId: string,
  gate: MissionGateDefinition
): MissionGateDefinition {
  const nextTasksPath = `${missionDir(missionId, 'public')}/NEXT_TASKS.json`;
  let tasks: Array<Record<string, unknown>> = [];
  try {
    const parsed = JSON.parse(safeReadFile(nextTasksPath, { encoding: 'utf8' }) as string);
    if (Array.isArray(parsed)) tasks = parsed as Array<Record<string, unknown>>;
  } catch {
    /* no task board — checks keep their declared params */
  }
  const checks = (gate.checks || []).map((check) => {
    if (check.kind !== 'reviewer_approved') return check;
    const params = { ...(check.params || {}) } as Record<string, unknown>;
    if (params.approved !== undefined || params.verdict !== undefined) return check;
    const taskId = String(params.task_id || params.taskId || '');
    if (!taskId) return check;
    const task = tasks.find((entry) => String(entry.task_id || '') === taskId);
    const status = String(task?.status || '');
    return {
      ...check,
      params: {
        ...params,
        approved: status === 'completed' || status === 'accepted',
        reason:
          status === ''
            ? `Review task ${taskId} not found in NEXT_TASKS.json`
            : `Review task ${taskId} status: ${status}`,
      },
    };
  });
  return { ...gate, checks };
}

export interface PhaseExitGateOutcome {
  passed: boolean;
  evaluated: number;
  failures: Array<{ gate_id: string; phase: string; reasons: string[]; prior_failures: number }>;
}

export async function evaluateMissionPhaseExitGates(
  missionId: string
): Promise<PhaseExitGateOutcome> {
  const definitions = loadMissionPhaseGateDefinitions(missionId).filter(
    (definition) => definition.position === 'exit'
  );
  const priorRecords = loadMissionGateRecords(missionId);
  const failures: PhaseExitGateOutcome['failures'] = [];
  for (const definition of definitions) {
    const priorFailures = priorRecords.filter(
      (record) => record.gate_id === definition.gate.id && record.verdict === 'fail'
    ).length;
    const evaluation = await evaluateMissionGate({
      missionId,
      gate: enrichGateWithTaskOutcomes(missionId, definition.gate),
      evidenceDir: `${missionDir(missionId, 'public')}/gates`,
    });
    if (evaluation.verdict !== 'pass') {
      failures.push({
        gate_id: definition.gate.id,
        phase: definition.phase,
        reasons: evaluation.reasons,
        prior_failures: priorFailures,
      });
    }
  }
  return { passed: failures.length === 0, evaluated: definitions.length, failures };
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
      ...(typeof task.review_target === 'string' && task.review_target.trim()
        ? { review_target: task.review_target.trim() }
        : {}),
    };
  });
  const nextTasks = validation.value.next_tasks.map((task, index) => ({
    ...derivedTasks[index],
  }));
  // MO-01: process-template-seeded tasks are the mission's fixed skeleton —
  // the planner may add tasks around them but never drop or restructure them.
  const nextTasksPath = `${missionPath}/NEXT_TASKS.json`;
  const seededTasks = readProcessTemplateSeededTasks(nextTasksPath);
  if (seededTasks.length > 0) {
    const seededIds = new Set(seededTasks.map((task) => String(task.task_id)));
    const additions = nextTasks.filter((task) => !seededIds.has(task.task_id));
    safeWriteFile(nextTasksPath, JSON.stringify([...seededTasks, ...additions], null, 2));
    ledger.record('MISSION_PLAN_MERGED_WITH_PROCESS_TEMPLATE', {
      mission_id: missionId,
      seeded_task_count: seededTasks.length,
      planner_addition_count: additions.length,
      dropped_planner_task_count: nextTasks.length - additions.length,
    });
    return;
  }
  safeWriteFile(nextTasksPath, JSON.stringify(nextTasks, null, 2));
}

function readProcessTemplateSeededTasks(nextTasksPath: string): Array<Record<string, unknown>> {
  if (!safeExistsSync(nextTasksPath)) return [];
  try {
    const parsed = JSON.parse(safeReadFile(nextTasksPath, { encoding: 'utf8' }) as string);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (task): task is Record<string, unknown> =>
        Boolean(task) && typeof task === 'object' && task.origin === 'process_template'
    );
  } catch {
    return [];
  }
}

function loadPlannedNextTasks(missionId: string): PlannedNextTask[] {
  return loadAllNextTasks(missionId).filter((task) => {
    const status = String(task.status || 'planned');
    return status === 'planned' || status === 'rework';
  });
}

function loadAllNextTasks(missionId: string): PlannedNextTask[] {
  const missionPath = missionDir(missionId, 'public');
  const nextTasksPath = `${missionPath}/NEXT_TASKS.json`;
  if (!safeExistsSync(nextTasksPath)) return [];
  const tasks = JSON.parse(safeReadFile(nextTasksPath, { encoding: 'utf8' }) as string) as unknown;
  return validatePlannedNextTasks(tasks, missionId);
}

function writeNextTasks(missionId: string, tasks: PlannedNextTask[]): void {
  const missionPath = missionDir(missionId, 'public');
  const nextTasksPath = `${missionPath}/NEXT_TASKS.json`;
  const existingTasks = safeExistsSync(nextTasksPath)
    ? validatePlannedNextTasks(
        JSON.parse(safeReadFile(nextTasksPath, { encoding: 'utf8' }) as string) as unknown,
        missionId
      )
    : [];
  const existingById = new Map(existingTasks.map((task) => [task.task_id, task]));
  const mergedTasks = tasks.map((task) => {
    const existing = existingById.get(task.task_id);
    if (!existing) return task;
    const existingPriority =
      PLANNED_NEXT_TASK_STATUS_PRIORITY[String(existing.status || 'planned')] ?? 0;
    const incomingPriority =
      PLANNED_NEXT_TASK_STATUS_PRIORITY[String(task.status || 'planned')] ?? 0;
    const status = existingPriority > incomingPriority ? existing.status : task.status;
    const rework_count = Math.max(
      Number(existing.rework_count || 0),
      Number(task.rework_count || 0)
    );
    return {
      ...task,
      ...(status ? { status } : {}),
      ...(rework_count > 0 ? { rework_count } : {}),
    };
  });
  safeWriteFile(nextTasksPath, JSON.stringify(mergedTasks, null, 2));
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
  const allTasks = loadAllNextTasks(missionId);
  const plannedTasks = allTasks.filter((task) => {
    const status = String(task.status || 'planned');
    return status === 'planned' || status === 'rework';
  });
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
  const dispatchObservability: Array<{
    dispatched: boolean;
    context_chars?: number;
    pruned_chars?: number;
    rollup_used: boolean;
    result_schema_ok: boolean;
    needs_count: number;
  }> = [];
  const plan = resolveMissionTeamPlan({ missionId });
  const maxParallelMembers = Math.max(1, plan.team_governance?.lifecycle.max_parallel_members || 3);
  const dispatchedTaskIds = new Set<string>();

  while (true) {
    const readyTasks = plannedTasks
      .filter((task) => {
        const status = String(task.status || 'planned');
        return status === 'planned' || status === 'rework';
      })
      .filter((task) => areTaskDependenciesSatisfied(task, allTasks))
      .filter((task) => task.status === 'rework' || !dispatchedTaskIds.has(task.task_id))
      .sort((left, right) => left.task_id.localeCompare(right.task_id));

    if (readyTasks.length === 0) break;

    const batch: Promise<DispatchMissionTaskOutcome | null>[] = [];
    let waveMadeProgress = false;
    for (const task of readyTasks) {
      if (batch.length >= maxParallelMembers) break;
      const teamRole = task.assigned_to?.role;
      if (!teamRole) {
        task.status = 'blocked';
        waveMadeProgress = true;
        const summary = buildUnassignedRoleSummary(task);
        emitMissionTaskEvent({
          event_type: 'task_reviewed',
          mission_id: missionId,
          task_id: task.task_id,
          agent_id: task.assigned_to?.agent_id || 'mission-orchestration-worker',
          team_role: 'unassigned',
          decision: 'task_reviewed',
          why: summary,
          policy_used: 'mission_orchestration_control_plane_v1',
          evidence: task.deliverable ? [String(task.deliverable)] : [],
          payload: {
            description: task.description,
            deliverable: task.deliverable,
            reason: 'blocked(unassigned_role)',
            summary,
          },
        });
        recordMissionContextTask(missionId, `Blocked work item ${task.task_id}`, {
          summary,
          next_step: 'assign a team role before retrying the work item',
          work_item_id: task.task_id,
          team_role: 'unassigned',
          assignee_peer_id: task.assigned_to?.agent_id,
          reason: 'blocked(unassigned_role)',
        });
        continue;
      }
      const reviewArtifact =
        teamRole === 'reviewer' || teamRole === 'qa'
          ? prepareArtifactReviewTask({ missionId, reviewTask: task, tasks: allTasks })
          : null;
      const assignment = resolveMissionTeamReceiver({
        missionId,
        teamRole,
        ...(reviewArtifact && task.artifact_review_profile
          ? {
              excludedAgentIds: task.artifact_review_profile.implementer_agent_ids,
              requiredCapabilities: task.artifact_review_profile.required_reviewer_capabilities,
            }
          : {}),
      });
      const reviewProfile = task.artifact_review_profile;
      const reviewerIndependenceFailure =
        assignment &&
        reviewProfile?.independence_required &&
        (reviewProfile.implementer_agent_ids.length === 0 ||
          reviewProfile.implementer_agent_ids.includes(assignment.agent_id || ''));
      if (reviewerIndependenceFailure) {
        task.status = 'blocked';
        waveMadeProgress = true;
        const summary =
          reviewProfile.implementer_agent_ids.length === 0
            ? 'Artifact review blocked because the implementation agent identity is unavailable.'
            : `Artifact review blocked because ${assignment.agent_id} also implemented the target artifact.`;
        emitMissionTaskEvent({
          event_type: 'task_reviewed',
          mission_id: missionId,
          task_id: task.task_id,
          agent_id: assignment.agent_id || 'mission-orchestration-worker',
          team_role: teamRole,
          decision: 'task_reviewed',
          why: summary,
          policy_used: 'artifact_review_independence_v1',
          evidence: reviewProfile.artifact_path ? [reviewProfile.artifact_path] : [],
          payload: {
            description: task.description,
            review_target: resolveReviewTargetForTask(task),
            implementer_agent_ids: reviewProfile.implementer_agent_ids,
            required_reviewer_roles: reviewProfile.required_reviewer_roles,
            reason: 'blocked(reviewer_independence)',
          },
        });
        recordMissionContextTask(missionId, `Blocked artifact review ${task.task_id}`, {
          summary,
          next_step: 'assign an independent capable reviewer before retrying the review task',
          work_item_id: task.task_id,
          team_role: teamRole,
          assignee_peer_id: assignment.agent_id || undefined,
          reason: 'blocked(reviewer_independence)',
        });
        continue;
      }
      // Fill in a routed model hint only when the team plan did not already
      // pin one — plan-level hints stay authoritative (MO-05 shadow routing).
      if (assignment && !assignment.model_hint) {
        const phaseKind: TaskModelPhaseKind =
          teamRole === 'planner'
            ? 'plan'
            : teamRole === 'reviewer' || teamRole === 'qa'
              ? 'review'
              : teamRole === 'formatter' || teamRole === 'linter'
                ? 'mechanical'
                : 'implement';
        assignment.model_hint = resolveTaskModelHint({
          phase_kind: phaseKind,
          risk: task.risk,
          estimated_scope: task.estimated_scope,
        });
      }
      if (!assignment?.agent_id) {
        task.status = 'blocked';
        waveMadeProgress = true;
        const summary = buildUnassignedRoleSummary(task, teamRole);
        emitMissionTaskEvent({
          event_type: 'task_reviewed',
          mission_id: missionId,
          task_id: task.task_id,
          agent_id: 'mission-orchestration-worker',
          team_role: teamRole,
          decision: 'task_reviewed',
          why: summary,
          policy_used: 'mission_orchestration_control_plane_v1',
          evidence: task.deliverable ? [String(task.deliverable)] : [],
          payload: {
            description: task.description,
            deliverable: task.deliverable,
            reason: 'blocked(unassigned_role)',
            team_role: teamRole,
            summary,
          },
        });
        recordMissionContextTask(missionId, `Blocked work item ${task.task_id}`, {
          summary,
          next_step: `assign an agent for role ${teamRole} before retrying the work item`,
          work_item_id: task.task_id,
          team_role: teamRole,
          reason: 'blocked(unassigned_role)',
        });
        continue;
      }
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
        decision: preflight.allowed
          ? 'delegation_preflight_passed'
          : 'delegation_preflight_blocked',
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
        waveMadeProgress = true;
        continue;
      }

      batch.push(
        (async () => {
          const outcome = await withTaskDispatchTimeout(
            task,
            dispatchPlannedMissionTask({
              missionId,
              task,
              teamRole,
              assignment,
              allTasks,
            })
          );
          if (outcome === 'timeout') {
            task.status = 'blocked';
            const summary = `Task ${task.task_id} exceeded its dispatch budget (${resolveTaskDispatchTimeoutMs(task)}ms) — blocked(timeout).`;
            logger.warn(`[worker] ${summary}`);
            recordMissionContextTask(missionId, `Blocked work item ${task.task_id}`, {
              summary,
              next_step: 'investigate the hung worker, then set the task back to rework',
              work_item_id: task.task_id,
              team_role: teamRole,
              reason: 'blocked(timeout)',
            });
            return null;
          }
          return outcome;
        })()
      );
    }

    if (batch.length === 0) continue;

    const results = await Promise.all(batch);
    const cascadedIds = cascadeBlockedDependents(plannedTasks);
    if (cascadedIds.length > 0) {
      logger.warn(
        `[worker] blocked dependency cascade for ${missionId}: ${cascadedIds.join(', ')}`
      );
    }
    for (const result of results) {
      if (result) {
        if (!result.allowSameInvocationRedispatch) {
          dispatchedTaskIds.add(result.task_id);
        }
        if (Array.isArray(result.redispatchTaskIds)) {
          for (const redispatchTaskId of result.redispatchTaskIds) {
            dispatchedTaskIds.delete(redispatchTaskId);
          }
        }
        waveMadeProgress = true;
        dispatchObservability.push(result);
        if (result.dispatched || result.result_schema_ok) {
          dispatched.push({
            task_id: result.task_id,
            team_role: result.team_role,
            agent_id: result.agent_id,
          });
        }
      }
    }

    if (!waveMadeProgress) break;
  }

  writeNextTasks(missionId, allTasks);
  markTaskBoardInProgress(missionId);
  reconcileMissionProgress(missionId);
  const contextChars = dispatchObservability
    .map((entry) => entry.context_chars)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const prunedChars = dispatchObservability
    .map((entry) => entry.pruned_chars)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const needsCountTotal = dispatchObservability.reduce(
    (count, entry) => count + entry.needs_count,
    0
  );
  const resultSchemaOkCount = dispatchObservability.filter(
    (entry) => entry.result_schema_ok
  ).length;
  const rollupCount = dispatchObservability.filter((entry) => entry.rollup_used).length;
  ledger.record('MISSION_FOLLOWUP_DISPATCHED', {
    mission_id: missionId,
    dispatched_task_count: dispatched.length,
    task_ids: dispatched.map((task) => task.task_id),
    average_context_chars:
      contextChars.length > 0
        ? Math.round(contextChars.reduce((sum, value) => sum + value, 0) / contextChars.length)
        : undefined,
    average_pruned_chars:
      prunedChars.length > 0
        ? Math.round(prunedChars.reduce((sum, value) => sum + value, 0) / prunedChars.length)
        : undefined,
    needs_rate:
      dispatchObservability.length > 0 ? needsCountTotal / dispatchObservability.length : 0,
    result_schema_ok_rate:
      dispatchObservability.length > 0 ? resultSchemaOkCount / dispatchObservability.length : 0,
    rollup_used_count: rollupCount,
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

/**
 * Renders the mission's process-template skeleton (MO-01) into the planner
 * kickoff prompt: the phase sequence plus the seeded fixed tasks the planner
 * must plan around, never restructure.
 */
function renderProcessTemplateSkeleton(missionId: string): string {
  const missionPath = missionDir(missionId, 'public');
  const statePath = `${missionPath}/mission-state.json`;
  if (!safeExistsSync(statePath)) return '';
  let processTemplate: { workflow_id?: string; phases?: string[] } | undefined;
  try {
    const state = JSON.parse(safeReadFile(statePath, { encoding: 'utf8' }) as string) as {
      process_template?: { workflow_id?: string; phases?: string[] };
    };
    processTemplate = state.process_template;
  } catch {
    return '';
  }
  if (!processTemplate?.workflow_id) return '';

  const lines = [
    `Process template: ${processTemplate.workflow_id} — phases: ${(processTemplate.phases || []).join(' → ')}.`,
  ];
  const seeded = readProcessTemplateSeededTasks(`${missionPath}/NEXT_TASKS.json`);
  if (seeded.length > 0) {
    lines.push(
      'The following tasks were seeded from the process template and are FIXED — do not drop, rename, or restructure them. Plan additional tasks around them and reference their task_ids in dependencies where appropriate:'
    );
    for (const task of seeded) {
      lines.push(`- ${String(task.task_id)} (phase: ${String(task.phase || 'n/a')})`);
    }
  }
  return lines.join('\n');
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
    renderProcessTemplateSkeleton(missionId),
    'Return exactly one ```planning_packet``` block and no other structured block for the plan.',
    'The planning packet must match this contract:',
    renderStructuredOutputSchemaPrompt('planning_packet'),
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
    `Schema: ${renderStructuredOutputSchemaPrompt('planning_packet')}`,
    'Contract violations:',
    ...validationErrors.map((error) => `- ${error}`),
    '',
    'Previous response excerpt:',
    previousResponseText.slice(0, 1200),
  ].join('\n');
}

type PlanningReviewVerdict = {
  raw_text: string;
  parsed?: Record<string, unknown>;
} & {
  approve: boolean;
  gaps: string[];
  rationale?: string;
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
  let parsed: Record<string, unknown> | undefined;
  let approve = false;
  let gaps: string[] = [];
  let rationale: string | undefined;

  if (json) {
    try {
      const candidate = JSON.parse(json) as unknown;
      const result = PlanningReviewVerdictSchema.safeParse(candidate);
      if (result.success) {
        parsed = candidate as Record<string, unknown>;
        approve = result.data.approve;
        gaps = result.data.gaps;
        rationale = result.data.rationale;
      } else {
        gaps = result.error.issues.map((issue) => {
          const path = issue.path.length > 0 ? `/${issue.path.map(String).join('/')}` : '/';
          return `${path} ${issue.message || 'schema violation'}`.trim();
        });
      }
    } catch {
      gaps = ['planning review verdict was not valid JSON'];
    }
  }

  if (!json) {
    gaps = ['planning review verdict block missing'];
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

async function recordPlanningPacketGate(input: {
  missionId: string;
  packet: PlanningPacket;
  verdict: 'pass' | 'fail';
  reason?: string;
  reviewVerdict?: PlanningReviewVerdict;
  plannerAgentId: string;
  reviewerAgentId?: string;
  reviewRound: 0 | 1 | 2;
}): Promise<void> {
  const requiresIndependentReview = packetRequiresIndependentReview(input.packet);
  const reviewApproved =
    !requiresIndependentReview || input.reviewVerdict?.approve === true || input.verdict === 'fail';
  const evaluation = await evaluateMissionGate({
    missionId: input.missionId,
    gate: {
      id: `planning-packet-${input.missionId}`,
      title: `Planning packet gate for ${input.missionId}`,
      checks: [
        {
          kind: 'schema_valid',
          params: {
            schema: 'planning_packet',
            value: input.packet,
          },
        },
        {
          kind: 'custom',
          params: {
            evaluate: () => ({
              passed: input.verdict === 'pass' && reviewApproved,
              reason:
                input.reason ||
                (!reviewApproved
                  ? input.reviewVerdict?.gaps.join('; ') ||
                    input.reviewVerdict?.rationale ||
                    'planning review rejected the packet'
                  : undefined),
            }),
          },
        },
      ],
    },
    evidenceDir: `${missionDir(input.missionId, 'public')}/gates`,
  });
  if (evaluation.evidence_path) {
    const current = JSON.parse(
      safeReadFile(evaluation.evidence_path, { encoding: 'utf8' }) as string
    ) as Record<string, unknown>;
    safeWriteFile(
      evaluation.evidence_path,
      JSON.stringify(
        {
          ...current,
          planner_agent_id: input.plannerAgentId,
          ...(input.reviewerAgentId ? { reviewer_agent_id: input.reviewerAgentId } : {}),
          review_round: input.reviewRound,
          requires_independent_review: requiresIndependentReview,
          ...(input.reviewVerdict
            ? {
                review_verdict: {
                  approve: input.reviewVerdict.approve,
                  gaps: input.reviewVerdict.gaps,
                  ...(input.reviewVerdict.rationale
                    ? { rationale: input.reviewVerdict.rationale }
                    : {}),
                },
              }
            : {}),
        },
        null,
        2
      )
    );
  }
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
    `Return JSON only. Schema: ${renderStructuredOutputSchemaPrompt('planning_review_verdict')}`,
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
  let reviewVerdict: PlanningReviewVerdict | undefined;

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

  let reviewerAgentId: string | undefined;
  if (packetRequiresIndependentReview(planningPacket)) {
    const reviewerAssignment = resolveMissionTeamReceiver({ missionId, teamRole: 'reviewer' });
    reviewerAgentId = reviewerAssignment?.agent_id || plannerAgentId;
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
    reviewVerdict = parsePlanningReviewVerdict(reviewText);
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
        await recordPlanningPacketGate({
          missionId,
          packet: planningPacket,
          verdict: 'fail',
          reason:
            reviewVerdict.gaps.length > 0
              ? reviewVerdict.gaps.join('; ')
              : reviewVerdict.rationale || 'planning review rejected packet',
          reviewVerdict,
          plannerAgentId,
          reviewerAgentId,
          reviewRound: 2,
        });
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

  await recordPlanningPacketGate({
    missionId,
    packet: planningPacket,
    verdict: 'pass',
    plannerAgentId,
    reviewRound: packetRequiresIndependentReview(planningPacket) ? 2 : 1,
    ...(reviewerAgentId ? { reviewerAgentId } : {}),
    ...(reviewVerdict ? { reviewVerdict } : {}),
  });

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

  // MO-02: phase exit gates guard the completion event.
  const gateMode = resolvePhaseGateMode();
  if (gateMode !== 'off') {
    const exitGates = await evaluateMissionPhaseExitGates(missionId);
    if (!exitGates.passed) {
      const circuitBreak = exitGates.failures.some((failure) => failure.prior_failures >= 2);
      const failureLines = exitGates.failures
        .map((failure) => `${failure.gate_id} (${failure.phase}): ${failure.reasons.join('; ')}`)
        .join(' | ');
      emitSlackMissionEvent(
        payload,
        missionId,
        circuitBreak ? 'mission_phase_gate_circuit_breaker' : 'mission_phase_gate_failed',
        circuitBreak
          ? `Phase exit gates failed repeatedly (${failureLines}). Realignment recommended: review the plan with the owner before completing.`
          : `Phase exit gates not satisfied (${failureLines}).${gateMode === 'enforce' ? ' Completion is blocked until the gates pass or an operator overrides via gate-pass.' : ' (warn mode: completion continues; set KYBERION_PHASE_GATE_MODE=enforce to block)'}`
      );
      if (gateMode === 'enforce') {
        logger.warn(
          `[worker] completion blocked for ${missionId}: ${exitGates.failures.length} exit gate(s) failing`
        );
        await shutdownAllAgentRuntimes('mission_orchestration_worker');
        return;
      }
    }
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
    case 'pause':
      runMissionController(env, ['pause', missionId]);
      break;
    case 'cancel':
      runMissionController(env, ['cancel', missionId]);
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
