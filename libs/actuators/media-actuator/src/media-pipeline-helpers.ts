import {
  logger,
  safeWriteFile,
  derivePipelineStatus,
  pathResolver,
  resolveRef,
  resolveVars,
  handleStepError,
  createActuatorTrace,
  finalizeActuatorTrace,
} from '@agent/core';
import type { TraceContext } from '@agent/core';
import * as path from 'node:path';

export interface MediaPipelineStep {
  type: 'capture' | 'transform' | 'apply' | 'sink' | 'control';
  op: string;
  params: any;
  on_error?: any;
}

export interface MediaAction {
  action: 'pipeline';
  steps: MediaPipelineStep[];
  context?: Record<string, any>;
  options?: {
    max_steps?: number;
    timeout_ms?: number;
  };
  /** When provided by the pipeline runner, media steps are recorded as child spans of this trace. */
  pipelineTrace?: TraceContext;
}

export interface MediaPipelineDeps {
  opCapture: (op: string, params: any, ctx: any, resolve: Function) => Promise<any>;
  opTransform: (op: string, params: any, ctx: any, resolve: Function) => Promise<any>;
  opApply: (op: string, params: any, ctx: any, resolve: Function) => Promise<any>;
}

export async function handleMediaAction(input: MediaAction, deps: MediaPipelineDeps) {
  if (input.action !== 'pipeline') throw new Error('Unsupported action');
  const stepCount = Array.isArray(input.steps) ? input.steps.length : 0;

  // When called from the pipeline runner with a live TraceContext, record media steps as
  // child spans of the pipeline trace instead of creating a disconnected standalone trace.
  if (input.pipelineTrace) {
    const pt = input.pipelineTrace;
    pt.startSpan('media:pipeline', { stepCount });
    try {
      const result = await executeMediaPipeline(
        input.steps || [],
        input.context || {},
        input.options,
        { stepCount: 0, startTime: Date.now() },
        pt,
        deps,
      );
      pt.endSpan('ok');
      return result;
    } catch (err: any) {
      pt.endSpan('error', err?.message ?? String(err));
      return { status: 'failed', message: err?.message ?? String(err) };
    }
  }

  // Standalone execution — create a self-contained actuator trace.
  const traceCtx = createActuatorTrace('media-actuator', 'pipeline');
  traceCtx.startSpan('media:pipeline', { stepCount });
  try {
    const result = await executeMediaPipeline(
      input.steps || [],
      input.context || {},
      input.options,
      { stepCount: 0, startTime: Date.now() },
      traceCtx,
      deps,
    );
    traceCtx.endSpan('ok');
    return { ...result, ...finalizeActuatorTrace(traceCtx) };
  } catch (err: any) {
    traceCtx.endSpan('error', err?.message ?? String(err));
    return {
      status: 'failed',
      message: err?.message ?? String(err),
      ...finalizeActuatorTrace(traceCtx),
    };
  }
}

export async function executeMediaPipeline(
  steps: MediaPipelineStep[],
  initialCtx: any = {},
  options: any = {},
  state: any = { stepCount: 0, startTime: Date.now() },
  traceCtx?: any,
  deps?: MediaPipelineDeps,
) {
  const rootDir = pathResolver.rootDir();
  let ctx = { ...initialCtx, timestamp: new Date().toISOString() };
  const resolve = (val: any) => resolveVars(val, ctx);

  const results = [];
  for (const step of steps) {
    state.stepCount++;
    const op = (step.op || '').startsWith('media:') ? step.op.slice(6) : step.op;

    try {
      traceCtx?.startSpan?.(`media:${step.type}:${op}`, { stepCount: state.stepCount });
      logger.info(`  [MEDIA_PIPELINE] [Step ${state.stepCount}] ${step.type}:${op}...`);
      switch (step.type) {
        case 'capture':
          ctx = await deps!.opCapture(op, step.params, ctx, resolve);
          break;
        case 'transform':
          ctx = await deps!.opTransform(op, step.params, ctx, resolve);
          break;
        case 'apply':
          ctx = await deps!.opApply(op, step.params, ctx, resolve);
          break;
        case 'sink':
          ctx = await deps!.opApply(op, step.params, ctx, resolve);
          break;
        case 'control': {
          if (op === 'ref') {
            const refPath = resolve(step.params.path);
            const bindResolved: Record<string, any> = {};
            if (step.params.bind) {
              for (const [k, v] of Object.entries(step.params.bind as Record<string, any>)) {
                bindResolved[k] = resolve(v);
              }
            }
            const refResult = await resolveRef(refPath, bindResolved, ctx, resolve);
            const subResult = await executeMediaPipeline(
              refResult.steps,
              { ...ctx, ...refResult.mergedCtx },
              options,
              state,
              traceCtx,
              deps,
            );
            const { _refDepth, ...subCtxClean } = subResult.context || {};
            ctx = { ...ctx, ...subCtxClean };
          }
          break;
        }
      }
      traceCtx?.endSpan?.('ok');
      results.push({ op, status: 'success' });
    } catch (err: any) {
      traceCtx?.endSpan?.('error', err.message);
      const stepOnError = (step as any).on_error;
      if (stepOnError) {
        try {
          const recovery = await handleStepError(err, step, stepOnError, ctx,
            async (fallbackSteps: any[], errCtx: any) => {
              const res = await executeMediaPipeline(fallbackSteps, errCtx, options, state, traceCtx, deps);
              return res.context;
            }, resolve);
          if (recovery.recovered) {
            ctx = recovery.ctx;
            results.push({ op: step.op, status: 'recovered' as any });
            continue;
          }
        } catch (_) { /* fallthrough to default error handling */ }
      }
      logger.error(`  [MEDIA_PIPELINE] Step failed (${step.op}): ${err.message}`);
      results.push({ op: step.op, status: 'failed', error: err.message });
      break;
    }
  }

  if (initialCtx.context_path) {
    safeWriteFile(path.resolve(pathResolver.rootDir(), initialCtx.context_path), JSON.stringify(ctx, null, 2));
  }

  return { status: derivePipelineStatus(results), results, context: ctx };
}
