/**
 * Opt-in L1/L2/L3 change-level routing for human review re-entry requests.
 *
 * When enabled via MissionState context (`requirements_change_level_routing: true`)
 * or `evidence/mission-brief.json` (`requirementsGovernance.changeLevelRouting: true`),
 * review rejections route by change depth instead of unconditionally recreating
 * flat implementer rework tasks:
 * - L1_goal_purpose: pause for alignment re-approval + product_strategist brief update
 * - L2_requirement_process: product_strategist spec update -> implementer -> reviewer
 * - L3_implementation_model: bounded implementer fix + regression tests -> reviewer
 */
import * as path from 'node:path';
import { safeExistsSync, safeLstat, safeReadFile } from '../secure-io.js';
import {
  buildReviewGapText,
  classifyReviewReentryChangeLevel,
  type ReviewChangeLevel,
  type ReviewReentryRequest,
} from '../workforce/review-reentry.js';
import { isTaskSuperseded, writeMissionNextTasks } from './mission-lifecycle-completion.js';

export interface ChangeLevelReentryPlan {
  taskIds: string[];
  levels: ReviewChangeLevel[];
  highestLevel: ReviewChangeLevel;
  requiresAlignmentReapproval: boolean;
}

const LEVEL_PRIORITY: Record<ReviewChangeLevel, number> = {
  L1_goal_purpose: 3,
  L2_requirement_process: 2,
  L3_implementation_model: 1,
};

function readBriefChangeLevelFlag(missionDir: string): boolean {
  const briefPath = path.join(missionDir, 'evidence', 'mission-brief.json');
  if (!safeExistsSync(briefPath)) return false;
  try {
    const stat = safeLstat(briefPath);
    if (stat.isSymbolicLink() || !stat.isFile()) return false;
    const raw = safeReadFile(briefPath, { encoding: 'utf8' });
    const parsed = JSON.parse(String(raw)) as {
      requirementsGovernance?: { changeLevelRouting?: unknown };
    };
    return parsed?.requirementsGovernance?.changeLevelRouting === true;
  } catch {
    return false;
  }
}

/**
 * Determine whether opt-in change-level review re-entry routing is active.
 * Defaults to `false` to preserve legacy IL-04 behavior.
 */
export function isChangeLevelReentryRoutingEnabled(input: {
  missionDir: string;
  state?: { context?: Record<string, unknown> } | null;
  override?: boolean;
}): boolean {
  if (input.override !== undefined) return input.override;
  const ctxFlag = input.state?.context?.requirements_change_level_routing;
  if (typeof ctxFlag === 'boolean') return ctxFlag;
  return readBriefChangeLevelFlag(input.missionDir);
}

function buildReviewTask(
  taskId: string,
  targetTaskId: string,
  gapText: string,
  level: ReviewChangeLevel
): Record<string, unknown> {
  return {
    task_id: taskId,
    status: 'planned',
    assigned_to: { role: 'reviewer' },
    change_level: level,
    description: `Review whether ${targetTaskId} satisfies the ${level} change resolution: ${gapText}`,
    deliverable: `evidence/REVIEW-${targetTaskId}.md`,
    dependencies: [targetTaskId],
    review_target: targetTaskId,
    acceptance_criteria: [`Resolution verified with evidence for ${level}: ${gapText}`],
    risk: 'medium',
    expected_output_format: 'files',
    estimated_scope: 'S',
  };
}

