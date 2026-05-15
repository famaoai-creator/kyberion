import { logger, safeExec, safeReadFile, safeWriteFile, safeMkdir, safeExistsSync, safeReaddir, safeLstat, derivePipelineStatus, resolveVars, evaluateCondition, resolveWriteArtifactSpec, pathResolver, loadCapabilityRegistry, scanProviderCapabilities, withRetry, classifyError, createActuatorTrace, finalizeActuatorTrace } from '@agent/core';
import { getAllFiles } from '@agent/core/fs-utils';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vm from 'node:vm';
import * as util from 'node:util';
import { execSync } from 'node:child_process';

const CODE_MANIFEST_PATH = pathResolver.rootResolve('libs/actuators/code-actuator/manifest.json');
const DEFAULT_CODE_RETRY = {
  maxRetries: 2,
  initialDelayMs: 150,
  maxDelayMs: 1200,
  factor: 2,
  jitter: true,
};

let cachedRecoveryPolicy: Record<string, any> | null = null;

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function loadRecoveryPolicy(): Record<string, any> {
  if (cachedRecoveryPolicy) return cachedRecoveryPolicy;
  try {
    const manifest = JSON.parse(safeReadFile(CODE_MANIFEST_PATH, { encoding: 'utf8' }) as string);
    cachedRecoveryPolicy = isPlainObject(manifest?.recovery_policy) ? manifest.recovery_policy : {};
  } catch {
    cachedRecoveryPolicy = {};
  }
  return cachedRecoveryPolicy;
}

function buildRetryOptions() {
  const policy = loadRecoveryPolicy();
  const retry = isPlainObject(policy.retry) ? policy.retry : DEFAULT_CODE_RETRY;
  const retryableCategories = new Set<string>(
    Array.isArray(policy.retryable_categories) ? policy.retryable_categories.map(String) : [],
  );
  return {
    ...DEFAULT_CODE_RETRY,
    ...retry,
    shouldRetry: (error: Error) => {
      const classification = classifyError(error);
      return retryableCategories.size > 0
        ? retryableCategories.has(classification.category)
        : classification.category === 'resource_unavailable' || classification.category === 'timeout';
    },
  };
}

/**
 * Code-Actuator v2.1.0 [AUTONOMOUS CONTROL ENABLED]
 * Strictly compliant with Layer 2 (Shield).
 * Generic data pipeline engine for source code analysis with Control Flow and Safety Guards.
 */
const ALLOW_UNSAFE_SHELL = process.env.KYBERION_ALLOW_UNSAFE_SHELL === 'true';
const ALLOW_UNSAFE_JS = process.env.KYBERION_ALLOW_UNSAFE_JS === 'true';

function assertUnsafeShellAllowed() {
  if (!ALLOW_UNSAFE_SHELL) {
    throw new Error('[SECURITY] Shell execution disabled. Set KYBERION_ALLOW_UNSAFE_SHELL=true to enable.');
  }
}

function assertUnsafeJsAllowed() {
  if (!ALLOW_UNSAFE_JS) {
    throw new Error('[SECURITY] JS execution disabled. Set KYBERION_ALLOW_UNSAFE_JS=true to enable.');
  }
}

interface PipelineStep {
  type: 'capture' | 'transform' | 'apply' | 'control';
  op: string;
  params: any;
}

interface CodeAction {
  action: 'pipeline' | 'reconcile';
  steps?: PipelineStep[];
  strategy_path?: string;
  context?: Record<string, any>;
  options?: {
    max_steps?: number;
    timeout_ms?: number;
  };
}

/**
 * Main Entry Point
 */
async function handleAction(input: CodeAction) {
  if (input.action === 'reconcile') {
    return await performReconcile(input);
  }
  const traceCtx = createActuatorTrace('code-actuator', 'pipeline');
  traceCtx.startSpan('code:pipeline', {
    stepCount: Array.isArray(input.steps) ? input.steps.length : 0,
  });
  try {
    const result = await executePipeline(input.steps || [], input.context || {}, input.options, { stepCount: 0, startTime: Date.now() }, traceCtx);
    traceCtx.endSpan('ok');
    return { ...result, ...finalizeActuatorTrace(traceCtx) };
  } catch (err: any) {
    traceCtx.endSpan('error', err?.message ?? String(err));
    return {
      status: 'error',
      message: err?.message ?? String(err),
      ...finalizeActuatorTrace(traceCtx),
    };
  }
}

/**
 * Universal Pipeline Engine with Control Flow & Safety Guards
 */
