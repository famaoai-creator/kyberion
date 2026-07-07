/**
 * scripts/refactor/mission-process-planning.ts
 *
 * Applies a mission's process template (workflow catalog phase specs) to the
 * mission directory: expands the per-phase default tasks into NEXT_TASKS.json,
 * persists the phase gate definitions, and renders a phase checklist into
 * TASK_BOARD.md. Deterministic (no LLM) — see
 * @agent/core/mission-process-task-expansion (MO-01).
 */

import * as path from 'node:path';

import {
  evaluateMissionGate,
  expandProcessTemplateTasks,
  findMissionPath,
  logger,
  processTemplateGateDefinitions,
  resolveMissionWorkflowDesign,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeReadFile,
  safeWriteFile,
  type MissionGateDefinition,
  type MissionGateEvaluation,
  type MissionClass,
  type MissionDeliveryShape,
  type MissionRiskProfile,
  type MissionStage,
  type MissionWorkflowDesign,
  type ProcessTemplatePlannedTask,
  PROCESS_TEMPLATE_TASK_ORIGIN,
} from '@agent/core';

import { loadState, saveState } from './mission-state.js';
import type { MissionState } from './mission-types.js';

export interface ApplyProcessTemplatePlanResult {
  tasks: ProcessTemplatePlannedTask[];
  nextTasksPath: string;
  gatePaths: string[];
  taskBoardUpdated: boolean;
  skipped?: 'no_default_tasks' | 'existing_next_tasks';
}

/**
 * Expands the design's phase specs into the mission's NEXT_TASKS.json and
 * gate definitions. Refuses to overwrite an existing NEXT_TASKS.json that was
 * not produced by a process template unless `force` is set — planner-authored
 * plans must never be silently clobbered.
 */
export function applyProcessTemplatePlan(input: {
  missionId: string;
  missionDir: string;
  design: MissionWorkflowDesign;
  force?: boolean;
}): ApplyProcessTemplatePlanResult {
  const { missionId, missionDir, design } = input;
  const nextTasksPath = path.join(missionDir, 'NEXT_TASKS.json');

  const tasks = expandProcessTemplateTasks({ missionId, design });
  if (tasks.length === 0) {
    return {
      tasks: [],
      nextTasksPath,
      gatePaths: [],
      taskBoardUpdated: false,
      skipped: 'no_default_tasks',
    };
  }

  const existing = safeExistsSync(nextTasksPath) ? readTasksSafe(nextTasksPath) : [];
  if (existing.length > 0 && !input.force) {
    const templateAuthored = existing.every(
      (task) => task?.origin === PROCESS_TEMPLATE_TASK_ORIGIN
    );
    if (!templateAuthored) {
      return {
        tasks: [],
        nextTasksPath,
        gatePaths: [],
        taskBoardUpdated: false,
        skipped: 'existing_next_tasks',
      };
    }
  }

  // Re-planning must not lose progress: carry over the status of tasks whose
  // task_id survives the re-expansion (e.g. --refresh-catalog after a
  // catalog fix on a partially completed mission).
  const previousStatus = new Map(
    existing
      .filter((task) => typeof task.task_id === 'string' && typeof task.status === 'string')
      .map((task) => [task.task_id as string, task.status as string])
  );
  for (const task of tasks) {
    const carried = previousStatus.get(task.task_id);
    if (carried && carried !== 'planned') {
      (task as unknown as Record<string, unknown>).status = carried;
    }
  }

  safeWriteFile(nextTasksPath, JSON.stringify(tasks, null, 2));

  const gateDefsDir = path.join(missionDir, 'gates', 'definitions');
  const gatePaths: string[] = [];
  for (const definition of processTemplateGateDefinitions(missionId, design)) {
    safeMkdir(gateDefsDir, { recursive: true });
    const gatePath = path.join(gateDefsDir, `${definition.gate.id}.json`);
    safeWriteFile(
      gatePath,
      JSON.stringify(
        {
          mission_id: missionId,
          phase: definition.phase,
          position: definition.position,
          gate: definition.gate,
        },
        null,
        2
      )
    );
    gatePaths.push(gatePath);
  }

  const taskBoardUpdated = renderPhaseChecklist(missionDir, design, tasks);
  return { tasks, nextTasksPath, gatePaths, taskBoardUpdated };
}

