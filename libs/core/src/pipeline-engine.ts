import * as path from 'node:path';
import { safeReadFile } from '../secure-io.js';
import { logger } from '../core.js';
import { pathResolver } from '../path-resolver.js';
import { derivePipelineStatus } from '../pipeline-contract.js';
import type { PipelineAdfStep, PipelineStepResult } from '../pipeline-contract.js';
import { resolveVars as defaultResolveVars } from './logic-utils.js';

const MAX_REF_DEPTH = 10;

export interface OnErrorConfig {
  strategy: 'skip' | 'abort' | 'fallback';
  fallback?: PipelineAdfStep[];
  ref?: string;
  bind?: Record<string, any>;
}

export interface RefParams {
  path: string;
  bind?: Record<string, any>;
  export_as?: string;
}

export interface AdfRunOptions {
  maxSteps?: number;
  timeoutMs?: number;
  quiet?: boolean;
  label?: string;
  resolveVars?: (value: any, ctx: Record<string, any>) => any;
}

export interface AdfStepHandlers<Ctx extends Record<string, any> = Record<string, any>> {
  capture: (op: string, params: any, ctx: Ctx, resolve: (value: any) => any) => Promise<Ctx>;
  transform: (op: string, params: any, ctx: Ctx, resolve: (value: any) => any) => Promise<Ctx>;
  apply: (op: string, params: any, ctx: Ctx, resolve: (value: any) => any) => Promise<void | Ctx>;
  control?: (
    op: string,
    params: any,
    ctx: Ctx,
    runSteps: (steps: PipelineAdfStep[], seedCtx?: Ctx) => Promise<AdfRunResult<Ctx>>,
    resolve: (value: any) => any
  ) => Promise<Ctx>;
}

export interface AdfRunResult<Ctx extends Record<string, any> = Record<string, any>> {
  status: 'succeeded' | 'failed';
  results: PipelineStepResult[];
  context: Ctx;
  total_steps: number;
}

