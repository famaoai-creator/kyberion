/**
 * Deterministic expansion of a mission process template (workflow catalog
 * phase specs) into concrete NEXT_TASKS.json planned tasks and phase gate
 * definitions. No LLM involvement: the same design always yields the same
 * tasks, so expansion is replayable and testable (MO-01).
 */

import * as nodePath from 'node:path';

import type {
  MissionWorkflowDesign,
  WorkflowPhaseGate,
  WorkflowPhaseSpec,
  WorkflowPhaseTaskSpec,
} from './mission-workflow-catalog.js';

export const PROCESS_TEMPLATE_TASK_ORIGIN = 'process_template';

export interface ProcessTemplatePlannedTask {
  task_id: string;
  status: 'planned';
  assigned_to: { role: string };
  description: string;
  deliverable?: string;
  dependencies: string[];
  acceptance_criteria: string[];
  risk: 'low' | 'medium' | 'high' | 'approval_required' | 'high_stakes';
  expected_output_format: 'text' | 'files' | 'structured';
  estimated_scope: 'S' | 'M' | 'L';
  phase: string;
  phase_kind: 'implement' | 'review';
  review_target?: string;
  deliverable_kind?: 'doc' | 'deck' | 'code' | 'media';
  pipeline_ref?: string;
  origin: typeof PROCESS_TEMPLATE_TASK_ORIGIN;
}

export interface ProcessTemplateGateDefinition {
  phase: string;
  position: 'entry' | 'exit';
  gate: WorkflowPhaseGate;
}

export interface ExpandProcessTemplateInput {
  missionId: string;
  design: Pick<MissionWorkflowDesign, 'workflow_id' | 'phase_specs'>;
  /** Mission-relative evidence directory used for generated review deliverables. */
  evidenceDirRel?: string;
}

function substitutePlaceholders(value: string, missionId: string): string {
  return value.replaceAll('{MISSION_ID}', missionId);
}

function substituteDeep<T>(value: T, missionId: string): T {
  if (typeof value === 'string') {
    return substitutePlaceholders(value, missionId) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => substituteDeep(entry, missionId)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        substituteDeep(entry, missionId),
      ])
    ) as unknown as T;
  }
  return value;
}

function isReviewTask(spec: WorkflowPhaseTaskSpec, phase: WorkflowPhaseSpec): boolean {
  return spec.phase_kind === 'review' || (spec.phase_kind === undefined && phase.kind === 'review');
}

function defaultRole(review: boolean, spec: WorkflowPhaseTaskSpec): string {
  if (spec.team_role) return spec.team_role;
  return review ? 'reviewer' : 'worker';
}

/**
 * Expands the phase specs of a workflow design into a dependency-chained,
 * dispatch-ready planned task list. Tasks of phase N depend on every task of
 * the nearest preceding phase that declares tasks, so the existing
 * dependency-first dispatch executes phases in order without new machinery.
 * The output is self-checked against the orchestration worker's NEXT_TASKS
 * invariants (unique ids, resolvable dependencies, reviewer tasks carrying a
 * review_target they depend on with a REVIEW-<target>.md deliverable).
 */
