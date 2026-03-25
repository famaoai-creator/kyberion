import * as path from 'node:path';
import { safeReadFile } from '../secure-io.js';
import { logger } from '../core.js';
import type { PipelineAdfStep } from '../pipeline-contract.js';

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
    throw new Error(`[PIPELINE] Circular ref or depth exceeded: depth=${currentDepth}, path=${refPath}`);
  }

  const resolvedPath = path.resolve(process.cwd(), refPath);
  logger.info(`[PIPELINE] resolveRef: loading sub-pipeline from ${resolvedPath} (depth=${currentDepth})`);

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
      logger.warn(`[PIPELINE] on_error:fallback — executing fallback for step ${step.id || step.op}`);
      let fallbackSteps: any[];
      if (onError.fallback) {
        fallbackSteps = onError.fallback;
      } else if (onError.ref) {
        const refBind = onError.bind || {};
        const refResult = await resolveRef(
          resolveVarsFn(onError.ref),
          refBind,
          ctx,
          resolveVarsFn
        );
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
