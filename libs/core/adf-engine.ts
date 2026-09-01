import { logger } from './core.js';
import { derivePipelineStatus, type PipelineStepResult } from './pipeline-contract.js';
import { handleStepError } from './src/pipeline-engine.js';
import { evaluateCondition, resolveVars } from './src/logic-utils.js';
import {
  deriveExecutionGraph,
  executeGraph,
  type GraphExecutionOutcome,
  type GraphNode,
} from './graph-scheduler.js';
import {
  advanceToolCallRepeatGovernor,
  buildToolCallRepeatForceStopMessage,
  createToolCallRepeatGovernorState,
  type ToolCallRepeatDecision,
  type ToolCallRepeatGovernorState,
} from './tool-call-repeat-governor.js';
import { resolveOpAccessClaims, type OpInputDomain } from './op-input-contracts.js';
import type { ResourceClaim } from './tool-call-scheduler.js';
import { runOpPreflight } from './op-preflight.js';
import { ensureDefaultOpPreflight } from './op-preflight-defaults.js';
import {
  requireSandboxEnforcement,
  withSandboxPolicy,
  type SandboxPolicy,
} from './sandbox-policy.js';
import {
  assertExecutionBounds,
  DEFAULT_MAX_PIPELINE_STEPS,
  DEFAULT_PIPELINE_TIMEOUT_MS,
} from './execution-bounds.js';

export type AdfStepType = 'capture' | 'transform' | 'apply' | 'control';

export interface AdfStep {
  type: AdfStepType;
  op: string;
  params: any;
  /** Optional budget projected from the governed actuator operation definition. */
  timeout_ms?: number;
  /** Optional step-level approval metadata projected by the pipeline contract. */
  budget?: { approval_required?: boolean; approval_ref?: string };
  /** Explicit shared-resource claims used by the graph frontier scheduler. */
  resource_claims?: Array<string | ResourceClaim>;
}

function resolveAdfResourceClaims(
  step: AdfStep,
  context: AdfEngineContext,
  resolve: (value: any, ctx: Record<string, any>) => any
): Array<string | ResourceClaim> {
  if (step.resource_claims !== undefined) return [...new Set(step.resource_claims)];
  const normalizedOp = String(step.op || '').replace(/^([a-z]+):/u, '$1:');
  const [domain, action] = normalizedOp.split(':');
  // Legacy/custom actuator ops have no typed access contract at this layer;
  // keep their historical graph behavior until they opt into explicit claims.
  if (!domain || !action || domain === 'core') return [];
  if (domain !== 'browser' && domain !== 'file' && domain !== 'system') return [];
  try {
    const params = (resolve(step.params || {}, context) || {}) as Record<string, unknown>;
    return resolveOpAccessClaims(domain as OpInputDomain, action, params);
  } catch {
    return ['resource:all'];
  }
}

export interface AdfEngineContext {
  [key: string]: any;
}

export interface AdfRunOptions {
  maxSteps?: number;
  timeoutMs?: number;
  /** Trusted caller-side presence signal for approval-gated steps. */
  hasHuman?: boolean;
  /** Trusted caller-side resolver for a bound approval decision. */
  approvalGranted?: (step: AdfStep, context: AdfEngineContext) => boolean | Promise<boolean>;
  /** Log prefix for step progress lines (default '[ADF]'). */
  label?: string;
  /** Override the template resolver (default: shared resolveVars). */
  resolveVars?: (value: any, ctx: Record<string, any>) => any;
  /**
   * Called when the repeat governor force-stops the run (KC-01). Default
   * records a governance action on the kill switch; tests inject a spy.
   */
  onRepeatForceStop?: (step: AdfStep, decision: ToolCallRepeatDecision) => void | Promise<void>;
  /**
   * Pre-execution gate for non-control steps (KC-04 pre_tool_use hooks). A
   * blocked verdict aborts the whole run — routing a security block through
   * per-step on_error recovery would let a fallback bypass it.
   */
  stepGate?: (
    step: AdfStep,
    stepNumber: number,
    ctx: AdfEngineContext
  ) => Promise<{ blocked: boolean; reasons?: string[] } | void>;
  /** Maximum number of independent graph nodes to execute concurrently. */
  maxConcurrency?: number;
  /** Resolved sandbox policy applied to every handler and nested ADF step. */
  sandboxPolicy?: SandboxPolicy;
  /** Completed node ids restored from a durable pipeline run journal. */
  resumeCompletedNodeIds?: ReadonlySet<string>;
  /** Optional observer for durable DAG/run-graph artifacts. */
  onGraphNodeSettled?: (
    node: GraphNode<AdfStep>,
    outcome: GraphExecutionOutcome<AdfEngineContext>,
    durationMs: number
  ) => void;
}

