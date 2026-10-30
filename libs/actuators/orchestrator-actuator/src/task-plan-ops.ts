import { getReasoningBackend } from '@agent/core/reasoning/reasoning-backend';
import { pathResolver } from '@agent/core/path-resolver';
import { resolveMissionDir } from '@agent/core/owner-scope';
import {
  evaluateTaskPlanReadyGate,
  readDesignSpecAtPath,
  readDesignSpec,
  readTaskPlan,
  saveTaskPlan,
} from '@agent/core/sdlc-artifact-store';
import {
  readRequirementsDraft,
  readRequirementsDraftAtPath,
} from '@agent/core/requirements-draft-store';
import { assertSafeRepositoryPath } from '@agent/core/secure-io';
import { logger } from '@agent/core/core';
import {
  readMissionNextTasks,
  writeMissionNextTasks,
} from '@agent/core/mission/mission-lifecycle-completion';

function resolveTaskPlanInputPath(ref: string): string {
  return assertSafeRepositoryPath(pathResolver.rootResolve(ref), { allowMissingLeaf: true });
}

export async function decomposeIntoTasks(input: {
  mission_id: string;
  project_name: string;
  requirements_draft_path?: string;
  design_spec_path?: string;
}) {
  if (!input.mission_id || !input.project_name) {
    throw new Error('[decompose_into_tasks] requires mission_id and project_name');
  }
  const backend = getReasoningBackend();
  const requirementsDraftPath = input.requirements_draft_path
    ? resolveTaskPlanInputPath(input.requirements_draft_path)
    : undefined;
  const requirementsDraft =
    readRequirementsDraft(input.mission_id) ??
    (requirementsDraftPath ? readRequirementsDraftAtPath(requirementsDraftPath) : null);
  if (!requirementsDraft) {
    throw new Error('[decompose_into_tasks] requirements draft not found');
  }
  const designSpecPath = input.design_spec_path
    ? resolveTaskPlanInputPath(input.design_spec_path)
    : undefined;
  const designSpec =
    readDesignSpec(input.mission_id) ??
    (designSpecPath ? readDesignSpecAtPath(designSpecPath) : undefined);
  const decomposed = await backend.decomposeIntoTasks({
    requirementsDraft,
    designSpec,
    projectName: input.project_name,
  });
  const saved = saveTaskPlan({
    missionId: input.mission_id,
    projectName: input.project_name,
    decomposed,
    sourceRefs: [
      `active/missions/${input.mission_id}/evidence/requirements-draft.json`,
      ...(designSpec ? [`active/missions/${input.mission_id}/evidence/design-spec.json`] : []),
    ],
    generatedBy: backend.name,
  });
  return {
    mission_id: input.mission_id,
    version: saved.version,
    draft_path: `active/missions/${input.mission_id}/evidence/task-plan.json`,
    task_count: saved.tasks.length,
    task_plan_ready: evaluateTaskPlanReadyGate(input.mission_id),
  };
}

export function taskPlanToNextTasks(input: { mission_id: string }) {
  if (!input.mission_id) throw new Error('[task_plan_to_next_tasks] requires mission_id');
  const plan = readTaskPlan(input.mission_id);
  if (!plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    throw new Error('[task_plan_to_next_tasks] task plan not found or empty');
  }
  const stubTasks = plan.tasks.filter(
    (task) =>
      /\[STUB\]/.test(String(task.title || '')) || /^T-STUB/i.test(String(task.task_id || ''))
  );
  if (stubTasks.length > 0) {
    throw new Error(
      `[task_plan_to_next_tasks] task plan contains ${stubTasks.length} stub placeholder task(s) — regenerate with a real reasoning backend (KYBERION_REASONING_BACKEND)`
    );
  }
  const scopeOf = (estimate?: string): 'S' | 'M' | 'L' =>
    estimate === 'L' || estimate === 'XL' ? 'L' : estimate === 'M' ? 'M' : 'S';
  const nextTasks = plan.tasks.map((task) => {
    const dependencies = Array.isArray(task.depends_on) ? task.depends_on : [];
    let role =
      task.assigned_role === 'tester'
        ? 'qa'
        : task.assigned_role === 'reviewer'
          ? 'reviewer'
          : 'implementer';
    const reviewTarget = role === 'reviewer' || role === 'qa' ? dependencies[0] : undefined;
    if ((role === 'reviewer' || role === 'qa') && !reviewTarget) role = 'implementer';
    const scope = scopeOf(task.estimate);
    return {
      task_id: task.task_id,
      status: 'planned',
      assigned_to: { role },
      description: `${task.title} — ${task.summary}`,
      deliverable: reviewTarget
        ? `deliverables/REVIEW-${reviewTarget}.md`
        : task.deliverables?.[0] || `deliverables/${task.task_id}.md`,
      dependencies,
      acceptance_criteria: Array.isArray(task.test_criteria) ? task.test_criteria : [],
      estimated_scope: scope,
      risk: scope === 'L' ? 'high' : scope === 'M' ? 'medium' : 'low',
      ...(reviewTarget ? { review_target: reviewTarget } : {}),
    };
  });
  // NEXT_TASKS.json belongs to the existing mission wherever it lives; an
  // unknown mission fails closed (OwnerScopeError) instead of landing in public.
  const missionDir = resolveMissionDir(input.mission_id);
  const nextTasksPath = `${missionDir}/NEXT_TASKS.json`;
  // Through the one board writer, against the board read under its lease: the
  // new plan replaces the board, but a task superseded on disk keeps its
  // record (M2), and a plan task that depends on (or reviews) a superseded id
  // is pointed at its replacement, which a superseded task never satisfies.
  writeMissionNextTasks(missionDir, (onDisk) => {
    const replacedBy = new Map<string, string>();
    for (const task of onDisk) {
      const by = (task.superseded as { by_task_id?: unknown } | undefined)?.by_task_id;
      if (task.status === 'superseded' && typeof by === 'string' && by) {
        replacedBy.set(String(task.task_id || ''), by);
      }
    }
    const resolve = (taskId: string): string => {
      const seen = new Set([taskId]);
      let current = taskId;
      while (replacedBy.has(current) && !seen.has(replacedBy.get(current)!)) {
        current = replacedBy.get(current)!;
        seen.add(current);
      }
      return current;
    };
    const reused = nextTasks.filter((task) => replacedBy.has(task.task_id)).map((t) => t.task_id);
    if (reused.length > 0) {
      logger.warn(
        `[task_plan_to_next_tasks] plan tasks ${reused.join(', ')} were superseded — their superseded entries are kept, not the plan's | regenerate the plan without them, or supersede them again | mission=${input.mission_id}`
      );
    }
    return nextTasks.map((task) => {
      const reviewTarget = task.review_target ? resolve(task.review_target) : undefined;
      return {
        ...task,
        dependencies: [...new Set(task.dependencies.map(resolve))],
        ...(reviewTarget
          ? { review_target: reviewTarget, deliverable: `deliverables/REVIEW-${reviewTarget}.md` }
          : {}),
      };
    });
  });
  return {
    mission_id: input.mission_id,
    next_tasks_path: nextTasksPath,
    // The board as written: the plan plus any superseded task (and its
    // replacement) the board writer kept.
    task_count: readMissionNextTasks(missionDir).length,
  };
}