export function expandProcessTemplateTasks(
  input: ExpandProcessTemplateInput
): ProcessTemplatePlannedTask[] {
  const phases = input.design.phase_specs ?? [];
  const evidenceDir = input.evidenceDirRel ?? 'evidence';
  const tasks: ProcessTemplatePlannedTask[] = [];
  const taskIdsBySuffix = new Map<string, string>();
  let previousPhaseTaskIds: string[] = [];

  for (const phase of phases) {
    const specs = phase.default_tasks ?? [];
    if (specs.length === 0) continue;
    const phaseTaskIds: string[] = [];

    for (const spec of specs) {
      const review = isReviewTask(spec, phase);
      const taskId = `${phase.id}-${spec.task_id_suffix}`;
      const dependencies = [...previousPhaseTaskIds];
      let reviewTarget: string | undefined;
      let deliverable = spec.deliverable
        ? substitutePlaceholders(spec.deliverable, input.missionId)
        : undefined;

      if (review) {
        const targetSuffix = spec.review_target_suffix;
        if (!targetSuffix) {
          throw new Error(
            `Process template ${input.design.workflow_id}: review task ${taskId} is missing review_target_suffix`
          );
        }
        reviewTarget = taskIdsBySuffix.get(targetSuffix);
        if (!reviewTarget) {
          throw new Error(
            `Process template ${input.design.workflow_id}: review task ${taskId} references unknown task suffix ${targetSuffix}`
          );
        }
        if (!dependencies.includes(reviewTarget)) dependencies.push(reviewTarget);
        const expectedBasename = `REVIEW-${reviewTarget}.md`;
        if (deliverable && nodePath.basename(deliverable) !== expectedBasename) {
          throw new Error(
            `Process template ${input.design.workflow_id}: review task ${taskId} must use deliverable basename ${expectedBasename}`
          );
        }
        deliverable = deliverable ?? `${evidenceDir}/${expectedBasename}`;
      }

      const task: ProcessTemplatePlannedTask = {
        task_id: taskId,
        status: 'planned',
        assigned_to: { role: defaultRole(review, spec) },
        description: substitutePlaceholders(spec.description, input.missionId),
        ...(deliverable ? { deliverable } : {}),
        dependencies,
        acceptance_criteria: (spec.acceptance_criteria ?? []).map((criterion) =>
          substitutePlaceholders(criterion, input.missionId)
        ),
        risk: spec.risk ?? 'medium',
        expected_output_format: spec.expected_output_format ?? 'files',
        estimated_scope: spec.estimated_scope ?? 'M',
        phase: phase.id,
        phase_kind: review ? 'review' : 'implement',
        ...(reviewTarget ? { review_target: reviewTarget } : {}),
        ...(spec.deliverable_kind ? { deliverable_kind: spec.deliverable_kind } : {}),
        ...((spec.pipeline_ref ?? phase.pipeline_ref)
          ? { pipeline_ref: spec.pipeline_ref ?? phase.pipeline_ref }
          : {}),
        origin: PROCESS_TEMPLATE_TASK_ORIGIN,
      };
      tasks.push(task);
      phaseTaskIds.push(taskId);
      taskIdsBySuffix.set(spec.task_id_suffix, taskId);
    }

    previousPhaseTaskIds = phaseTaskIds;
  }

  assertExpansionInvariants(input.design.workflow_id, tasks);
  return tasks;
}

function assertExpansionInvariants(workflowId: string, tasks: ProcessTemplatePlannedTask[]): void {
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.task_id)) {
      throw new Error(`Process template ${workflowId}: duplicate task_id ${task.task_id}`);
    }
    ids.add(task.task_id);
  }
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!ids.has(dependency)) {
        throw new Error(
          `Process template ${workflowId}: task ${task.task_id} depends on missing task ${dependency}`
        );
      }
    }
    if (task.phase_kind === 'review') {
      if (!task.review_target || !task.dependencies.includes(task.review_target)) {
        throw new Error(
          `Process template ${workflowId}: review task ${task.task_id} must depend on its review_target`
        );
      }
      const expected = `REVIEW-${task.review_target}.md`;
      if (!task.deliverable || nodePath.basename(task.deliverable) !== expected) {
        throw new Error(
          `Process template ${workflowId}: review task ${task.task_id} must use deliverable ${expected}`
        );
      }
    }
  }
  // Cycle check (defensive: construction is forward-only, but catalog edits
  // must never brick dispatch).
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(tasks.map((task) => [task.task_id, task]));
  const visit = (taskId: string): void => {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) {
      throw new Error(`Process template ${workflowId}: dependency cycle detected at ${taskId}`);
    }
    visiting.add(taskId);
    for (const dependency of byId.get(taskId)?.dependencies ?? []) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of tasks) visit(task.task_id);
}

/**
 * Collects the entry/exit gate definitions declared by a design's phase
 * specs, with {MISSION_ID} placeholders substituted, in phase order.
 */
export function processTemplateGateDefinitions(
  missionId: string,
  design: Pick<MissionWorkflowDesign, 'phase_specs'>
): ProcessTemplateGateDefinition[] {
  const definitions: ProcessTemplateGateDefinition[] = [];
  for (const phase of design.phase_specs ?? []) {
    if (phase.entry_gate) {
      definitions.push({
        phase: phase.id,
        position: 'entry',
        gate: substituteDeep(phase.entry_gate, missionId),
      });
    }
    if (phase.exit_gate) {
      definitions.push({
        phase: phase.id,
        position: 'exit',
        gate: substituteDeep(phase.exit_gate, missionId),
      });
    }
  }
  return definitions;
}
