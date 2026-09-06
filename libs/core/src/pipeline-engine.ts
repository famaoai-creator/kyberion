import * as path from 'node:path';
import { logger } from '../core.js';
import { pathResolver } from '../path-resolver.js';
import { loadPipelineAdfAtPath, type PipelineAdfStep } from '../pipeline-contract.js';
import { assertProjectTrustApproval } from '../project-trust.js';
import { safeLstat } from '../secure-io.js';
import { isBuiltinPipelineResource, requiresProjectTrust } from '../trust-requiring-resources.js';

const MAX_REF_DEPTH = 10;

function resolveSafeRefPath(refPath: string, parentCtx: Record<string, unknown>): string {
  const root = path.resolve(pathResolver.rootDir());
  const resolved = path.resolve(pathResolver.rootResolve(refPath));
  const relative = path.relative(root, resolved).replaceAll('\\', '/');
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error(`[PIPELINE_SCOPE] ref path is outside the repository root: ${refPath}`);
  }

  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    try {
      if (safeLstat(current).isSymbolicLink()) {
        throw new Error(`[PIPELINE_SCOPE] ref path cannot traverse a symbolic link: ${relative}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('[PIPELINE_SCOPE]')) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw new Error(`[PIPELINE_SCOPE] ref path could not be inspected safely: ${relative}`);
    }
  }

  if (requiresProjectTrust(relative) && !isBuiltinPipelineResource(relative)) {
    const approvalId =
      typeof parentCtx.project_trust_approval_id === 'string'
        ? parentCtx.project_trust_approval_id.trim()
        : '';
    if (approvalId) {
      assertProjectTrustApproval(approvalId, relative);
    } else if (parentCtx.trust_resolved !== true) {
      throw new Error(
        `[TRUST_REQUIRED] project-local pipeline ref cannot be loaded before trust resolution: ${relative}`
      );
    }
  }
  return resolved;
}

export interface OnErrorConfig {
  strategy: 'skip' | 'abort' | 'fallback';
  fallback?: PipelineAdfStep[];
  ref?: string;
  bind?: Record<string, unknown>;
}

export interface RefParams {
  path: string;
  bind?: Record<string, unknown>;
  export_as?: string;
}

/**
 * Loads a sub-pipeline JSON from disk, merges bind params into context,
 * and returns the steps + merged context.
 * Enforces circular-ref protection via _refDepth tracking.
 */
export async function resolveRef(
  refPath: string,
  bind: Record<string, unknown>,
  parentCtx: Record<string, unknown>,
  resolveVarsFn: (val: unknown) => unknown
): Promise<{ steps: PipelineAdfStep[]; mergedCtx: Record<string, unknown> }> {
  const parentDepth = parentCtx._refDepth;
  const currentDepth =
    typeof parentDepth === 'number' && Number.isInteger(parentDepth) && parentDepth >= 0
      ? parentDepth + 1
      : 1;
  if (currentDepth > MAX_REF_DEPTH) {
    throw new Error(
      `[PIPELINE] Circular ref or depth exceeded: depth=${currentDepth}, path=${refPath}`
    );
  }

  const resolvedPath = resolveSafeRefPath(refPath, parentCtx);
  logger.info(
    `[PIPELINE] resolveRef: loading sub-pipeline from ${resolvedPath} (depth=${currentDepth})`
  );

  const parsed = loadPipelineAdfAtPath(resolvedPath);

  const subSteps: PipelineAdfStep[] = parsed.steps;
  const subContext: Record<string, unknown> = parsed.context || {};

  // Merge bind values (resolved via parent context) into sub-context
  const resolvedBind: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bind)) {
    resolvedBind[k] = resolveVarsFn(v);
  }

  const mergedCtx: Record<string, unknown> = {
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
  step: Pick<PipelineAdfStep, 'id' | 'op'>,
  onError: OnErrorConfig,
  ctx: Record<string, unknown>,
  executeSubPipeline: (
    steps: PipelineAdfStep[],
    ctx: Record<string, unknown>
  ) => Promise<Record<string, unknown>>,
  resolveVarsFn: (val: unknown) => unknown
): Promise<{ recovered: boolean; ctx: Record<string, unknown> }> {
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
      let fallbackSteps: PipelineAdfStep[];
      if (onError.fallback) {
        fallbackSteps = onError.fallback;
      } else if (onError.ref) {
        const refBind = onError.bind || {};
        const resolvedRef = resolveVarsFn(onError.ref);
        if (typeof resolvedRef !== 'string' || !resolvedRef.trim()) {
          throw new Error('[PIPELINE] on_error fallback ref must resolve to a non-empty string');
        }
        const refResult = await resolveRef(resolvedRef, refBind, ctx, resolveVarsFn);
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
