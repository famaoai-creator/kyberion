import { isRecord } from '../foundation/primitives.js';

/**
 * Whether a pipeline's steps need `installReasoningBackends()` before dispatch.
 *
 * Unknown ops require the bootstrap. Structural ops (if / foreach / nested
 * `core:run_pipeline`) require it only when a nested step does. A nested
 * pipeline file is classified when that file is executed, so `core:run_pipeline`
 * itself does not force the parent process to probe CLIs.
 */
export interface PipelineBootstrapStep {
  op: string;
  params?: Record<string, unknown>;
  on_error?: { fallback?: readonly PipelineBootstrapStep[] };
}

export interface PipelineBootstrapNeeds {
  required: boolean;
  reasons: readonly string[];
}

const REASONING_DOMAINS: ReadonlySet<string> = new Set(['reasoning', 'wisdom', 'voice', 'secret']);

/** Control ops whose own body does not call a reasoning backend. Nested steps are still walked. */
const STRUCTURAL_OPS: ReadonlySet<string> = new Set([
  'core:if',
  'core:switch',
  'core:foreach',
  'core:accumulate',
  'core:while',
  'core:loop_until',
  'core:retry_until_quality',
  'core:parallel_calls',
  'core:run_pipeline',
]);

/**
 * Ops verified not to call reasoning, speech, secret resolution, or embeddings.
 * Anything else stays on the full bootstrap.
 */
const INERT_OPS: ReadonlySet<string> = new Set(['working-memory:run-gc', 'system:write_artifact']);

const NESTED_STEP_KEYS = ['do', 'then', 'else', 'default', 'pipeline', 'steps', 'calls'] as const;

const MAX_REASONS = 8;
const MAX_DEPTH = 32;

function asSteps(value: unknown): PipelineBootstrapStep[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is PipelineBootstrapStep => isRecord(entry) && typeof entry.op === 'string'
  );
}

function stepSelfReason(op: string, params: Record<string, unknown> | undefined): string | null {
  const domain = op.split(':')[0] ?? '';
  if (REASONING_DOMAINS.has(domain)) return op;
  if (op === 'core:include') return op;
  if (op === 'core:judge_route') {
    if (params?.fixture === true && isRecord(params.verdict)) return null;
    return op;
  }
  if (op === 'core:team_lead') {
    if (Array.isArray(params?.tasks) || Array.isArray(params?.fixture_tasks)) return null;
    return op;
  }
  if (op === 'core:parallel_foreach') {
    if (!isRecord(params?.items_from)) return null;
    const selection = params.items_from.selection;
    if (!isRecord(selection)) return null;
    if (Array.isArray(selection.fixture)) return null;
    if (isRecord(selection.judge)) return op;
    return null;
  }
  if (STRUCTURAL_OPS.has(op) || INERT_OPS.has(op)) return null;
  return op;
}

function nestedStepLists(step: PipelineBootstrapStep): unknown[] {
  const lists: unknown[] = [];
  const params = step.params;
  if (params) {
    for (const key of NESTED_STEP_KEYS) lists.push(params[key]);
    if (Array.isArray(params.cases)) {
      for (const entry of params.cases) {
        if (!isRecord(entry)) continue;
        lists.push(entry.steps, entry.then, entry.pipeline, entry.do);
      }
    }
  }
  if (step.on_error?.fallback) lists.push(step.on_error.fallback);
  return lists;
}

export function pipelineBootstrapNeeds(
  steps: readonly PipelineBootstrapStep[],
  normalizeOp: (op: string) => string = (op) => op
): PipelineBootstrapNeeds {
  const reasons: string[] = [];
  const seen = new Set<string>();

  const visit = (body: readonly PipelineBootstrapStep[], depth: number): void => {
    if (depth > MAX_DEPTH) {
      if (!seen.has('max-depth')) {
        seen.add('max-depth');
        reasons.push('nested steps exceeded depth limit');
      }
      return;
    }
    for (const step of body) {
      const op = normalizeOp(step.op);
      const reason = stepSelfReason(op, step.params);
      if (reason && !seen.has(reason)) {
        seen.add(reason);
        if (reasons.length < MAX_REASONS) reasons.push(reason);
      }
      for (const list of nestedStepLists(step)) {
        visit(asSteps(list), depth + 1);
      }
    }
  };

  visit(steps, 0);
  return { required: reasons.length > 0, reasons };
}