async function executePipeline(steps: PipelineStep[], initialCtx: any = {}, options: any = {}, state: any = { stepCount: 0, startTime: Date.now() }, traceCtx?: any) {
  const rootDir = pathResolver.rootDir();
  const MAX_STEPS = options.max_steps || 1000;
  const TIMEOUT = options.timeout_ms || 60000;

  let ctx = { ...initialCtx, root: rootDir };
  
  if (initialCtx.context_path && safeExistsSync(path.resolve(rootDir, initialCtx.context_path))) {
    const saved = await withRetry(
      async () => JSON.parse(safeReadFile(path.resolve(rootDir, initialCtx.context_path), { encoding: 'utf8' }) as string),
      buildRetryOptions(),
    );
    ctx = { ...ctx, ...saved };
  }

  const resolve = (val: any) => resolveVars(val, ctx);

  const results = [];
  for (const step of steps) {
    state.stepCount++;
    if (state.stepCount > MAX_STEPS) throw new Error(`[SAFETY_LIMIT] Exceeded maximum steps (${MAX_STEPS})`);
    if (Date.now() - state.startTime > TIMEOUT) throw new Error(`[SAFETY_LIMIT] Execution timed out (${TIMEOUT}ms)`);

    try {
      traceCtx?.startSpan?.(`code:${step.type}:${step.op}`, { stepCount: state.stepCount });
      logger.info(`  [CODE_PIPELINE] [Step ${state.stepCount}] ${step.type}:${step.op}...`);
      
      if (step.type === 'control') {
        ctx = await opControl(step.op, step.params, ctx, options, state, resolve, traceCtx);
      } else {
        switch (step.type) {
          case 'capture': ctx = await opCapture(step.op, step.params, ctx, resolve); break;
          case 'transform': ctx = await opTransform(step.op, step.params, ctx, resolve); break;
          case 'apply': await opApply(step.op, step.params, ctx, resolve); break;
        }
      }
      traceCtx?.endSpan?.('ok');
      results.push({ op: step.op, status: 'success' });
    } catch (err: any) {
      traceCtx?.endSpan?.('error', err.message);
      logger.error(`  [CODE_PIPELINE] Step failed (${step.op}): ${err.message}`);
      results.push({ op: step.op, status: 'failed', error: err.message });
      break; 
    }
  }

  if (initialCtx.context_path) {
    await withRetry(
      async () => {
        safeWriteFile(path.resolve(rootDir, initialCtx.context_path), JSON.stringify(ctx, null, 2));
        return undefined;
      },
      buildRetryOptions(),
    );
  }

  return { status: derivePipelineStatus(results), results, context: ctx, total_steps: state.stepCount };
}

/**
 * CONTROL Operators
 */
