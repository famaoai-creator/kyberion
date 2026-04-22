/**
 * SDLC Artifact Store — persist / load design-spec, test-plan, task-plan
 * for a mission. Unified file because the storage shape is identical:
 * one artifact JSON per kind under the mission's evidence dir, auto-
 * bumped version on re-generation.
 *
 * Gate evaluators (DESIGN / TEST / TASK readiness) ride on the same
 * module so callers that don't need the full wisdom-actuator surface
 * can still inspect artifact health.
 */

import * as path from 'node:path';
import { missionEvidenceDir } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeWriteFile } from './secure-io.js';
import type {
  DecomposedTaskPlan,
  ExtractedDesignSpec,
  ExtractedTestPlan,
} from './reasoning-backend.js';

const DESIGN_FILE = 'design-spec.json';
const TEST_PLAN_FILE = 'test-plan.json';
const TASK_PLAN_FILE = 'task-plan.json';

export interface DesignSpec extends ExtractedDesignSpec {
  version: string;
  project_name: string;
  source_refs?: string[];
  generated_at: string;
  generated_by?: string;
}

export interface TestPlan extends ExtractedTestPlan {
  version: string;
  project_name: string;
  source_refs?: string[];
  generated_at: string;
  generated_by?: string;
}

export interface TaskPlan extends DecomposedTaskPlan {
  version: string;
  project_name: string;
  source_refs?: string[];
  generated_at: string;
  generated_by?: string;
}

function artifactPath(missionId: string, filename: string): string | null {
  const dir = missionEvidenceDir(missionId);
  if (!dir) return null;
  return path.join(dir, filename);
}

function bumpVersion(previous?: string): string {
  if (!previous) return 'v1';
  const match = previous.match(/^v(\d+)$/u);
  if (!match) return 'v1';
  return `v${parseInt(match[1], 10) + 1}`;
}

function readArtifact<T>(missionId: string, filename: string): T | null {
  const file = artifactPath(missionId, filename);
  if (!file || !safeExistsSync(file)) return null;
  return JSON.parse(safeReadFile(file, { encoding: 'utf8' }) as string) as T;
}

function writeArtifact(missionId: string, filename: string, data: unknown): string {
  const file = artifactPath(missionId, filename);
  if (!file) {
    throw new Error(`[sdlc-artifact-store] mission evidence dir not found for ${missionId}`);
  }
  safeWriteFile(file, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mkdir: true });
  return file;
}

// ----- Design spec --------------------------------------------------------

export interface SaveDesignSpecParams {
  missionId: string;
  projectName: string;
  extracted: ExtractedDesignSpec;
  sourceRefs?: string[];
  generatedBy?: string;
  version?: string;
}

export function readDesignSpec(missionId: string): DesignSpec | null {
  return readArtifact<DesignSpec>(missionId, DESIGN_FILE);
}

export function saveDesignSpec(params: SaveDesignSpecParams): DesignSpec {
  const existing = readDesignSpec(params.missionId);
  const version = params.version ?? bumpVersion(existing?.version);
  const spec: DesignSpec = {
    ...params.extracted,
    version,
    project_name: params.projectName,
    ...(params.sourceRefs ? { source_refs: params.sourceRefs } : {}),
    generated_at: new Date().toISOString(),
    ...(params.generatedBy ? { generated_by: params.generatedBy } : {}),
  };
  writeArtifact(params.missionId, DESIGN_FILE, spec);
  return spec;
}

// ----- Test plan ----------------------------------------------------------

export interface SaveTestPlanParams {
  missionId: string;
  projectName: string;
  extracted: ExtractedTestPlan;
  sourceRefs?: string[];
  generatedBy?: string;
  version?: string;
}

export function readTestPlan(missionId: string): TestPlan | null {
  return readArtifact<TestPlan>(missionId, TEST_PLAN_FILE);
}

export function saveTestPlan(params: SaveTestPlanParams): TestPlan {
  const existing = readTestPlan(params.missionId);
  const version = params.version ?? bumpVersion(existing?.version);
  const plan: TestPlan = {
    ...params.extracted,
    version,
    project_name: params.projectName,
    ...(params.sourceRefs ? { source_refs: params.sourceRefs } : {}),
    generated_at: new Date().toISOString(),
    ...(params.generatedBy ? { generated_by: params.generatedBy } : {}),
  };
  writeArtifact(params.missionId, TEST_PLAN_FILE, plan);
  return plan;
}

// ----- Task plan ----------------------------------------------------------

export interface SaveTaskPlanParams {
  missionId: string;
  projectName: string;
  decomposed: DecomposedTaskPlan;
  sourceRefs?: string[];
  generatedBy?: string;
  version?: string;
}

