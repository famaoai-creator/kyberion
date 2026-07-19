import { logger } from './core.js';
import { derivePipelineStatus, type PipelineStepResult } from './pipeline-contract.js';
import { handleStepError } from './src/pipeline-engine.js';
import { resolveVars } from './src/logic-utils.js';
import {
  advanceToolCallRepeatGovernor,
  buildToolCallRepeatForceStopMessage,
  createToolCallRepeatGovernorState,
  type ToolCallRepeatDecision,
  type ToolCallRepeatGovernorState,
} from './tool-call-repeat-governor.js';

export type AdfStepType = 'capture' | 'transform' | 'apply' | 'control';

export interface AdfStep {
  type: AdfStepType;
  op: string;
  params: any;
}

export interface AdfEngineContext {
  [key: string]: any;
}

export interface AdfRunOptions {
  maxSteps?: number;
  timeoutMs?: number;
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
  afterStep?: (step: AdfStep, stepNumber: number, ctx: Ctx, outcome: AdfStepOutcome) => void | Ctx;
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
  return await executeAdfStepsInternal(
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
}

async function executeAdfStepsInternal<Ctx extends AdfEngineContext = AdfEngineContext>(
  steps: AdfStep[],
  initialCtx: Ctx,
  options: AdfRunOptions,
  handlers: AdfStepHandlers<Ctx>,
  state: AdfEngineState,
  hooks?: AdfStepHooks<Ctx>
): Promise<AdfRunResult<Ctx>> {
  const maxSteps = options.maxSteps ?? 1000;
  const timeoutMs = options.timeoutMs ?? 60_000;
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

  for (const step of steps) {
    state.stepCount += 1;
    if (state.stepCount > maxSteps) {
      throw new Error(`[SAFETY_LIMIT] Exceeded maximum pipeline steps (${maxSteps})`);
    }
    if (Date.now() - state.startTime > timeoutMs) {
      throw new Error(`[SAFETY_LIMIT] Pipeline execution timed out (${timeoutMs}ms)`);
    }

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
    }

    hooks?.beforeStep?.(step, state.stepCount, ctx);
    try {
      logger.info(`  ${label} [Step ${state.stepCount}] ${step.type}:${step.op}...`);
      if (step.type === 'control') {
        if (!handlers.control) {
          throw new Error(`[UNKNOWN_TYPE] Unknown control step op: ${step.op}`);
        }
        const loopOp = isLoopControlOp(step.op);
        if (loopOp) state.loopDepth += 1;
        let controlResult;
        try {
          controlResult = await handlers.control(step.op, step.params, ctx, runNestedSteps, resolve);
        } finally {
          if (loopOp) state.loopDepth -= 1;
        }
        if (isSkippedStep(controlResult)) {
          ctx = controlResult.context as Ctx;
          results.push({ op: step.op, status: 'skipped' });
          logger.info(`  ${label} Step skipped (${step.op}): ${controlResult.reason}`);
          ctx = (hooks?.afterStep?.(step, state.stepCount, ctx, { status: 'skipped' }) ||
            ctx) as Ctx;
          continue;
        }
        ctx = controlResult;
      } else if (step.type === 'capture') {
        ctx = await handlers.capture(step.op, step.params, ctx, resolve);
      } else if (step.type === 'transform') {
        ctx = await handlers.transform(step.op, step.params, ctx, resolve);
      } else if (step.type === 'apply') {
        const nextCtx = await handlers.apply(step.op, step.params, ctx, resolve);
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
      ctx = (hooks?.afterStep?.(step, state.stepCount, ctx, { status: 'success' }) || ctx) as Ctx;
    } catch (err: any) {
      // Native on_error support (skip / abort / fallback via handleStepError)
      // so every runner shares one recovery semantics instead of hand-rolled
      // copies. Fallback sub-pipelines run through the same engine, so their
      // failures propagate (AR-06) and their steps count against the budget.
      const onError = (step as any).on_error;
      if (onError) {
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
            ctx = (hooks?.afterStep?.(step, state.stepCount, ctx, {
              status: 'recovered',
              error: err.message,
            }) || ctx) as Ctx;
            continue;
          }
        } catch (_) {
          /* recovery itself failed — fall through to the failure path */
        }
      }
      logger.error(`  ${label} Step failed (${step.op}): ${err.message}`);
      results.push({ op: step.op, status: 'failed', error: err.message });
      ctx = (hooks?.afterStep?.(step, state.stepCount, ctx, {
        status: 'failed',
        error: err.message,
      }) || ctx) as Ctx;
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
