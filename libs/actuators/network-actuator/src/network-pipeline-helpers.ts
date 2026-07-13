import {
  distillHttpResponse,
  executeLlmDecideOp,
  logger,
  secureFetch,
  safeReadFile,
  safeWriteFile,
  safeMkdir,
  safeExistsSync,
  safeExec,
  pathResolver,
  resolveVars,
  evaluateCondition,
  getPathValue,
  resolveWriteArtifactSpec,
  retry,
  classifyError,
  buildUnknownActuatorOpError,
  executeAdfSteps,
} from '@agent/core';
import * as path from 'node:path';
import { sendA2AMessage, pollA2AInbox } from './a2a-transport.js';

/**
 * Network-Actuator v2.2.0 [A2A TRANSPORT ENABLED]
 * Pure ADF-driven engine for all network and A2A interactions.
 */
const ALLOW_UNSAFE_SHELL = process.env.KYBERION_ALLOW_UNSAFE_SHELL === 'true';
const NETWORK_MANIFEST_PATH = pathResolver.rootResolve(
  'libs/actuators/network-actuator/manifest.json'
);
const DEFAULT_RETRY_POLICY = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  factor: 2,
  jitter: true,
};
let cachedRecoveryPolicy: Record<string, any> | null = null;

function assertUnsafeShellAllowed() {
  if (!ALLOW_UNSAFE_SHELL) {
    throw new Error(
      '[SECURITY] Shell execution disabled. Set KYBERION_ALLOW_UNSAFE_SHELL=true to enable.'
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function loadRecoveryPolicy(): Record<string, any> {
  if (cachedRecoveryPolicy) return cachedRecoveryPolicy;
  try {
    const manifest = JSON.parse(
      safeReadFile(NETWORK_MANIFEST_PATH, { encoding: 'utf8' }) as string
    );
    cachedRecoveryPolicy = isPlainObject(manifest?.recovery_policy) ? manifest.recovery_policy : {};
    return cachedRecoveryPolicy;
  } catch (_) {
    cachedRecoveryPolicy = {};
    return cachedRecoveryPolicy;
  }
}

function buildRetryOptions(stepParams: Record<string, any>) {
  const recoveryPolicy = loadRecoveryPolicy();
  const manifestRetry = isPlainObject(recoveryPolicy.retry) ? recoveryPolicy.retry : {};
  const retryableCategories = new Set<string>(
    Array.isArray(recoveryPolicy.retryable_categories)
      ? recoveryPolicy.retryable_categories.map(String)
      : []
  );
  const explicitRetry = isPlainObject(stepParams.retry) ? stepParams.retry : {};
  const resolved = {
    ...DEFAULT_RETRY_POLICY,
    ...manifestRetry,
    ...explicitRetry,
    maxRetries: Number(
      stepParams.max_retries ??
        explicitRetry.maxRetries ??
        manifestRetry.maxRetries ??
        DEFAULT_RETRY_POLICY.maxRetries
    ),
    initialDelayMs: Number(
      stepParams.retry_delay_ms ??
        explicitRetry.initialDelayMs ??
        manifestRetry.initialDelayMs ??
        DEFAULT_RETRY_POLICY.initialDelayMs
    ),
  };

  return {
    ...resolved,
    shouldRetry: (error: Error) => {
      const classification = classifyError(error);
      if (retryableCategories.size > 0) {
        return retryableCategories.has(classification.category);
      }
      return (
        classification.category === 'network' ||
        classification.category === 'rate_limit' ||
        classification.category === 'timeout' ||
        classification.category === 'resource_unavailable'
      );
    },
  };
}

function buildUnknownNetworkOpError(op: string): Error {
  return buildUnknownActuatorOpError('network', op);
}

export interface PipelineStep {
  type: 'capture' | 'transform' | 'apply' | 'control';
  op: string;
  params: any;
}

export interface NetworkAction {
  action: 'pipeline';
  steps: PipelineStep[];
  context?: Record<string, any>;
  options?: {
    max_steps?: number;
    timeout_ms?: number;
  };
}

export async function handleAction(input: NetworkAction) {
  if (input.action !== 'pipeline') {
    throw new Error(
      `Unsupported action: ${input.action}. Network-Actuator v2.2 is pure pipeline-driven.`
    );
  }
  return await executePipeline(input.steps || [], input.context || {}, input.options);
}

// AR-01 Task 2: the hand-rolled step loop is replaced by the canonical
// engine (executeAdfSteps), so control-op / vars / condition semantics and
// step budgets match every other runner. One deliberate semantic change:
// nested control failures now propagate instead of being silently absorbed
// (the old loop took res.context regardless of nested status — AR-06's
// no-silent-failure rule says that was a bug, not a feature).
async function executePipeline(steps: PipelineStep[], initialCtx: any = {}, options: any = {}) {
  const MAX_STEPS = options.max_steps || 1000;
  const TIMEOUT = options.timeout_ms || 60000;

  let ctx = { ...initialCtx, timestamp: new Date().toISOString() };

  if (
    initialCtx.context_path &&
    safeExistsSync(pathResolver.rootResolve(initialCtx.context_path))
  ) {
    const saved = JSON.parse(
      safeReadFile(pathResolver.rootResolve(initialCtx.context_path), {
        encoding: 'utf8',
      }) as string
    );
    ctx = { ...ctx, ...saved };
  }

  const result = await executeAdfSteps(
    steps as Parameters<typeof executeAdfSteps>[0],
    ctx,
    { maxSteps: MAX_STEPS, timeoutMs: TIMEOUT },
    {
      capture: opCapture,
      transform: opTransform,
      apply: async (op, params, currentCtx) => {
        await opApply(op, params, currentCtx);
        return currentCtx;
      },
      control: opControl,
    }
  );
  ctx = result.context;

  if (initialCtx.context_path) {
    safeWriteFile(pathResolver.rootResolve(initialCtx.context_path), JSON.stringify(ctx, null, 2));
  }

  return result;
}

async function opControl(
  op: string,
  params: any,
  ctx: any,
  runSteps: (steps: any[], seedCtx?: any) => Promise<any>,
  _resolve: (value: any) => any
) {
  const runNested = async (steps: any[], seedCtx: any) => {
    const res = await runSteps(steps, seedCtx);
    if (res.status === 'failed') {
      throw new Error(
        res.results.find((entry: any) => entry.status === 'failed')?.error ||
          'nested pipeline failed'
      );
    }
    return res.context;
  };

  switch (op) {
    case 'if':
      if (evaluateCondition(params.condition, ctx)) {
        return await runNested(params.then, ctx);
      } else if (params.else) {
        return await runNested(params.else, ctx);
      }
      return ctx;

    case 'while': {
      let iterations = 0;
      const maxIter = params.max_iterations || 100;
      while (evaluateCondition(params.condition, ctx) && iterations < maxIter) {
        ctx = await runNested(params.pipeline, ctx);
        iterations++;
      }
      return ctx;
    }

    default:
      throw buildUnknownNetworkOpError(op);
  }
}

async function opCapture(op: string, params: any, ctx: any) {
  switch (op) {
    case 'fetch':
      const response = await retry(async () => {
        return await secureFetch({
          method: params.method || 'GET',
          url: resolveVars(params.url, ctx),
          headers: params.headers,
          data: params.data,
          params: params.query,
          timeout: params.timeout || 20000,
        });
      }, buildRetryOptions(params));
      return { ...ctx, [params.export_as || 'last_capture']: response };

    case 'shell':
      assertUnsafeShellAllowed();
      const cmd = resolveVars(params.cmd, ctx);
      return { ...ctx, [params.export_as || 'last_capture']: safeExec(cmd).trim() };

    case 'a2a_poll':
      const messages = await pollA2AInbox();
      return { ...ctx, [params.export_as || 'inbox_messages']: messages };

    default:
      throw buildUnknownNetworkOpError(op);
  }
}

async function opTransform(op: string, params: any, ctx: any) {
  switch (op) {
    case 'json_query':
      const data = ctx[params.from || 'last_capture'];
      const result = getPathValue(data, params.path);
      return { ...ctx, [params.export_as]: result };

    case 'distill_response': {
      // AR-07: deterministic distillation of a fetched response (JSON shape /
      // HTML title+links / text preview, bounded) so llm_decide never sees
      // the raw body.
      const source = ctx[params.from || 'last_capture'];
      const distillate = distillHttpResponse(source, {
        maxPreviewChars: params.max_preview_chars,
        maxJsonKeys: params.max_json_keys,
        maxLinks: params.max_links,
      });
      return { ...ctx, [params.export_as || 'response_distillate']: distillate };
    }

    case 'llm_decide': {
      // AR-07: one in-loop decision about the distilled response.
      return executeLlmDecideOp({
        params,
        ctx,
        resolve: (value: any) => (typeof value === 'string' ? resolveVars(value, ctx) : value),
        defaultFromKey: 'response_distillate',
      });
    }

    case 'regex_extract':
      const input = String(ctx[params.from || 'last_capture'] || '');
      const match = input.match(new RegExp(params.pattern, 'm'));
      return { ...ctx, [params.export_as]: match ? match[1] || match[0] : null };

    default:
      throw buildUnknownNetworkOpError(op);
  }
}

async function opApply(op: string, params: any, ctx: any) {
  switch (op) {
    case 'write_file':
    case 'write_artifact':
      const spec = resolveWriteArtifactSpec(params, ctx, (value) => resolveVars(value, ctx));
      const outPath = pathResolver.rootResolve(spec.path);
      const content =
        typeof spec.content === 'string'
          ? spec.content
          : spec.content === undefined
            ? ''
            : JSON.stringify(spec.content, null, 2);
      if (!safeExistsSync(path.dirname(outPath)))
        safeMkdir(path.dirname(outPath), { recursive: true });
      safeWriteFile(outPath, content);
      break;

    case 'a2a_send':
      const message = resolveVars(params.message, ctx);
      await sendA2AMessage(message, {
        method: params.method || 'local',
        encrypt: params.encrypt !== false,
        target_public_key: params.target_public_key
          ? pathResolver.rootResolve(resolveVars(params.target_public_key, ctx))
          : undefined,
      });
      break;

    case 'log':
      logger.info(`[NETWORK_LOG] ${resolveVars(params.message || 'Action completed', ctx)}`);
      break;
  }
}
