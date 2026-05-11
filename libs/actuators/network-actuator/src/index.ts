import { 
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
  withRetry,
  derivePipelineStatus,
  classifyError
} from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendA2AMessage, pollA2AInbox } from './a2a-transport.js';

/**
 * Network-Actuator v2.2.0 [A2A TRANSPORT ENABLED]
 * Pure ADF-driven engine for all network and A2A interactions.
 */
const ALLOW_UNSAFE_SHELL = process.env.KYBERION_ALLOW_UNSAFE_SHELL === 'true';
const NETWORK_MANIFEST_PATH = pathResolver.rootResolve('libs/actuators/network-actuator/manifest.json');
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
    throw new Error('[SECURITY] Shell execution disabled. Set KYBERION_ALLOW_UNSAFE_SHELL=true to enable.');
  }
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function loadRecoveryPolicy(): Record<string, any> {
  if (cachedRecoveryPolicy) return cachedRecoveryPolicy;
  try {
    const manifest = JSON.parse(safeReadFile(NETWORK_MANIFEST_PATH, { encoding: 'utf8' }) as string);
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
    Array.isArray(recoveryPolicy.retryable_categories) ? recoveryPolicy.retryable_categories.map(String) : [],
  );
  const explicitRetry = isPlainObject(stepParams.retry) ? stepParams.retry : {};
  const resolved = {
    ...DEFAULT_RETRY_POLICY,
    ...manifestRetry,
    ...explicitRetry,
    maxRetries: Number(stepParams.max_retries ?? explicitRetry.maxRetries ?? manifestRetry.maxRetries ?? DEFAULT_RETRY_POLICY.maxRetries),
    initialDelayMs: Number(stepParams.retry_delay_ms ?? explicitRetry.initialDelayMs ?? manifestRetry.initialDelayMs ?? DEFAULT_RETRY_POLICY.initialDelayMs),
  };

  return {
    ...resolved,
    shouldRetry: (error: Error) => {
      const classification = classifyError(error);
      if (retryableCategories.size > 0) {
        return retryableCategories.has(classification.category);
      }
      return classification.category === 'network'
        || classification.category === 'rate_limit'
        || classification.category === 'timeout'
        || classification.category === 'resource_unavailable';
    },
  };
}

interface PipelineStep {
  type: 'capture' | 'transform' | 'apply' | 'control';
  op: string;
  params: any;
}

interface NetworkAction {
  action: 'pipeline';
  steps: PipelineStep[];
  context?: Record<string, any>;
  options?: {
    max_steps?: number;
    timeout_ms?: number;
  };
}

/**
 * Main Entry Point
 */
async function handleAction(input: NetworkAction) {
  if (input.action !== 'pipeline') {
    throw new Error(`Unsupported action: ${input.action}. Network-Actuator v2.2 is pure pipeline-driven.`);
  }
  return await executePipeline(input.steps || [], input.context || {}, input.options);
}

/**
 * Universal Network Pipeline Engine
 */
async function executePipeline(steps: PipelineStep[], initialCtx: any = {}, options: any = {}, state: any = { stepCount: 0, startTime: Date.now() }) {
  const rootDir = pathResolver.rootDir();
  const MAX_STEPS = options.max_steps || 1000;
  const TIMEOUT = options.timeout_ms || 60000;

  let ctx = { ...initialCtx, timestamp: new Date().toISOString() };
  
  if (initialCtx.context_path && safeExistsSync(pathResolver.rootResolve(initialCtx.context_path))) {
    const saved = JSON.parse(safeReadFile(pathResolver.rootResolve(initialCtx.context_path), { encoding: 'utf8' }) as string);
    ctx = { ...ctx, ...saved };
  }

  const results = [];
  for (const step of steps) {
    state.stepCount++;
    if (state.stepCount > MAX_STEPS) throw new Error(`[SAFETY_LIMIT] Exceeded maximum pipeline steps (${MAX_STEPS})`);
    if (Date.now() - state.startTime > TIMEOUT) throw new Error(`[SAFETY_LIMIT] Pipeline execution timed out (${TIMEOUT}ms)`);

    try {
      logger.info(`  [NET_PIPELINE] [Step ${state.stepCount}] ${step.type}:${step.op}...`);
      
      if (step.type === 'control') {
        ctx = await opControl(step.op, step.params, ctx, options, state);
      } else {
        switch (step.type) {
          case 'capture': ctx = await opCapture(step.op, step.params, ctx); break;
          case 'transform': ctx = await opTransform(step.op, step.params, ctx); break;
          case 'apply': await opApply(step.op, step.params, ctx); break;
        }
      }
      results.push({ op: step.op, status: 'success' });
    } catch (err: any) {
      logger.error(`  [NET_PIPELINE] Step failed (${step.op}): ${err.message}`);
      results.push({ op: step.op, status: 'failed', error: err.message });
      break; 
    }
  }

  if (initialCtx.context_path) {
    safeWriteFile(pathResolver.rootResolve(initialCtx.context_path), JSON.stringify(ctx, null, 2));
  }

  return { status: derivePipelineStatus(results), results, context: ctx, total_steps: state.stepCount };
}

