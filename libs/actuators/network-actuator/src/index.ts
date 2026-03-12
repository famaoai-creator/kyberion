import { 
  logger, 
  secureFetch, 
  safeReadFile, 
  safeWriteFile, 
  safeMkdir,
  safeExec,
  pathResolver,
  resolveVars,
  evaluateCondition,
  withRetry
} from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { sendA2AMessage, pollA2AInbox } from './a2a-transport.js';

/**
 * Network-Actuator v2.2.0 [A2A TRANSPORT ENABLED]
 * Pure ADF-driven engine for all network and A2A interactions.
 */

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
  
  if (initialCtx.context_path && fs.existsSync(pathResolver.rootResolve(initialCtx.context_path))) {
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

  return { status: 'finished', results, context: ctx, total_steps: state.stepCount };
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
      const response = await secureFetch({
        method: params.method || 'GET',
        url: resolveVars(params.url, ctx),
        headers: params.headers,
        data: params.data,
        params: params.query,
        timeout: params.timeout || 20000
      });
      return { ...ctx, [params.export_as || 'last_capture']: response };

    case 'shell':
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
      const result = params.path.split('.').reduce((o: any, i: string) => o?.[i], data);
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
      const outPath = pathResolver.rootResolve(resolveVars(params.path, ctx));
      const content = typeof ctx.last_capture === 'object' ? JSON.stringify(ctx.last_capture, null, 2) : ctx.last_capture;
      if (!fs.existsSync(path.dirname(outPath))) safeMkdir(path.dirname(outPath), { recursive: true });
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

  const inputContent = safeReadFile(path.resolve(process.cwd(), argv.input as string), { encoding: 'utf8' }) as string;
  const result = await handleAction(JSON.parse(inputContent));
  console.log(JSON.stringify(result, null, 2));
};

if (require.main === module) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}

export { handleAction };