export interface AdfSkippedStep {
  skipped: true;
  reason: string;
  context: AdfEngineContext;
}

export interface AdfStepHandlers<Ctx extends AdfEngineContext = AdfEngineContext> {
  capture: (op: string, params: any, ctx: Ctx, resolve: (value: any) => any) => Promise<Ctx>;
  transform: (op: string, params: any, ctx: Ctx, resolve: (value: any) => any) => Promise<Ctx>;
  apply: (
    op: string,
    params: any,
    ctx: Ctx,
    resolve: (value: any) => any
  ) => Promise<void | Ctx | AdfSkippedStep>;
  control?: (
    op: string,
    params: any,
    ctx: Ctx,
    runSteps: (steps: AdfStep[], seedCtx?: Ctx) => Promise<AdfRunResult<Ctx>>,
    resolve: (value: any) => any
  ) => Promise<Ctx | AdfSkippedStep>;
}

export interface AdfStepOutcome {
  status: 'success' | 'failed' | 'skipped' | 'recovered';
  error?: string;
}

/**
 * Observation hooks for runners that need per-step instrumentation (trace
 * spans, artifacts, action-trail events). Hooks fire for nested steps too
 * (control-op sub-pipelines, on_error fallbacks); beforeStep/afterStep pair
 * LIFO, so a span stack works.
 */
export interface AdfStepHooks<Ctx extends AdfEngineContext = AdfEngineContext> {
  beforeStep?: (step: AdfStep, stepNumber: number, ctx: Ctx) => void;
  afterStep?: (
    step: AdfStep,
    stepNumber: number,
    ctx: Ctx,
    outcome: AdfStepOutcome
  ) => void | Ctx | Promise<void | Ctx>;
}

export interface AdfRunResult<Ctx extends AdfEngineContext = AdfEngineContext> {
  status: 'succeeded' | 'failed';
  results: PipelineStepResult[];
  context: Ctx;
  total_steps: number;
}

interface AdfEngineState {
  stepCount: number;
  startTime: number;
  repeatGovernor: ToolCallRepeatGovernorState;
  /**
   * Depth of enclosing explicit loop control ops. Inside a declared loop
   * (while / loop_until / retry_until_quality / foreach / parallel_foreach /
   * accumulate) identical repetition is intentional — soak runs and polling
   * loops are governed by their own iteration caps — so the repeat governor
   * warns but never force-stops there. Force stop applies only to unplanned
   * repetition (linear step streams, repair re-execution).
   */
  loopDepth: number;
}

const LOOP_CONTROL_OPS = new Set([
  'while',
  'loop_until',
  'retry_until_quality',
  'foreach',
  'parallel_foreach',
  'accumulate',
]);

function isLoopControlOp(op: string): boolean {
  return LOOP_CONTROL_OPS.has(op.replace(/^core:/u, ''));
}

export async function executeAdfSteps<Ctx extends AdfEngineContext = AdfEngineContext>(
  steps: AdfStep[],
  initialCtx: Ctx,
  options: AdfRunOptions,
  handlers: AdfStepHandlers<Ctx>,
  hooks?: AdfStepHooks<Ctx>
): Promise<AdfRunResult<Ctx>> {
  if (options.sandboxPolicy) requireSandboxEnforcement(options.sandboxPolicy);
  const run = (): Promise<AdfRunResult<Ctx>> =>
    executeAdfStepsInternal(
      steps,
      initialCtx,
      options,
      handlers,
      {
        stepCount: 0,
        startTime: Date.now(),
        repeatGovernor: createToolCallRepeatGovernorState(),
        loopDepth: 0,
      },
      hooks
    );
  return options.sandboxPolicy ? withSandboxPolicy(options.sandboxPolicy, run) : run();
}

