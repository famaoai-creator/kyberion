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
  /** Display list, capped at MAX_REASONS — never decide a model need from it. */
  reasons: readonly string[];
  /**
   * Whether any step (uncapped walk) calls a model: a model-domain op, an
   * explicit {@link MODEL_OPS} entry, or a conservative `core:*` judge.
   */
  model: boolean;
}

const REASONING_DOMAINS: ReadonlySet<string> = new Set(['reasoning', 'wisdom', 'voice', 'secret']);

/** Domains whose ops call a model provider and so consume a tenant reasoning credential. */
const MODEL_DOMAINS: ReadonlySet<string> = new Set(['reasoning', 'wisdom', 'voice']);

/**
 * Model-calling ops outside the model domains (each calls getReasoningBackend
 * in its actuator handler). A pipeline using one needs a reasoning credential
 * even though its domain is not `reasoning` / `wisdom` / `voice`.
 */
export const MODEL_OPS: ReadonlySet<string> = new Set([
  'browser:llm_decide',
  'android:llm_decide',
  'network:llm_decide',
  'system:llm_decide',
  'terminal:llm_decide',
  'code:impact_analysis',
  'ingest:meeting_digest',
  'meeting:conduct_1on_1',
  'meeting:hearing_session',
  'meeting:tutor_session',
  'meeting:extract_action_items',
  'meeting:generate_facilitation_script',
  'meeting:generate_reminder_message',
  'meeting:run_action_item_reminder_sweep',
  'meeting:execute_self_action_items',
  'meeting:track_pending_action_items',
  'modeling:extract_requirements',
  'modeling:extract_design_spec',
  'modeling:extract_test_plan',
  'orchestrator:decompose_into_tasks',
]);

/** Browser control ops whose bodies hold bare (domain-less) browser ops. */
const BROWSER_BODY_OPS: ReadonlySet<string> = new Set(['browser:if', 'browser:while']);

const DEPTH_REASON = 'nested steps exceeded depth limit';

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
 * Ops that do not need provider installation. Baseline owns its readiness probes
 * and must report missing credentials without first constructing a provider.
 * Anything else stays on the full bootstrap.
 */
const INERT_OPS: ReadonlySet<string> = new Set([
  'working-memory:run-gc',
  // Governed local retention cleanup never needs a model or provider secret.
  'core:run_janitor',
  // Deterministic organization cadence + ops probe: aggregate governed state
  // only, never call a reasoning backend. Inert so scoped (tenant-bound)
  // cadence runs proceed without demanding a WorkItem credential binding.
  'core:run_ops_health_probe',
  'core:organization_operation_tick',
  'core:organization_standup',
  'core:organization_retro',
  'core:organization_digest',
  'core:organization_kr_measure',
  'system:write_artifact',
  'system:log',
  'system:baseline_check',
  'system:probe',
  'system:probe_active_profile',
  'system:list_missions',
  'core:transform',
]);

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
  // Decided over every reason, never over the capped display list.
  let model = false;
  let required = false;

  const visit = (
    body: readonly PipelineBootstrapStep[],
    depth: number,
    browserBody: boolean
  ): void => {
    if (depth > MAX_DEPTH) {
      required = true;
      model = true;
      if (!seen.has('max-depth')) {
        seen.add('max-depth');
        reasons.push(DEPTH_REASON);
      }
      return;
    }
    for (const step of body) {
      const op =
        browserBody && !step.op.includes(':') ? `browser:${step.op}` : normalizeOp(step.op);
      const reason = stepSelfReason(op, step.params);
      if (reason) {
        required = true;
        if (bootstrapReasonNeedsModel(reason)) model = true;
        if (!seen.has(reason)) {
          seen.add(reason);
          if (reasons.length < MAX_REASONS) reasons.push(reason);
        }
      }
      const nestedBrowser = browserBody || BROWSER_BODY_OPS.has(op);
      for (const list of nestedStepLists(step)) {
        visit(asSteps(list), depth + 1, nestedBrowser);
      }
    }
  };

  visit(steps, 0, false);
  return { required, reasons, model };
}

/**
 * Whether one bootstrap reason consumes a tenant reasoning credential, so a
 * missing task binding must stop the run instead of degrading to the stub chain.
 * `secret:*` reads the OS keychain under its own guard and never a model;
 * `core:*` reasons are judges or unclassified core ops and stay conservative.
 */
export function bootstrapReasonNeedsModel(reason: string): boolean {
  if (reason === DEPTH_REASON) return true;
  if (MODEL_OPS.has(reason)) return true;
  const domain = reason.split(':')[0] ?? '';
  return MODEL_DOMAINS.has(domain) || domain === 'core';
}
