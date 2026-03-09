import { 
  logger, 
  secureFetch, 
  safeReadFile, 
  safeWriteFile, 
  safeMkdir,
  safeExec
} from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';

/**
 * Network-Actuator v2.0.0 [PIPELINE DRIVEN]
 * Strictly compliant with Layer 2 (Shield).
 * A pure ADF-driven engine for all network interactions and external data flows.
 */

interface PipelineStep {
  type: 'capture' | 'transform' | 'apply';
  op: string;
  params: any;
}

interface NetworkAction {
  action: 'pipeline';
  steps: PipelineStep[];
  context?: Record<string, any>;
}

/**
 * Main Entry Point
 */
async function handleAction(input: NetworkAction) {
  if (input.action !== 'pipeline') {
    throw new Error(`Unsupported action: ${input.action}. Network-Actuator v2.0 is pure pipeline-driven.`);
  }
  return await executePipeline(input.steps || [], input.context || {});
}

/**
 * Universal Network Pipeline Engine
 */
async function executePipeline(steps: PipelineStep[], initialCtx: any = {}) {
  let ctx = { ...initialCtx, timestamp: new Date().toISOString() };
  const results = [];

  for (const step of steps) {
    try {
      logger.info(`  [NET_PIPELINE] Executing ${step.type}:${step.op}...`);
      switch (step.type) {
        case 'capture': ctx = await opCapture(step.op, step.params, ctx); break;
        case 'transform': ctx = await opTransform(step.op, step.params, ctx); break;
        case 'apply': await opApply(step.op, step.params, ctx); break;
      }
      results.push({ op: step.op, status: 'success' });
    } catch (err: any) {
      logger.error(`  [NET_PIPELINE] Step failed (${step.op}): ${err.message}`);
      results.push({ op: step.op, status: 'failed', error: err.message });
      break; 
    }
  }
  return { status: 'finished', results, final_context_keys: Object.keys(ctx) };
}

/**
 * CAPTURE Operators: Bring external data INTO the context
 */
async function opCapture(op: string, params: any, ctx: any) {
  const resolve = (val: string) => typeof val === 'string' ? val.replace(/{{(.*?)}}/g, (_, p) => ctx[p.trim()] || '') : val;

  switch (op) {
    case 'fetch':
      const response = await secureFetch({
        method: params.method || 'GET',
        url: resolve(params.url),
        headers: params.headers,
        data: params.data,
        params: params.query,
        timeout: params.timeout || 20000
      });
      return { ...ctx, [params.export_as || 'last_capture']: response };

    case 'shell':
      const output = execSync(resolve(params.cmd), { encoding: 'utf8' }).trim();
      return { ...ctx, [params.export_as || 'last_capture']: output };

    default: return ctx;
  }
}

/**
 * TRANSFORM Operators: Mutate context data
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
      return { ...ctx, [params.export_as]: match ? match[1] : null };

    default: return ctx;
  }
}

/**
 * APPLY Operators: Push data OUT to local/remote systems
 */
async function opApply(op: string, params: any, ctx: any) {
  const rootDir = process.cwd();
  const resolve = (val: string) => typeof val === 'string' ? val.replace(/{{(.*?)}}/g, (_, p) => ctx[p.trim()] || '') : val;

  switch (op) {
    case 'write_file':
      const outPath = path.resolve(rootDir, resolve(params.path));
      const content = typeof ctx.last_capture === 'object' ? JSON.stringify(ctx.last_capture, null, 2) : ctx.last_capture;
      if (!fs.existsSync(path.dirname(outPath))) safeMkdir(path.dirname(outPath), { recursive: true });
      safeWriteFile(outPath, content);
      break;

    case 'log':
      logger.info(`[NETWORK_LOG] ${resolve(params.message || 'Data captured')}`);
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
