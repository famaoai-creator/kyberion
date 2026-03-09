import { logger, safeReadFile, safeWriteFile, safeExec, safeMkdir } from '@agent/core';
import { getAllFiles } from '@agent/core/fs-utils';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import yaml from 'js-yaml';

/**
 * Orchestrator-Actuator v2.0.0 [ULTIMATE PIPELINE ENGINE]
 * Strictly compliant with Layer 2 (Shield).
 * Unified ADF-driven engine for Mission & Task Management.
 * Zero hardcoded domain logic; all behaviors are defined in ADF contracts.
 */

interface PipelineStep {
  type: 'capture' | 'transform' | 'apply';
  op: string;
  params: any;
}

interface OrchestratorAction {
  action: 'pipeline' | 'reconcile';
  steps?: PipelineStep[];
  strategy_path?: string;
  context?: Record<string, any>;
}

/**
 * Main Entry Point
 */
async function handleAction(input: OrchestratorAction) {
  if (input.action === 'reconcile') {
    return await performReconcile(input);
  }
  return await executePipeline(input.steps || [], input.context || {});
}

/**
 * Universal Pipeline Engine
 */
async function executePipeline(steps: PipelineStep[], initialCtx: any = {}) {
  let ctx = { ...initialCtx, root: process.cwd(), HOME: process.env.HOME || '/Users' };
  const results = [];

  for (const step of steps) {
    try {
      logger.info(`  [ORCH_PIPELINE] Executing ${step.type}:${step.op}...`);
      switch (step.type) {
        case 'capture': ctx = await opCapture(step.op, step.params, ctx); break;
        case 'transform': ctx = await opTransform(step.op, step.params, ctx); break;
        case 'apply': await opApply(step.op, step.params, ctx); break;
      }
      results.push({ op: step.op, status: 'success' });
    } catch (err: any) {
      logger.error(`  [ORCH_PIPELINE] Step failed (${step.op}): ${err.message}`);
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

    case 'shell':
      const output = execSync(resolve(params.cmd), { encoding: 'utf8' }).trim();
      return { ...ctx, [params.export_as || 'last_capture']: output };

    case 'intent_detect':
      // Simplified intent gateway logic
      const mapping = yaml.load(safeReadFile(path.resolve(rootDir, resolve(params.mapping_path)), { encoding: 'utf8' }) as string) as any;
      const query = resolve(params.query).toLowerCase();
      const detected = mapping.intents.find((i: any) => i.trigger_phrases.some((p: string) => query.includes(p.toLowerCase())));
      return { ...ctx, [params.export_as || 'detected_intent']: detected };

    default: return ctx;
  }
}

/**
 * TRANSFORM Operators
 */
async function opTransform(op: string, params: any, ctx: any) {
  const resolve = (val: string) => typeof val === 'string' ? val.replace(/{{(.*?)}}/g, (_, p) => ctx[p.trim()] || '') : val;

  switch (op) {
    case 'json_query':
      const sourceData = ctx[params.from || 'last_capture_data'];
      const result = params.path.split('.').reduce((o: any, i: string) => o?.[i], sourceData);
      return { ...ctx, [params.export_as]: result };

    case 'variable_hydrate':
      const input = typeof ctx[params.from] === 'object' ? JSON.stringify(ctx[params.from]) : String(ctx[params.from]);
      const hydrated = input.replace(/{{(.*?)}}/g, (_, p) => ctx[p.trim()] || '');
      return { ...ctx, [params.export_as || 'last_transform']: params.is_json ? JSON.parse(hydrated) : hydrated };

    case 'regex_extract':
      const text = String(ctx[params.from || 'last_capture'] || '');
      const match = text.match(new RegExp(params.pattern, 'm'));
      return { ...ctx, [params.export_as]: match ? match[1] : null };

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

    case 'mkdir':
      safeMkdir(path.resolve(rootDir, resolve(params.path)), { recursive: true });
      break;

    case 'symlink':
      const target = path.resolve(rootDir, resolve(params.target));
      const source = path.resolve(rootDir, resolve(params.source));
      if (fs.existsSync(target)) fs.unlinkSync(target);
      if (!fs.existsSync(path.dirname(target))) safeMkdir(path.dirname(target), { recursive: true });
      fs.symlinkSync(path.relative(path.dirname(target), source), target, params.type || 'dir');
      break;

    case 'git_checkpoint':
      const msg = resolve(params.message || 'checkpoint: state preservation');
      execSync('git add .');
      execSync(`git commit -m "${msg.replace(/"/g, '\\"')}"`);
      break;

    case 'log':
      logger.info(`[ORCH_LOG] ${resolve(params.message || 'Action completed')}`);
      break;
  }
}

/**
 * Strategic Reconciliation
 */
async function performReconcile(input: OrchestratorAction) {
  const strategyPath = path.resolve(process.cwd(), input.strategy_path || 'knowledge/governance/orchestration-strategy.json');
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
