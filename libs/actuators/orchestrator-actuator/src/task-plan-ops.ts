import { getReasoningBackend } from '@agent/core/reasoning-backend';
import { loadJson } from '@agent/core/foundation';
import { missionDir, pathResolver } from '@agent/core/path-resolver';
import {
  evaluateTaskPlanReadyGate,
  readDesignSpec,
  readTaskPlan,
  saveTaskPlan,
} from '@agent/core/sdlc-artifact-store';
import { readRequirementsDraft } from '@agent/core/requirements-draft-store';
import { assertSafeRepositoryPath, safeExistsSync, safeWriteFile } from '@agent/core/secure-io';

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
  const requirementsDraft =
    readRequirementsDraft(input.mission_id) ??
    (input.requirements_draft_path &&
    safeExistsSync(resolveTaskPlanInputPath(input.requirements_draft_path))
      ? loadJson<unknown>(resolveTaskPlanInputPath(input.requirements_draft_path))
      : null);
  if (!requirementsDraft) {
    throw new Error('[decompose_into_tasks] requirements draft not found');
  }
  const designSpec =
    readDesignSpec(input.mission_id) ??
    (input.design_spec_path && safeExistsSync(resolveTaskPlanInputPath(input.design_spec_path))
      ? loadJson<unknown>(resolveTaskPlanInputPath(input.design_spec_path))
      : undefined);
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
  const nextTasksPath = `${missionDir(input.mission_id, 'public')}/NEXT_TASKS.json`;
  safeWriteFile(nextTasksPath, JSON.stringify(nextTasks, null, 2));
  return {
    mission_id: input.mission_id,
    next_tasks_path: nextTasksPath,
    task_count: nextTasks.length,
  };
}