export function readTaskPlan(missionId: string): TaskPlan | null {
  return readArtifact<TaskPlan>(missionId, TASK_PLAN_FILE);
}

export function saveTaskPlan(params: SaveTaskPlanParams): TaskPlan {
  const existing = readTaskPlan(params.missionId);
  const version = params.version ?? bumpVersion(existing?.version);
  const plan: TaskPlan = {
    ...params.decomposed,
    version,
    project_name: params.projectName,
    ...(params.sourceRefs ? { source_refs: params.sourceRefs } : {}),
    generated_at: new Date().toISOString(),
    ...(params.generatedBy ? { generated_by: params.generatedBy } : {}),
  };
  writeArtifact(params.missionId, TASK_PLAN_FILE, plan);
  return plan;
}

// ----- Gate evaluators ----------------------------------------------------

export interface GateResult {
  passed: boolean;
  reasons: string[];
}

/**
 * ARCHITECTURE_READY (design artifact side) — design spec present, at
 * least one component with requirements_refs, and no `blocking: true`
 * open_decisions remain.
 */
export function evaluateArchitectureReadyGate(missionId: string): GateResult {
  const spec = readDesignSpec(missionId);
  const reasons: string[] = [];
  if (!spec) return { passed: false, reasons: ['no design-spec.json present'] };
  if (spec.components.length === 0) reasons.push('components array is empty');
  const unmapped = spec.components.filter((c) => !c.requirements_refs || c.requirements_refs.length === 0);
  if (unmapped.length > 0) {
    reasons.push(
      `components missing requirements_refs: ${unmapped.map((c) => c.id).join(', ')}`,
    );
  }
  const blocking = spec.open_decisions.filter((d) => d.blocking === true);
  if (blocking.length > 0) {
    reasons.push(`${blocking.length} blocking open_decision(s) remain`);
  }
  return { passed: reasons.length === 0, reasons };
}

/**
 * QA_READY (test plan side) — test plan present, every must-have FR in
 * the paired requirements draft has at least one covering case.
 */
export function evaluateQaReadyGate(
  missionId: string,
  mustHaveRequirementIds: string[] = [],
): GateResult {
  const plan = readTestPlan(missionId);
  const reasons: string[] = [];
  if (!plan) return { passed: false, reasons: ['no test-plan.json present'] };
  if (plan.cases.length === 0) reasons.push('test plan cases array is empty');
  if (mustHaveRequirementIds.length > 0) {
    const covered = new Set(
      plan.cases.flatMap((c) => c.covers_requirements ?? []),
    );
    const missing = mustHaveRequirementIds.filter((id) => !covered.has(id));
    if (missing.length > 0) {
      reasons.push(`must-have requirements without coverage: ${missing.join(', ')}`);
    }
  }
  return { passed: reasons.length === 0, reasons };
}

/**
 * TASK_PLAN_READY — task plan present, dependencies reference existing
 * task_ids, no cycles, every must-priority task has test_criteria.
 */
export function evaluateTaskPlanReadyGate(missionId: string): GateResult {
  const plan = readTaskPlan(missionId);
  const reasons: string[] = [];
  if (!plan) return { passed: false, reasons: ['no task-plan.json present'] };
  if (plan.tasks.length === 0) reasons.push('task plan tasks array is empty');
  const ids = new Set(plan.tasks.map((t) => t.task_id));
  for (const task of plan.tasks) {
    for (const dep of task.depends_on ?? []) {
      if (!ids.has(dep)) {
        reasons.push(`task ${task.task_id} depends on unknown ${dep}`);
      }
    }
  }
  const mustsWithoutCriteria = plan.tasks.filter(
    (t) => t.priority === 'must' && (!t.test_criteria || t.test_criteria.length === 0),
  );
  if (mustsWithoutCriteria.length > 0) {
    reasons.push(
      `must-priority tasks without test_criteria: ${mustsWithoutCriteria.map((t) => t.task_id).join(', ')}`,
    );
  }
  if (hasCycle(plan)) reasons.push('task dependency graph contains a cycle');
  return { passed: reasons.length === 0, reasons };
}

function hasCycle(plan: TaskPlan): boolean {
  const graph = new Map<string, string[]>();
  for (const task of plan.tasks) graph.set(task.task_id, task.depends_on ?? []);
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of graph.keys()) color.set(id, WHITE);

  const visit = (id: string): boolean => {
    if (color.get(id) === GRAY) return true;
    if (color.get(id) === BLACK) return false;
    color.set(id, GRAY);
    for (const dep of graph.get(id) ?? []) {
      if (graph.has(dep) && visit(dep)) return true;
    }
    color.set(id, BLACK);
    return false;
  };
  for (const id of graph.keys()) {
    if (visit(id)) return true;
  }
  return false;
}
