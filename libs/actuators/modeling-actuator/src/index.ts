import { logger, safeReadFile, safeWriteFile, safeMkdir } from '@agent/core';
import { getAllFiles } from '@agent/core/fs-utils';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

/**
 * Modeling-Actuator v2.0.0 [ULTIMATE PIPELINE ENGINE]
 * Strictly compliant with Layer 2 (Shield).
 * Generic data pipeline engine for architectural analysis, modeling, and validation.
 */

interface PipelineStep {
  type: 'capture' | 'transform' | 'apply';
  op: string;
  params: any;
}

interface ModelingAction {
  action: 'pipeline' | 'reconcile';
  steps?: PipelineStep[];
  strategy_path?: string;
  context?: Record<string, any>;
}

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

/**
 * Main Entry Point
 */
async function handleAction(input: ModelingAction) {
  if (input.action === 'reconcile') {
    return await performReconcile(input);
  }
  return await executePipeline(input.steps || [], input.context || {});
}

/**
 * Universal Pipeline Engine
 */
async function executePipeline(steps: PipelineStep[], initialCtx: any = {}) {
  let ctx = { ...initialCtx, timestamp: new Date().toISOString() };
  const results = [];

  for (const step of steps) {
    try {
      logger.info(`  [MODEL_PIPELINE] Executing ${step.type}:${step.op}...`);
      switch (step.type) {
        case 'capture': ctx = await opCapture(step.op, step.params, ctx); break;
        case 'transform': ctx = await opTransform(step.op, step.params, ctx); break;
        case 'apply': await opApply(step.op, step.params, ctx); break;
      }
      results.push({ op: step.op, status: 'success' });
    } catch (err: any) {
      logger.error(`  [MODEL_PIPELINE] Step failed (${step.op}): ${err.message}`);
      results.push({ op: step.op, status: 'failed', error: err.message });
      break; 
    }
  }
  return { status: 'finished', results, final_context_keys: Object.keys(ctx) };
}

/**
 * CAPTURE Operators
 */
async function opCapture(op: string, params: any, ctx: any) {
  const rootDir = process.cwd();
  const resolve = (val: string) => typeof val === 'string' ? val.replace(/{{(.*?)}}/g, (_, p) => ctx[p.trim()] || '') : val;

  switch (op) {
    case 'read_json':
      const json = JSON.parse(safeReadFile(path.resolve(rootDir, resolve(params.path)), { encoding: 'utf8' }) as string);
      return { ...ctx, [params.export_as || 'last_capture_data']: json };

    case 'read_file':
      const content = safeReadFile(path.resolve(rootDir, resolve(params.path)), { encoding: 'utf8' }) as string;
      return { ...ctx, [params.export_as || 'last_capture']: content };

    case 'glob_files':
      const files = getAllFiles(path.resolve(rootDir, resolve(params.dir)))
        .filter(f => !params.ext || f.endsWith(params.ext))
        .map(f => path.relative(rootDir, f));
      return { ...ctx, [params.export_as || 'file_list']: files };

    case 'shell':
      const output = execSync(resolve(params.cmd), { encoding: 'utf8' }).trim();
      return { ...ctx, [params.export_as || 'last_capture']: output };

    default: return ctx;
  }
}

/**
 * TRANSFORM Operators
 */
async function opTransform(op: string, params: any, ctx: any) {
  const resolve = (val: string) => typeof val === 'string' ? val.replace(/{{(.*?)}}/g, (_, p) => ctx[p.trim()] || '') : val;

  switch (op) {
    case 'ajv_validate':
      const schema = ctx[params.schema_from || 'last_schema_data'];
      const data = ctx[params.data_from || 'last_capture_data'];
      const validate = ajv.compile(schema);
      const valid = validate(data);
      return { ...ctx, [params.export_as || 'is_valid']: valid, [params.errors_as || 'validation_errors']: validate.errors };

    case 'json_query':
      const sourceData = ctx[params.from || 'last_capture_data'];
      const result = params.path.split('.').reduce((o: any, i: string) => o?.[i], sourceData);
      return { ...ctx, [params.export_as]: result };

    case 'mermaid_gen':
      // Basic dependency graph generation logic
      const items = ctx[params.from || 'skills_list'] || [];
      let mermaid = 'graph TD\n';
      items.forEach((item: any) => {
        const id = item.n.replace(/-/g, '_');
        mermaid += `  ${id}["${item.n}"]\n`;
      });
      return { ...ctx, [params.export_as || 'last_transform']: mermaid };

    default: return ctx;
  }
}

/**
 * APPLY Operators
 */
async function opApply(op: string, params: any, ctx: any) {
  const rootDir = process.cwd();
  const resolve = (val: string) => typeof val === 'string' ? val.replace(/{{(.*?)}}/g, (_, p) => ctx[p.trim()] || '') : val;

  switch (op) {
    case 'write_file':
      const outPath = path.resolve(rootDir, resolve(params.path));
      const content = ctx[params.from || 'last_transform'] || ctx[params.from || 'last_capture'];
      if (!fs.existsSync(path.dirname(outPath))) safeMkdir(path.dirname(outPath), { recursive: true });
      safeWriteFile(outPath, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
      break;

    case 'log':
      logger.info(`[MODELING_LOG] ${resolve(params.message || 'Action completed')}`);
      break;
  }
}

/**
 * Strategic Reconciliation
 */
async function performReconcile(input: ModelingAction) {
  const strategyPath = path.resolve(process.cwd(), input.strategy_path || 'knowledge/governance/modeling-strategy.json');
  if (!fs.existsSync(strategyPath)) throw new Error(`Strategy not found: ${strategyPath}`);

  const config = JSON.parse(safeReadFile(strategyPath, { encoding: 'utf8' }) as string);
  for (const strategy of config.strategies) {
    await executePipeline(strategy.pipeline, strategy.params || {});
  }
  return { status: 'reconciled' };
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