function buildTasksForRequest(
  request: ReviewReentryRequest,
  index: number,
  round: number,
  goal: { summary: string; success_condition: string }
): { level: ReviewChangeLevel; tasks: Record<string, unknown>[] } {
  const level = classifyReviewReentryChangeLevel(request.reason_category);
  const gapText = buildReviewGapText(request);
  const slot = index + 1;

  if (level === 'L1_goal_purpose') {
    const alignId = `review-l1-r${round}-${slot}`;
    const reviewId = `${alignId}-review`;
    return {
      level,
      tasks: [
        {
          task_id: alignId,
          status: 'planned',
          assigned_to: { role: 'product_strategist' },
          phase_kind: 'alignment',
          change_level: 'L1_goal_purpose',
          requires_human_reapproval: true,
          description: `L1 Goal/Purpose re-alignment required before implementation resumes: ${gapText}. Re-frame evidence/mission-brief.json and re-open alignment approval.`,
          deliverable: `evidence/${alignId}.md`,
          target_path: `evidence/${alignId}.md`,
          dependencies: [],
          acceptance_criteria: [
            `Updated mission-brief.json addresses reviewer L1 concern: ${gapText}`,
            `Re-opened alignment approval references refreshed brief for goal: ${goal.summary}`,
          ],
          risk: 'high',
          expected_output_format: 'files',
          estimated_scope: 'M',
        },
        buildReviewTask(reviewId, alignId, gapText, 'L1_goal_purpose'),
      ],
    };
  }

  if (level === 'L2_requirement_process') {
    const specId = `review-l2-r${round}-${slot}-spec`;
    const implId = `review-l2-r${round}-${slot}`;
    const reviewId = `${implId}-review`;
    return {
      level,
      tasks: [
        {
          task_id: specId,
          status: 'planned',
          assigned_to: { role: 'product_strategist' },
          change_level: 'L2_requirement_process',
          description: `L2 Requirement/Scope update: revise acceptance criteria, scope boundaries, and decision ledger before implementation: ${gapText}`,
          deliverable: `evidence/${specId}.md`,
          target_path: `evidence/${specId}.md`,
          dependencies: [],
          acceptance_criteria: [
            `Updated scope and acceptance criteria cover: ${gapText}`,
            `Traced to goal condition: ${goal.success_condition}`,
          ],
          risk: 'medium',
          expected_output_format: 'files',
          estimated_scope: 'S',
        },
        {
          task_id: implId,
          status: 'planned',
          assigned_to: { role: 'implementer' },
          change_level: 'L2_requirement_process',
          description: `L2 Bounded implementation aligned to updated spec (${specId}): ${gapText}`,
          deliverable: `evidence/${implId}.md`,
          target_path: `evidence/${implId}.md`,
          dependencies: [specId],
          acceptance_criteria: [
            `Implementation matches revised specification ${specId}`,
            `Advances mission goal: ${goal.summary}`,
          ],
          risk: 'medium',
          expected_output_format: 'files',
          estimated_scope: 'M',
        },
        buildReviewTask(reviewId, implId, gapText, 'L2_requirement_process'),
      ],
    };
  }

  const implId = `review-l3-r${round}-${slot}`;
  const reviewId = `${implId}-review`;
  return {
    level: 'L3_implementation_model',
    tasks: [
      {
        task_id: implId,
        status: 'planned',
        assigned_to: { role: 'implementer' },
        change_level: 'L3_implementation_model',
        description: `L3 Bounded fix + regression test (requirements/scope unchanged): ${gapText}`,
        deliverable: `evidence/${implId}.md`,
        target_path: `evidence/${implId}.md`,
        dependencies: [],
        acceptance_criteria: [
          `Defect fixed without altering agreed scope: ${gapText}`,
          `Regression check added and verified for goal: ${goal.success_condition}`,
        ],
        risk: 'low',
        expected_output_format: 'files',
        estimated_scope: 'S',
      },
      buildReviewTask(reviewId, implId, gapText, 'L3_implementation_model'),
    ],
  };
}

/**
 * Upsert L1/L2/L3 routed tasks into NEXT_TASKS.json while preserving superseded tasks.
 */