/**
 * CONTROL Operators
 */
async function opControl(op: string, params: any, ctx: any, options: any, state: any) {
  switch (op) {
    case 'if':
      if (evaluateCondition(params.condition, ctx)) {
        const res = await executePipeline(params.then, ctx, options, state);
        return res.context;
      } else if (params.else) {
        const res = await executePipeline(params.else, ctx, options, state);
        return res.context;
      }
      return ctx;

    case 'while':
      let iterations = 0;
      const maxIter = params.max_iterations || 100;
      while (evaluateCondition(params.condition, ctx) && iterations < maxIter) {
        const res = await executePipeline(params.pipeline, ctx, options, state);
        ctx = res.context;
        iterations++;
      }
      return ctx;

    default: return ctx;
  }
}

/**
 * CAPTURE Operators
 */
async function opCapture(op: string, params: any, ctx: any) {
  switch (op) {
    case 'fetch':
      const response = await withRetry(async () => {
        return await secureFetch({
          method: params.method || 'GET',
          url: resolveVars(params.url, ctx),
          headers: params.headers,
          data: params.data,
          params: params.query,
          timeout: params.timeout || 20000
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

    default: return ctx;
  }
}

/**
 * TRANSFORM Operators
 */
async function opTransform(op: string, params: any, ctx: any) {
  switch (op) {
    case 'json_query':
      const data = ctx[params.from || 'last_capture'];
      const result = getPathValue(data, params.path);
      return { ...ctx, [params.export_as]: result };

    case 'regex_extract':
      const input = String(ctx[params.from || 'last_capture'] || '');
      const match = input.match(new RegExp(params.pattern, 'm'));
      return { ...ctx, [params.export_as]: match ? match[1] || match[0] : null };

    default: return ctx;
  }
}

/**
 * APPLY Operators
 */
async function opApply(op: string, params: any, ctx: any) {
  switch (op) {
    case 'write_file':
    case 'write_artifact':
      const spec = resolveWriteArtifactSpec(params, ctx, (value) => resolveVars(value, ctx));
      const outPath = pathResolver.rootResolve(spec.path);
      const content = typeof spec.content === 'string' ? spec.content : spec.content === undefined ? '' : JSON.stringify(spec.content, null, 2);
      if (!safeExistsSync(path.dirname(outPath))) safeMkdir(path.dirname(outPath), { recursive: true });
      safeWriteFile(outPath, content);
      break;

    case 'a2a_send':
      const message = resolveVars(params.message, ctx);
      await sendA2AMessage(message, {
        method: params.method || 'local',
        encrypt: params.encrypt !== false,
        target_public_key: params.target_public_key ? pathResolver.rootResolve(resolveVars(params.target_public_key, ctx)) : undefined
      });
      break;

    case 'log':
      logger.info(`[NETWORK_LOG] ${resolveVars(params.message || 'Action completed', ctx)}`);
      break;
  }
}

/**
 * CLI Runner
 */
const main = async () => {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();

  const inputContent = safeReadFile(pathResolver.rootResolve(argv.input as string), { encoding: 'utf8' }) as string;
  const result = await handleAction(JSON.parse(inputContent));
  console.log(JSON.stringify(result, null, 2));
};

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (entrypoint && modulePath === entrypoint) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}

export { handleAction };