function readTasksSafe(nextTasksPath: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(safeReadFile(nextTasksPath, { encoding: 'utf8' }) as string);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const CHECKLIST_HEADER = '## Process Phases';

function renderPhaseChecklist(
  missionDir: string,
  design: MissionWorkflowDesign,
  tasks: ProcessTemplatePlannedTask[]
): boolean {
  const taskBoardPath = path.join(missionDir, 'TASK_BOARD.md');
  if (!safeExistsSync(taskBoardPath)) return false;
  const board = safeReadFile(taskBoardPath, { encoding: 'utf8' }) as string;
  if (board.includes(CHECKLIST_HEADER)) return false;

  const lines: string[] = ['', CHECKLIST_HEADER, ''];
  for (const spec of design.phase_specs ?? []) {
    const phaseTasks = tasks.filter((task) => task.phase === spec.id);
    const title = spec.title ? `${spec.id} — ${spec.title}` : spec.id;
    lines.push(`### ${title}`);
    for (const task of phaseTasks) {
      lines.push(`- [ ] \`${task.task_id}\`: ${task.description}`);
    }
    if (spec.exit_gate) {
      lines.push(`- 🚧 exit gate: \`${spec.exit_gate.id}\``);
    }
    lines.push('');
  }
  safeWriteFile(taskBoardPath, `${board.trimEnd()}\n${lines.join('\n')}`);
  return true;
}

/**
 * `mission_controller plan-tasks <MISSION_ID> [--force]` — applies the
 * mission's persisted process template to an existing mission. Re-resolves
 * the workflow design when the persisted state predates phase specs (legacy
 * missions backfilled by startMission).
 */
export async function planProcessTemplateTasks(args: {
  id: string;
  force?: boolean;
  /** Re-resolve from the current catalog, ignoring persisted phase_specs. */
  refreshCatalog?: boolean;
}): Promise<void> {
  const missionId = args.id.toUpperCase();
  const state = loadState(missionId);
  if (!state) {
    logger.error(`Mission ${missionId} not found.`);
    return;
  }
  const missionDir = findMissionPath(missionId);
  if (!missionDir) {
    logger.error(`Mission directory for ${missionId} not found.`);
    return;
  }

  const design = resolveDesignForState(missionId, state, {
    refreshCatalog: args.refreshCatalog,
  });
  if (!design) {
    logger.error(
      `Mission ${missionId} has no classification/process template; run classify or workflow-select first.`
    );
    return;
  }

  const result = applyProcessTemplatePlan({ missionId, missionDir, design, force: args.force });
  if (result.skipped === 'existing_next_tasks') {
    logger.error(
      `NEXT_TASKS.json for ${missionId} already exists and was not produced by a process template. Re-run with --force to overwrite.`
    );
    return;
  }
  if (result.skipped === 'no_default_tasks') {
    logger.info(
      `Process template ${design.workflow_id} declares no default tasks; nothing to plan.`
    );
    return;
  }

  if (design.phase_specs) {
    state.process_template = {
      workflow_id: design.workflow_id,
      pattern: design.pattern,
      phases: design.phases,
      phase_specs: design.phase_specs,
      ...(state.process_template?.current_phase
        ? { current_phase: state.process_template.current_phase }
        : {}),
    };
    state.history = state.history || [];
    state.history.push({
      ts: new Date().toISOString(),
      event: 'PLAN_TASKS',
      note: `Expanded process template ${design.workflow_id} into ${result.tasks.length} tasks.`,
    });
    await saveState(missionId, state);
  }

  logger.success(
    `📋 Planned ${result.tasks.length} tasks from process template ${design.workflow_id} → ${result.nextTasksPath} (${result.gatePaths.length} gate definitions).`
  );
}

export interface StoredGateEvaluationResult {
  found: boolean;
  phase?: string;
  position?: 'entry' | 'exit';
  evaluation?: MissionGateEvaluation;
}

function gateDefinitionPath(missionDir: string, gateId: string): string {
  return path.join(missionDir, 'gates', 'definitions', `${gateId}.json`);
}

/**
 * Resolves mission-relative paths inside gate check params against the
 * mission directory so `evidence_exists` / `deliverable_quality` checks work
 * regardless of the process cwd.
 */
function resolveGateCheckPaths(
  gate: MissionGateDefinition,
  missionDir: string,
  humanConfirmed: boolean
): MissionGateDefinition {
  const PATH_KEYS = new Set(['path', 'paths', 'artifact_path', 'deliverable', 'evidence_paths']);
  const resolveValue = (value: unknown): unknown => {
    if (typeof value === 'string' && value && !path.isAbsolute(value)) {
      return path.join(missionDir, value);
    }
    if (Array.isArray(value)) return value.map(resolveValue);
    return value;
  };
  return {
    ...gate,
    checks: gate.checks.map((check) => {
      const params: Record<string, unknown> = { ...(check.params || {}) };
      for (const key of Object.keys(params)) {
        if (PATH_KEYS.has(key)) params[key] = resolveValue(params[key]);
      }
      // The operator's explicit gate command IS the human confirmation:
      // reviewer_approved / human_override checks are satisfied by it.
      if (humanConfirmed && check.kind === 'reviewer_approved') params.approved = true;
      if (humanConfirmed && check.kind === 'human_override') params.allow = true;
      return { ...check, params };
    }),
  };
}

/**
 * Machine-evaluates a stored process-template gate definition
 * (`gates/definitions/<GATE_ID>.json`). Returns found:false when the mission
 * has no such definition, letting callers fall back to the legacy
 * evidence-file gate flow.
 */
export async function evaluateStoredMissionGate(args: {
  missionId: string;
  gateId: string;
  humanConfirmed?: boolean;
}): Promise<StoredGateEvaluationResult> {
  const missionId = args.missionId.toUpperCase();
  const missionDir = findMissionPath(missionId);
  if (!missionDir) return { found: false };
  const definitionPath = gateDefinitionPath(missionDir, args.gateId);
  if (!safeExistsSync(definitionPath)) return { found: false };

  const definition = JSON.parse(safeReadFile(definitionPath, { encoding: 'utf8' }) as string) as {
    phase?: string;
    position?: 'entry' | 'exit';
    gate: MissionGateDefinition;
  };

  const gate = resolveGateCheckPaths(definition.gate, missionDir, args.humanConfirmed ?? false);
  const evaluation = await evaluateMissionGate({
    missionId,
    gate,
    evidenceDir: path.join(missionDir, 'gates', 'records'),
  });
  return {
    found: true,
    phase: definition.phase,
    position: definition.position,
    evaluation,
  };
}

export interface PhaseEntryGateVerdict {
  gateId: string;
  verdict: 'pass' | 'fail';
  reasons: string[];
}

/**
 * Evaluates the stored entry gate of a phase, if one was declared by the
 * process template. Returns undefined when the phase has no entry gate —
 * dispatch proceeds as usual.
 */
export async function evaluatePhaseEntryGate(args: {
  missionId: string;
  phase: string;
}): Promise<PhaseEntryGateVerdict | undefined> {
  const missionId = args.missionId.toUpperCase();
  const missionDir = findMissionPath(missionId);
  if (!missionDir) return undefined;
  const definitionsDir = path.join(missionDir, 'gates', 'definitions');
  if (!safeExistsSync(definitionsDir)) return undefined;
  for (const entry of safeReaddir(definitionsDir) as string[]) {
    if (!entry.endsWith('.json')) continue;
    let definition: { phase?: string; position?: string; gate?: { id?: string } };
    try {
      definition = JSON.parse(
        safeReadFile(path.join(definitionsDir, entry), { encoding: 'utf8' }) as string
      );
    } catch {
      continue;
    }
    if (definition.phase !== args.phase || definition.position !== 'entry') continue;
    const gateId = definition.gate?.id ?? entry.replace(/\.json$/u, '');
    const stored = await evaluateStoredMissionGate({ missionId, gateId });
    if (!stored.found || !stored.evaluation) return undefined;
    return {
      gateId,
      verdict: stored.evaluation.verdict,
      reasons: stored.evaluation.reasons,
    };
  }
  return undefined;
}

function markPhaseTasksStatus(missionId: string, phase: string, status: string): number {
  const missionDir = findMissionPath(missionId.toUpperCase());
  if (!missionDir) return 0;
  const nextTasksPath = path.join(missionDir, 'NEXT_TASKS.json');
  if (!safeExistsSync(nextTasksPath)) return 0;
  const tasks = readTasksSafe(nextTasksPath);
  let changed = 0;
  for (const task of tasks) {
    if (task.phase === phase && task.origin === PROCESS_TEMPLATE_TASK_ORIGIN) {
      task.status = status;
      changed += 1;
    }
  }
  if (changed > 0) safeWriteFile(nextTasksPath, JSON.stringify(tasks, null, 2));
  return changed;
}

/**
 * Flips a phase's process-template tasks back to `rework` after a gate-fail
 * so dependency-first dispatch re-executes them.
 */
export function markPhaseTasksForRework(missionId: string, phase: string): number {
  return markPhaseTasksStatus(missionId, phase, 'rework');
}

/**
 * Marks a phase's process-template tasks completed after its exit gate
 * passes — the gate IS the phase's acceptance, so the task board must agree.
 */
export function markPhaseTasksCompleted(missionId: string, phase: string): number {
  return markPhaseTasksStatus(missionId, phase, 'completed');
}

/**
 * A passed gate means the mission is actually running: promote a still
 * `planned` mission to `active` so lifecycle status and gate progression
 * stay in sync.
 */
export async function activateMissionOnGateProgress(missionId: string): Promise<boolean> {
  const upperId = missionId.toUpperCase();
  const state = loadState(upperId);
  if (!state || state.status !== 'planned') return false;
  state.status = 'active';
  state.history = state.history || [];
  state.history.push({
    ts: new Date().toISOString(),
    event: 'GATE_ACTIVATE',
    note: 'Mission activated automatically on first passed process gate.',
  });
  await saveState(upperId, state);
  return true;
}

/**
 * Advances mission-state's `process_template.current_phase` after a passed
 * exit gate.
 */
export async function advanceCurrentPhase(missionId: string, passedPhase: string): Promise<void> {
  const upperId = missionId.toUpperCase();
  const state = loadState(upperId);
  if (!state?.process_template) return;
  const phases = state.process_template.phases || [];
  const index = phases.indexOf(passedPhase);
  if (index < 0) return;
  const nextPhase = phases[index + 1];
  state.process_template.current_phase = nextPhase ?? passedPhase;
  await saveState(upperId, state);
}

function resolveDesignForState(
  missionId: string,
  state: MissionState,
  options: { refreshCatalog?: boolean } = {}
): MissionWorkflowDesign | undefined {
  const persisted = state.process_template;
  if (!options.refreshCatalog && persisted?.phase_specs?.length) {
    return {
      workflow_id: persisted.workflow_id,
      pattern: persisted.pattern,
      stage: state.classification?.stage ?? 'planning',
      phases: persisted.phases,
      phase_specs: persisted.phase_specs,
      rationale: `Persisted process template for ${missionId}.`,
    };
  }
  const classification = state.classification;
  if (!classification && !state.mission_type) return undefined;
  // Leave class/shape empty when unclassified so the mission_type hint can
  // supply them (otherwise a default 'code_change' would shadow the hint and
  // reroute e.g. presentation missions onto the aidlc template).
  return resolveMissionWorkflowDesign({
    missionClass: (classification?.mission_class ?? '') as MissionClass,
    deliveryShape: (classification?.delivery_shape ?? '') as MissionDeliveryShape,
    riskProfile: classification?.risk_profile ?? ('review_required' as MissionRiskProfile),
    stage: classification?.stage ?? ('planning' as MissionStage),
    executionShape: 'mission',
    missionTypeHint: state.mission_type,
  });
}