async function opControl(op: string, params: any, ctx: any, options: any, state: any, resolve: (value: any) => any, traceCtx?: any) {
  switch (op) {
    case 'if':
      if (evaluateCondition(params.condition, ctx)) {
        const res = await executePipeline(params.then, ctx, options, state, traceCtx);
        return res.context;
      } else if (params.else) {
        const res = await executePipeline(params.else, ctx, options, state, traceCtx);
        return res.context;
      }
      return ctx;

    case 'while':
      let iterations = 0;
      const maxIter = params.max_iterations || 100;
      while (evaluateCondition(params.condition, ctx) && iterations < maxIter) {
        const res = await executePipeline(params.pipeline, ctx, options, state, traceCtx);
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
async function opCapture(op: string, params: any, ctx: any, resolve: (value: any) => any) {
  const rootDir = pathResolver.rootDir();
  switch (op) {
    case 'read_file':
      return {
        ...ctx,
        [params.export_as || 'last_capture']: await withRetry(
          async () => safeReadFile(path.resolve(rootDir, resolve(params.path)), { encoding: 'utf8' }),
          buildRetryOptions(),
        ),
      };
    case 'glob_files':
      return {
        ...ctx,
        [params.export_as || 'file_list']: await withRetry(
          async () =>
            getAllFiles(path.resolve(rootDir, resolve(params.dir)))
              .filter(f => !params.ext || f.endsWith(params.ext))
              .map(f => path.relative(rootDir, f)),
          buildRetryOptions(),
        ),
      };
    case 'shell':
      assertUnsafeShellAllowed();
      return {
        ...ctx,
        [params.export_as || 'last_capture']: await withRetry(
          async () => execSync(resolve(params.cmd), { encoding: 'utf8' }).trim(),
          buildRetryOptions(),
        ),
      };
    case 'discover_capabilities':
    case 'discover_skills':
      const actuatorsRootDir = path.join(rootDir, 'libs/actuators');
      const capabilities: any[] = [];
      if (safeExistsSync(actuatorsRootDir)) {
        const actuatorDirs = await withRetry(
          async () => safeReaddir(actuatorsRootDir).filter(f => safeLstat(path.join(actuatorsRootDir, f)).isDirectory()),
          buildRetryOptions(),
        );
        for (const dir of actuatorDirs) {
          capabilities.push({
            name: dir,
            path: path.join('libs/actuators', dir),
            category: 'actuator',
          });
        }
      }
      capabilities.push(...discoverProviderCliCapabilities());
      return { ...ctx, [params.export_as || 'capabilities_list']: capabilities };
    default: return ctx;
  }
}

function discoverProviderCliCapabilities(): any[] {
  const registry = loadCapabilityRegistry();
  return scanProviderCapabilities(registry, undefined, { includeUnavailable: false }).map((capability) => ({
    name: capability.source.name,
    path: `${capability.source.provider} ${capability.source.name}`.trim(),
    category: capability.source.type,
    provider: capability.source.provider,
    capability_id: capability.capability_id,
    status: capability.discovery_status === 'available' ? capability.status : 'blocked',
    description: capability.notes || capability.capability_id,
    evidence: capability.evidence || capability.provider_probe.evidence,
    discovery_status: capability.discovery_status,
  }));
}

/**
 * TRANSFORM Operators
 */
async function opTransform(op: string, params: any, ctx: any, resolve: (value: any) => any) {
  switch (op) {
    case 'regex_replace':
      return { ...ctx, [params.export_as || 'last_transform']: String(ctx[params.from || 'last_capture'] || '').replace(new RegExp(params.pattern, 'g'), resolve(params.template)) };
    case 'json_update':
      const json = JSON.parse(ctx[params.from || 'last_capture']);
      params.updates.forEach((u: any) => { json[u.key] = resolve(u.value); });
      return { ...ctx, [params.export_as || 'last_transform']: JSON.stringify(json, null, 2) + '\n' };
    case 'run_js':
      assertUnsafeJsAllowed();
      const sandbox = { Buffer, process: { env: { ...process.env } }, console, ctx: { ...ctx } };
      vm.createContext(sandbox);
      await new vm.Script(resolve(params.code)).runInContext(sandbox);
      return { ...sandbox.ctx };
    default: return ctx;
  }
}

/**
 * APPLY Operators
 */
async function opApply(op: string, params: any, ctx: any, resolve: (value: any) => any) {
  const rootDir = pathResolver.rootDir();
  switch (op) {
    case 'write_file':
    case 'write_artifact':
      const spec = resolveWriteArtifactSpec(params, ctx, resolve);
      const out = path.resolve(rootDir, spec.path);
      const content = typeof spec.content === 'string' ? spec.content : spec.content === undefined ? '' : JSON.stringify(spec.content, null, 2);
      if (!safeExistsSync(path.dirname(out))) safeMkdir(path.dirname(out), { recursive: true });
      await withRetry(
        async () => {
          safeWriteFile(out, content);
          return undefined;
        },
        buildRetryOptions(),
      );
      break;
    case 'log': logger.info(`[CODE_LOG] ${resolve(params.message || 'Action completed')}`); break;
  }
}

/**
 * Strategic Reconciliation
 */
async function performReconcile(input: CodeAction) {
  const strategyPath = path.resolve(pathResolver.rootDir(), input.strategy_path || 'knowledge/governance/code-strategy.json');
  if (!safeExistsSync(strategyPath)) throw new Error(`Strategy not found: ${strategyPath}`);
  const config = await withRetry(
    async () => JSON.parse(safeReadFile(strategyPath, { encoding: 'utf8' }) as string),
    buildRetryOptions(),
  );
  for (const strategy of config.strategies) {
    await executePipeline(strategy.pipeline, strategy.params || {}, input.options);
  }
  return { status: 'reconciled' };
}

/**
 * CLI Runner
 */
const main = async () => {
  const argv = await createStandardYargs().option('input', { alias: 'i', type: 'string', required: true }).parseSync();
  const inputContent = await withRetry(
    async () => safeReadFile(path.resolve(pathResolver.rootDir(), argv.input as string), { encoding: 'utf8' }) as string,
    buildRetryOptions(),
  );
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
