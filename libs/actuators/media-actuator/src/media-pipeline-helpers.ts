import { safeWriteFile } from '@agent/core/secure-io';
import { runAdfActuatorPipeline } from '@agent/core/actuator-sdk';
import { DEFAULT_MAX_PIPELINE_STEPS } from '@agent/core/execution-bounds';
import { pathResolver } from '@agent/core/path-resolver';
import { resolveRef } from '@agent/core/src/pipeline-engine';
import { createActuatorTrace, finalizeActuatorTrace } from '@agent/core/actuator-trace';
import { ensureDefaultOpPreflight } from '@agent/core/op-preflight-defaults';
import { runOpPreflight } from '@agent/core/op-preflight';
import type { TraceContext } from '@agent/core/src/trace';
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
  ensureDefaultOpPreflight();
  const preflight = await runOpPreflight({
    op: 'media:pipeline',
    params: {
      steps: input.steps,
      ...(input.context ? { context: input.context } : {}),
      ...(input.options ? { options: input.options } : {}),
    },
    context: input.context,
    source: 'actuator',
  });
  if (preflight.decision !== 'allow') {
    throw new Error(
      `[OP_PREFLIGHT_${preflight.decision.toUpperCase()}] ${preflight.reason || 'Operation media:pipeline was not admitted.'}`
    );
  }
  const admitted = preflight.input;
  input = {
    ...input,
    ...(Array.isArray(admitted.steps) ? { steps: admitted.steps as MediaPipelineStep[] } : {}),
    ...(admitted.context && typeof admitted.context === 'object'
      ? { context: admitted.context as Record<string, any> }
      : {}),
    ...(admitted.options && typeof admitted.options === 'object'
      ? { options: admitted.options as MediaAction['options'] }
      : {}),
  };
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
        pt,
        deps
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
      traceCtx,
      deps
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

const stripMediaOpPrefix = (op: string) => ((op || '').startsWith('media:') ? op.slice(6) : op);

// The canonical engine only knows capture/transform/apply/control, so media's
// extra surface ('media:' op prefixes, the 'sink' alias for apply) is
// normalized up front — recursively into on_error.fallback arrays, which the
// engine runs through the same nested-step path.
function normalizeMediaSteps(list: MediaPipelineStep[]): any[] {
  return (list || []).map((step) => ({
    ...step,
    op: stripMediaOpPrefix(step.op),
    type: step.type === 'sink' ? 'apply' : step.type,
    __media_step_type: step.type,
    ...(step.on_error?.fallback
      ? { on_error: { ...step.on_error, fallback: normalizeMediaSteps(step.on_error.fallback) } }
      : {}),
  }));
}

// AR-01 Task 2: hand-rolled loop replaced by the canonical engine
// (runAdfActuatorPipeline). on_error recovery is the engine's native path now.
// Deliberate semantic changes: nested ref failures propagate (AR-06
// no-silent-failure), non-ref control ops throw instead of being silently
// ignored, and the step/timeout budget is actually enforced (media renders
// can be slow, so the default timeout is 10 minutes, not the engine's 60s).
export async function executeMediaPipeline(
  steps: MediaPipelineStep[],
  initialCtx: any = {},
  options: any = {},
  traceCtx?: any,
  deps?: MediaPipelineDeps
) {
  let ctx = { ...initialCtx, timestamp: new Date().toISOString() };

  const hooks = {
    beforeStep: (step: any, stepNumber: number) => {
      traceCtx?.startSpan?.(`media:${step.__media_step_type || step.type}:${step.op}`, {
        stepCount: stepNumber,
      });
    },
    afterStep: (_step: any, _stepNumber: number, _stepCtx: any, outcome: any) => {
      if (outcome.status === 'success' || outcome.status === 'skipped') {
        traceCtx?.endSpan?.('ok');
      } else {
        traceCtx?.endSpan?.('error', outcome.error);
      }
    },
  };

  const result = await runAdfActuatorPipeline({
    actuatorId: 'media',
    steps: normalizeMediaSteps(steps),
    context: ctx,
    options: {
      maxSteps: options.max_steps || DEFAULT_MAX_PIPELINE_STEPS,
      timeoutMs: options.timeout_ms || 600000,
    },
    handlers: {
      capture: (op, params, stepCtx, resolve) => deps!.opCapture(op, params, stepCtx, resolve),
      transform: (op, params, stepCtx, resolve) => deps!.opTransform(op, params, stepCtx, resolve),
      apply: (op, params, stepCtx, resolve) => deps!.opApply(op, params, stepCtx, resolve),
      control: async (op, params, stepCtx, runSteps, resolve) => {
        if (op !== 'ref') {
          throw new Error(`Unsupported control operator in Media-Actuator: ${op}`);
        }
        const refPath = resolve(params.path);
        const bindResolved: Record<string, any> = {};
        if (params.bind) {
          for (const [k, v] of Object.entries(params.bind as Record<string, any>)) {
            bindResolved[k] = resolve(v);
          }
        }
        const refResult = await resolveRef(refPath, bindResolved, stepCtx, resolve);
        const res = await runSteps(normalizeMediaSteps(refResult.steps), {
          ...stepCtx,
          ...refResult.mergedCtx,
        });
        if (res.status === 'failed') {
          throw new Error(
            res.results.find((entry: any) => entry.status === 'failed')?.error ||
              'nested pipeline failed'
          );
        }
        const { _refDepth, ...subCtxClean } = res.context || {};
        return { ...stepCtx, ...subCtxClean };
      },
    },
    hooks,
  });
  ctx = result.context;

  if (initialCtx.context_path) {
    safeWriteFile(
      path.resolve(pathResolver.rootDir(), initialCtx.context_path),
      JSON.stringify(ctx, null, 2)
    );
  }

  return { status: result.status, results: result.results, context: ctx };
}