export async function executeAdfSteps<Ctx extends Record<string, any> = Record<string, any>>(
  steps: PipelineAdfStep[],
  initialCtx: Ctx,
  options: AdfRunOptions,
  handlers: AdfStepHandlers<Ctx>,
  state: { stepCount: number; startTime: number } = { stepCount: 0, startTime: Date.now() }
): Promise<AdfRunResult<Ctx>> {
  const maxSteps = options.maxSteps ?? 1000;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const label = options.label || '[ADF]';
  let ctx = { ...initialCtx } as Ctx;
  const results: PipelineStepResult[] = [];

  const runNestedSteps = async (nestedSteps: PipelineAdfStep[], seedCtx: Ctx = ctx) =>
    executeAdfSteps(nestedSteps, seedCtx, options, handlers, state);

  for (const step of steps) {
    state.stepCount += 1;
    if (state.stepCount > maxSteps) {
      throw new Error(`[SAFETY_LIMIT] Exceeded maximum pipeline steps (${maxSteps})`);
    }
    if (Date.now() - state.startTime > timeoutMs) {
      throw new Error(`[SAFETY_LIMIT] Pipeline execution timed out (${timeoutMs}ms)`);
    }

    try {
      logger.info(`  ${label} [Step ${state.stepCount}] ${step.type}:${step.op}...`);
      // Default to the shared template resolver — an identity default made
      // `{{mission_id}}`-style params silently land as literal paths in every
      // caller that forgot to pass resolveVars (meeting-followup regression).
      const resolve = (value: any) =>
        options.resolveVars ? options.resolveVars(value, ctx) : defaultResolveVars(value, ctx);
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
        // Honor the adf-engine skip marker (skipAdfStep): a false branch is
        // recorded as skipped — never as success, and never merged into ctx.
        if (
          controlResult &&
          typeof controlResult === 'object' &&
          (controlResult as { skipped?: boolean }).skipped === true
        ) {
          ctx = ((controlResult as { context?: Ctx }).context ?? ctx) as Ctx;
          results.push({ op: step.op, status: 'skipped' });
          logger.info(
            `  ${label} Step skipped (${step.op}): ${(controlResult as { reason?: string }).reason || ''}`
          );
          continue;
        }
        ctx = controlResult;
      } else if (step.type === 'capture') {
        ctx = await handlers.capture(step.op, step.params, ctx, resolve);
      } else if (step.type === 'transform') {
        ctx = await handlers.transform(step.op, step.params, ctx, resolve);
      } else if (step.type === 'apply') {
        const nextCtx = await handlers.apply(step.op, step.params, ctx, resolve);
        if (nextCtx) ctx = nextCtx;
      } else {
        throw new Error(`[UNKNOWN_TYPE] Unknown step type: ${step.type}`);
      }
      results.push({ op: step.op, status: 'success' });
    } catch (error: any) {
      logger.error(`  [ADF] Step failed (${step.op}): ${error?.message || String(error)}`);
      results.push({ op: step.op, status: 'failed', error: error?.message || String(error) });
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
 * Loads a sub-pipeline JSON from disk, merges bind params into context,
 * and returns the steps + merged context.
 * Enforces circular-ref protection via _refDepth tracking.
 */
export async function resolveRef(
  refPath: string,
  bind: Record<string, any>,
  parentCtx: any,
  resolveVarsFn: (val: any) => any
): Promise<{ steps: any[]; mergedCtx: any }> {
  const currentDepth = (parentCtx._refDepth || 0) + 1;
  if (currentDepth > MAX_REF_DEPTH) {
    throw new Error(
      `[PIPELINE] Circular ref or depth exceeded: depth=${currentDepth}, path=${refPath}`
    );
  }

  const resolvedPath = pathResolver.rootResolve(refPath);
  logger.info(
    `[PIPELINE] resolveRef: loading sub-pipeline from ${resolvedPath} (depth=${currentDepth})`
  );

  const raw = safeReadFile(resolvedPath, { encoding: 'utf8' }) as string;
  const parsed = JSON.parse(raw);

  const subSteps: any[] = parsed.steps || [];
  const subContext: Record<string, any> = parsed.context || {};

  // Merge bind values (resolved via parent context) into sub-context
  const resolvedBind: Record<string, any> = {};
  for (const [k, v] of Object.entries(bind)) {
    resolvedBind[k] = resolveVarsFn(v);
  }

  const mergedCtx: any = {
    ...subContext,
    ...resolvedBind,
    _refDepth: currentDepth,
  };

  return { steps: subSteps, mergedCtx };
}

/**
 * Handles on_error configuration for a failed pipeline step.
 * Returns whether recovery succeeded and the updated context.
 */
export async function handleStepError(
  error: Error,
  step: any,
  onError: OnErrorConfig,
  ctx: any,
  executeSubPipeline: (steps: any[], ctx: any) => Promise<any>,
  resolveVarsFn: (val: any) => any
): Promise<{ recovered: boolean; ctx: any }> {
  const errorInfo = { message: error.message, step_id: step.id, step_op: step.op };

  switch (onError.strategy) {
    case 'skip':
      logger.warn(`[PIPELINE] on_error:skip — skipping failed step ${step.id || step.op}`);
      return { recovered: true, ctx: { ...ctx, _error: errorInfo } };

    case 'abort':
      logger.error(`[PIPELINE] on_error:abort — re-throwing error from step ${step.id || step.op}`);
      throw error;

    case 'fallback': {
      logger.warn(
        `[PIPELINE] on_error:fallback — executing fallback for step ${step.id || step.op}`
      );
      let fallbackSteps: any[];
      if (onError.fallback) {
        fallbackSteps = onError.fallback;
      } else if (onError.ref) {
        const refBind = onError.bind || {};
        const refResult = await resolveRef(resolveVarsFn(onError.ref), refBind, ctx, resolveVarsFn);
        fallbackSteps = refResult.steps;
        ctx = { ...ctx, ...refResult.mergedCtx };
      } else {
        logger.error(`[PIPELINE] on_error:fallback — no fallback steps or ref provided`);
        throw error;
      }

      const errCtx = { ...ctx, _error: errorInfo };
      const resultCtx = await executeSubPipeline(fallbackSteps, errCtx);
      return { recovered: true, ctx: resultCtx };
    }

    default:
      logger.error(`[PIPELINE] Unknown on_error strategy: ${onError.strategy}`);
      throw error;
  }
}
