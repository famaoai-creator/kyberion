import { logger } from './core.js';
import { derivePipelineStatus, type PipelineStepResult } from './pipeline-contract.js';
import { resolveVars } from './src/logic-utils.js';

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
}

export interface AdfSkippedStep {
  skipped: true;
  reason: string;
  context: AdfEngineContext;
}

export interface AdfStepHandlers<Ctx extends AdfEngineContext = AdfEngineContext> {
  capture: (op: string, params: any, ctx: Ctx, resolve: (value: any) => any) => Promise<Ctx>;
  transform: (op: string, params: any, ctx: Ctx, resolve: (value: any) => any) => Promise<Ctx>;
  apply: (op: string, params: any, ctx: Ctx, resolve: (value: any) => any) => Promise<void | Ctx>;
  control?: (
    op: string,
    params: any,
    ctx: Ctx,
    runSteps: (steps: AdfStep[], seedCtx?: Ctx) => Promise<Ctx>,
    resolve: (value: any) => any
  ) => Promise<Ctx | AdfSkippedStep>;
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
}

export async function executeAdfSteps<Ctx extends AdfEngineContext = AdfEngineContext>(
  steps: AdfStep[],
  initialCtx: Ctx,
  options: AdfRunOptions,
  handlers: AdfStepHandlers<Ctx>
): Promise<AdfRunResult<Ctx>> {
  return await executeAdfStepsInternal(steps, initialCtx, options, handlers, {
    stepCount: 0,
    startTime: Date.now(),
  });
}

async function executeAdfStepsInternal<Ctx extends AdfEngineContext = AdfEngineContext>(
  steps: AdfStep[],
  initialCtx: Ctx,
  options: AdfRunOptions,
  handlers: AdfStepHandlers<Ctx>,
  state: AdfEngineState
): Promise<AdfRunResult<Ctx>> {
  const maxSteps = options.maxSteps ?? 1000;
  const timeoutMs = options.timeoutMs ?? 60_000;
  let ctx = { ...initialCtx } as Ctx;
  const results: PipelineStepResult[] = [];

  const resolve = (value: any) => resolveVars(value, ctx);
  const runNestedSteps = async (nestedSteps: AdfStep[], seedCtx: Ctx = ctx): Promise<Ctx> => {
    const nested = await executeAdfStepsInternal(nestedSteps, seedCtx, options, handlers, state);
    return nested.context;
  };

  for (const step of steps) {
    state.stepCount += 1;
    if (state.stepCount > maxSteps) {
      throw new Error(`[SAFETY_LIMIT] Exceeded maximum pipeline steps (${maxSteps})`);
    }
    if (Date.now() - state.startTime > timeoutMs) {
      throw new Error(`[SAFETY_LIMIT] Pipeline execution timed out (${timeoutMs}ms)`);
    }

    try {
      logger.info(`  [ADF] [Step ${state.stepCount}] ${step.type}:${step.op}...`);
      if (step.type === 'control') {
        if (!handlers.control) {
          throw new Error(`[UNKNOWN_TYPE] Unknown control step op: ${step.op}`);
        }
        const controlResult = await handlers.control(
          step.op,
          step.params,
          ctx,
          runNestedSteps,
          resolve
        );
        if (isSkippedStep(controlResult)) {
          ctx = controlResult.context as Ctx;
          results.push({ op: step.op, status: 'skipped' });
          logger.info(`  [ADF] Step skipped (${step.op}): ${controlResult.reason}`);
          continue;
        }
        ctx = controlResult;
      } else if (step.type === 'capture') {
        ctx = await handlers.capture(step.op, step.params, ctx, resolve);
      } else if (step.type === 'transform') {
        ctx = await handlers.transform(step.op, step.params, ctx, resolve);
      } else if (step.type === 'apply') {
        const nextCtx = await handlers.apply(step.op, step.params, ctx, resolve);
        if (nextCtx !== undefined) {
          ctx = nextCtx as Ctx;
        }
      } else {
        throw new Error(`[UNKNOWN_TYPE] Unknown step type: ${step.type}`);
      }
      results.push({ op: step.op, status: 'success' });
    } catch (err: any) {
      logger.error(`  [ADF] Step failed (${step.op}): ${err.message}`);
      results.push({ op: step.op, status: 'failed', error: err.message });
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

export function skipAdfStep<Ctx extends AdfEngineContext>(
  context: Ctx,
  reason: string
): AdfSkippedStep {
  return { skipped: true, reason, context };
}

function isSkippedStep(value: unknown): value is AdfSkippedStep {
  return Boolean(value) && typeof value === 'object' && (value as AdfSkippedStep).skipped === true;
}