export function upsertChangeLevelReentryTasks(input: {
  missionDir: string;
  round: number;
  requests: ReviewReentryRequest[];
  goal: { summary: string; success_condition: string };
}): ChangeLevelReentryPlan {
  const levels: ReviewChangeLevel[] = [];
  const upserted: Record<string, unknown>[] = [];
  input.requests.slice(0, 3).forEach((request, index) => {
    const built = buildTasksForRequest(request, index, input.round, input.goal);
    levels.push(built.level);
    upserted.push(...built.tasks);
  });

  const plannedOrder = upserted.map((task) => String(task.task_id || ''));
  let createdIds = new Set<string>();
  writeMissionNextTasks(input.missionDir, (tasks) => {
    const supersededIds = new Set(
      tasks.filter((task) => isTaskSuperseded(task)).map((task) => String(task.task_id || ''))
    );
    const kept = upserted.filter(
      (task) =>
        !supersededIds.has(String(task.task_id || '')) &&
        !supersededIds.has(String(task.review_target || ''))
    );
    createdIds = new Set(kept.map((task) => String(task.task_id || '')));
    const filtered = tasks.filter((task) => !createdIds.has(String(task.task_id || '')));
    return [...filtered, ...kept];
  });

  let highestLevel: ReviewChangeLevel = 'L3_implementation_model';
  for (const level of levels) {
    if (LEVEL_PRIORITY[level] > LEVEL_PRIORITY[highestLevel]) {
      highestLevel = level;
    }
  }

  return {
    taskIds: plannedOrder.filter((id) => createdIds.has(id)),
    levels,
    highestLevel,
    requiresAlignmentReapproval: highestLevel === 'L1_goal_purpose',
  };
}

/** Build merged state context fields when change-level routing handles review re-entries. */
export function buildChangeLevelReentryContextPatch(
  plan: ChangeLevelReentryPlan
): Record<string, unknown> {
  return {
    review_reentry_change_levels: plan.levels,
    review_reentry_highest_level: plan.highestLevel,
    ...(plan.requiresAlignmentReapproval ? { alignment_reapproval_required: true } : {}),
  };
}

export interface ReentryDispatchResult {
  gapTaskIds: string[];
  nextStatus: 'active' | 'paused';
  contextPatch: Record<string, unknown>;
  routedSummary?: string;
}

/**
 * Shared dispatch bridge for finishMission and reenterMissionFromReview.
 * Keeps legacy IL-04 flat task dispatch untouched unless change-level routing is opted in.
 */
export function dispatchReviewReentryWithPolicy(input: {
  missionDir: string;
  round: number;
  state: { context?: Record<string, unknown> };
  pendingReviewReentries: ReviewReentryRequest[];
  rawGoalGaps?: string[];
  fallbackAllGaps: string[];
  goal: { summary: string; success_condition: string };
  legacyUpsertGoalGapTasks: (args: {
    missionDir: string;
    round: number;
    gaps: string[];
    goal: { summary: string; success_condition: string };
  }) => string[];
}): ReentryDispatchResult {
  if (
    input.pendingReviewReentries.length > 0 &&
    isChangeLevelReentryRoutingEnabled({ missionDir: input.missionDir, state: input.state })
  ) {
    const plan = upsertChangeLevelReentryTasks({
      missionDir: input.missionDir,
      round: input.round,
      requests: input.pendingReviewReentries,
      goal: input.goal,
    });
    const rawGapIds =
      input.rawGoalGaps && input.rawGoalGaps.length > 0
        ? input.legacyUpsertGoalGapTasks({
            missionDir: input.missionDir,
            round: input.round,
            gaps: input.rawGoalGaps,
            goal: input.goal,
          })
        : [];
    return {
      gapTaskIds: [...plan.taskIds, ...rawGapIds],
      nextStatus: plan.requiresAlignmentReapproval ? 'paused' : 'active',
      contextPatch: buildChangeLevelReentryContextPatch(plan),
      routedSummary: `${plan.highestLevel} (${plan.levels.join(', ')})`,
    };
  }

  return {
    gapTaskIds: input.legacyUpsertGoalGapTasks({
      missionDir: input.missionDir,
      round: input.round,
      gaps: input.fallbackAllGaps,
      goal: input.goal,
    }),
    nextStatus: 'active',
    contextPatch: {},
  };
}