async function executeAdfStepsInternal<Ctx extends AdfEngineContext = AdfEngineContext>(
  steps: AdfStep[],
  initialCtx: Ctx,
  options: AdfRunOptions,
  handlers: AdfStepHandlers<Ctx>,
  state: AdfEngineState,
  hooks?: AdfStepHooks<Ctx>
): Promise<AdfRunResult<Ctx>> {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_PIPELINE_STEPS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PIPELINE_TIMEOUT_MS;
  const label = options.label || '[ADF]';
  let ctx = { ...initialCtx } as Ctx;
  const results: PipelineStepResult[] = [];

  const resolve = (value: any) =>
    options.resolveVars ? options.resolveVars(value, ctx) : resolveVars(value, ctx);
  const runNestedSteps = async (
    nestedSteps: AdfStep[],
    seedCtx: Ctx = ctx
  ): Promise<AdfRunResult<Ctx>> =>
    executeAdfStepsInternal(nestedSteps, seedCtx, options, handlers, state, hooks);

  // GE-01/02/03: graph-declared streams use the shared completion-driven
  // frontier. A pipeline with no graph metadata stays on the legacy loop,
  // which is intentionally equivalent to a one-wide linear graph.
  const graphDeclared = steps.some(
    (step) =>
      Array.isArray((step as any).depends_on) ||
      (step as any).consumes !== undefined ||
      (step as any).when !== undefined
  );
  if (steps.length > 1 && (graphDeclared || (options.maxConcurrency ?? 1) > 1)) {
    const built = deriveExecutionGraph(steps as unknown as AdfStep[], Object.keys(ctx));
    const hardGraphErrors = built.errors.filter((error) => error.code !== 'missing-channel');
    if (hardGraphErrors.length > 0) {
      throw new Error(
        `[GRAPH_PREFLIGHT] ${hardGraphErrors.map((error) => error.message).join('; ')}`
      );
    }
    const graphResult = await executeGraph(
      built.graph,
      async (node: GraphNode<AdfStep>, nodeCtx: Ctx): Promise<GraphExecutionOutcome<Ctx>> => {
        // The single-node invocation must not recursively interpret its own
        // graph metadata. produces is retained because dispatch uses it as the
        // output-channel export key.
        const {
          depends_on: _dependsOn,
          consumes: _consumes,
          when: _when,
          merge: _merge,
          ...plain
        } = node.value as AdfStep & Record<string, unknown>;
        const nested = await executeAdfStepsInternal(
          [plain as AdfStep],
          nodeCtx,
          options,
          handlers,
          state,
          hooks
        );
        const failed = nested.results.find((result) => result.status === 'failed');
        return {
          status: nested.status === 'failed' ? 'failed' : 'success',
          context: nested.context,
          ...(failed?.error ? { error: failed.error } : {}),
        };
      },
      {
        maxConcurrency: options.maxConcurrency ?? 1,
        initialContext: ctx,
        precompletedNodeIds: options.resumeCompletedNodeIds,
        evaluateWhen: (condition, graphCtx) => evaluateCondition(condition, graphCtx),
        resourceClaims: (node, graphCtx) =>
          resolveAdfResourceClaims(
            node.value as AdfStep,
            graphCtx,
            options.resolveVars || ((value, context) => resolveVars(value, context))
          ),
        onNodeSettled: (node, outcome, durationMs) =>
          options.onGraphNodeSettled?.(
            node as GraphNode<AdfStep>,
            outcome as GraphExecutionOutcome<AdfEngineContext>,
            durationMs
          ),
      }
    );
    const graphResults: PipelineStepResult[] = [];
    for (const node of built.graph.nodes) {
      const outcome = graphResult.outcomes[node.id];
      if (!outcome) continue;
      if (outcome.status === 'skipped') {
        graphResults.push({
          op: node.value.op,
          status: 'skipped',
          ...(outcome.error ? { error: outcome.error } : {}),
        });
      } else if (outcome.context) {
        // The node execution's nested result is intentionally represented as
        // one top-level result here; nested control steps have already emitted
        // their own hook/trace events.
        graphResults.push({
          op: node.value.op,
          status: outcome.status === 'failed' ? 'failed' : 'success',
          ...(outcome.error ? { error: outcome.error } : {}),
        });
      }
    }
    return {
      status: derivePipelineStatus(graphResults),
      results: graphResults,
      context: graphResult.context,
      total_steps: state.stepCount,
    };
  }

  for (const step of steps) {
    state.stepCount += 1;
    assertExecutionBounds(state, { maxSteps, timeoutMs });

    let executionParams = step.params;
    if (step.type !== 'control') {
      // Signature over *resolved* params: template steps inside foreach resolve
      // to different values per item and must not count as repeats.
      let signatureArgs: unknown = step.params;
      try {
        signatureArgs = resolve(step.params);
      } catch {
        /* unresolvable templates — compare raw params instead */
      }
      const decision = advanceToolCallRepeatGovernor(
        state.repeatGovernor,
        `${step.type}:${step.op}`,
        signatureArgs
      );
      state.repeatGovernor = decision.state;
      if (decision.should_force_stop && state.loopDepth === 0) {
        const message = buildToolCallRepeatForceStopMessage(
          `${step.type}:${step.op}`,
          decision.streak
        );
        try {
          await (options.onRepeatForceStop
            ? options.onRepeatForceStop(step, decision)
            : recordRepeatForceStopGovernanceAction(label, step, decision));
        } catch {
          /* observability must not mask the stop itself */
        }
        throw new Error(message);
      }
      if (decision.reminder && decision.escalation !== 'force_stop') {
        logger.warn(`  ${label} [repeat-governor] ${decision.reminder}`);
      }
      if (options.stepGate) {
        const verdict = (await options.stepGate(step, state.stepCount, ctx)) || undefined;
        if (verdict?.blocked) {
          throw new Error(
            `[SAFETY_LIMIT][HOOK_BLOCKED] ${step.type}:${step.op} blocked by lifecycle hook: ${
              verdict.reasons?.join('; ') || 'no reason given'
            }`
          );
        }
      }
      // DH-01: all actuator pipelines using this shared engine enter the same
      // serial governance waterfall. A repaired input is the only input that
      // reaches the handler; block/ask decisions are terminal and cannot be
      // recovered through a step's on_error fallback.
      ensureDefaultOpPreflight();
      const resolvedParams = (resolve(step.params) || {}) as Record<string, unknown>;
      const preflight = await runOpPreflight({
        op: step.op,
        params: resolvedParams,
        context: ctx,
        source: 'actuator',
        requiresApproval:
          step.budget?.approval_required === true ||
          resolvedParams._approval_required === true ||
          ctx._approval_required === true,
        approvalGranted: options.approvalGranted ? await options.approvalGranted(step, ctx) : false,
        ...(options.hasHuman !== undefined ? { hasHuman: options.hasHuman } : {}),
      });
      if (preflight.decision !== 'allow') {
        const error = new Error(
          `[OP_PREFLIGHT_${preflight.decision.toUpperCase()}] ${preflight.reason || `Operation ${step.op} was not admitted.`}`
        );
        (error as Error & { adfControlFlow?: string }).adfControlFlow = 'preflight';
        throw error;
      }
      executionParams = preflight.input;
    }

    hooks?.beforeStep?.(step, state.stepCount, ctx);
    try {
      logger.info(`  ${label} [Step ${state.stepCount}] ${step.type}:${step.op}...`);
      let terminalRequested = false;
      if (step.type === 'control') {
        if (!handlers.control) {
          throw new Error(`[UNKNOWN_TYPE] Unknown control step op: ${step.op}`);
        }
        const loopOp = isLoopControlOp(step.op);
        if (loopOp) state.loopDepth += 1;
        let controlResult;
        try {
          controlResult = await handlers.control(
            step.op,
            executionParams,
            ctx,
            runNestedSteps,
            resolve
          );
        } finally {
          if (loopOp) state.loopDepth -= 1;
        }
        if (isSkippedStep(controlResult)) {
          ctx = controlResult.context as Ctx;
          results.push({ op: step.op, status: 'skipped' });
          logger.info(`  ${label} Step skipped (${step.op}): ${controlResult.reason}`);
          ctx = ((await hooks?.afterStep?.(step, state.stepCount, ctx, { status: 'skipped' })) ||
            ctx) as Ctx;
          continue;
        }
        ctx = controlResult;
        terminalRequested = ctx.__adf_terminal === true;
      } else if (step.type === 'capture') {
        ctx = await handlers.capture(step.op, executionParams, ctx, resolve);
      } else if (step.type === 'transform') {
        ctx = await handlers.transform(step.op, executionParams, ctx, resolve);
      } else if (step.type === 'apply') {
        const nextCtx = await handlers.apply(step.op, executionParams, ctx, resolve);
        if (isSkippedStep(nextCtx)) {
          ctx = nextCtx.context as Ctx;
          results.push({ op: step.op, status: 'skipped' });
          logger.info(`  ${label} Step skipped (${step.op}): ${nextCtx.reason}`);
          ctx = (hooks?.afterStep?.(step, state.stepCount, ctx, { status: 'skipped' }) ||
            ctx) as Ctx;
          continue;
        }
        if (nextCtx !== undefined) {
          ctx = nextCtx as Ctx;
        }
      } else {
        throw new Error(`[UNKNOWN_TYPE] Unknown step type: ${step.type}`);
      }
      results.push({ op: step.op, status: 'success' });
      ctx = ((await hooks?.afterStep?.(step, state.stepCount, ctx, { status: 'success' })) ||
        ctx) as Ctx;
      if (terminalRequested) break;
    } catch (err: any) {
      if (err?.adfControlFlow === 'suspend') throw err;
      // Native on_error support (skip / abort / fallback via handleStepError)
      // so every runner shares one recovery semantics instead of hand-rolled
      // copies. Fallback sub-pipelines run through the same engine, so their
      // failures propagate (AR-06) and their steps count against the budget.
      const onError = (step as any).on_error;
      if (onError && err?.adfControlFlow !== 'preflight') {
        try {
          const recovery = await handleStepError(
            err,
            step,
            onError,
            ctx,
            async (fallbackSteps: any[], errCtx: any) => {
              const res = await runNestedSteps(fallbackSteps as AdfStep[], errCtx as Ctx);
              if (res.status === 'failed') {
                throw new Error(
                  res.results.find((entry) => entry.status === 'failed')?.error ||
                    'on_error fallback pipeline failed'
                );
              }
              return res.context;
            },
            resolve
          );
          if (recovery.recovered) {
            ctx = recovery.ctx as Ctx;
            results.push({ op: step.op, status: 'recovered' });
            ctx = ((await hooks?.afterStep?.(step, state.stepCount, ctx, {
              status: 'recovered',
              error: err.message,
            })) || ctx) as Ctx;
            continue;
          }
        } catch (_) {
          /* recovery itself failed — fall through to the failure path */
        }
      }
      logger.error(`  ${label} Step failed (${step.op}): ${err.message}`);
      results.push({ op: step.op, status: 'failed', error: err.message });
      ctx = ((await hooks?.afterStep?.(step, state.stepCount, ctx, {
        status: 'failed',
        error: err.message,
      })) || ctx) as Ctx;
      break;
    }
  }

  return {
    status: derivePipelineStatus(results),
    results,
    context: ctx,
    total_steps: state.stepCount,
  };
}

/**
 * Dynamic import: kill-switch pulls in the agent-runtime plane, and this
 * engine must stay statically dependency-light (it is imported by every
 * runner, including boundary-tested ones).
 */
async function recordRepeatForceStopGovernanceAction(
  label: string,
  step: AdfStep,
  decision: ToolCallRepeatDecision
): Promise<void> {
  const { recordGovernanceAction } = await import('./kill-switch.js');
  recordGovernanceAction(
    'adf-engine',
    'tool_call_repeat_force_stop',
    `${label} ${step.type}:${step.op} streak=${decision.streak}`,
    true
  );
}

export function skipAdfStep<Ctx extends AdfEngineContext>(
  context: Ctx,
  reason: string
): AdfSkippedStep {
  return { skipped: true, reason, context };
}

function isSkippedStep(value: unknown): value is AdfSkippedStep {
  return Boolean(value) && typeof value === 'object' && (value as AdfSkippedStep).skipped === true;
}
