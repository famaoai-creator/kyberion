import { logger, safeReadFile, safeWriteFile, safeExec, safeMkdir, resolveVars, evaluateCondition } from '@agent/core';
import { getAllFiles } from '@agent/core/fs-utils';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import yaml from 'js-yaml';

/**
 * Orchestrator-Actuator v2.1.0 [AUTONOMOUS CONTROL ENABLED]
 * Strictly compliant with Layer 2 (Shield).
 * Unified ADF-driven engine for Mission & Task Management with Control Flow.
 */

interface PipelineStep {
  type: 'capture' | 'transform' | 'apply' | 'control';
  op: string;
  params: any;
}

interface OrchestratorAction {
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
async function handleAction(input: OrchestratorAction) {
  if (input.action === 'reconcile') {
    return await performReconcile(input);
  }
  return await executePipeline(input.steps || [], input.context || {}, input.options);
}

/**
 * Universal Pipeline Engine with Control Flow & Safety Guards
 */
async function executePipeline(steps: PipelineStep[], initialCtx: any = {}, options: any = {}, state: any = { stepCount: 0, startTime: Date.now() }) {
  const rootDir = process.cwd();
  const MAX_STEPS = options.max_steps || 1000;
  const TIMEOUT = options.timeout_ms || 60000;

  let ctx = { ...initialCtx, root: rootDir, HOME: process.env.HOME || '/Users' };
  
  if (initialCtx.context_path && fs.existsSync(path.resolve(rootDir, initialCtx.context_path))) {
    const saved = JSON.parse(safeReadFile(path.resolve(rootDir, initialCtx.context_path), { encoding: 'utf8' }) as string);
    ctx = { ...ctx, ...saved };
  }

  const results = [];
  for (const step of steps) {
    state.stepCount++;
    if (state.stepCount > MAX_STEPS) throw new Error(`[SAFETY_LIMIT] Exceeded maximum steps (${MAX_STEPS})`);
    if (Date.now() - state.startTime > TIMEOUT) throw new Error(`[SAFETY_LIMIT] Execution timed out (${TIMEOUT}ms)`);

    try {
      logger.info(`  [ORCH_PIPELINE] [Step ${state.stepCount}] ${step.type}:${step.op}...`);
      
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
      logger.error(`  [ORCH_PIPELINE] Step failed (${step.op}): ${err.message}`);
      results.push({ op: step.op, status: 'failed', error: err.message });
      break; 
    }
  }

  if (initialCtx.context_path) {
    safeWriteFile(path.resolve(rootDir, initialCtx.context_path), JSON.stringify(ctx, null, 2));
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
  const rootDir = process.cwd();
  switch (op) {
    case 'read_json':
      return { ...ctx, [params.export_as || 'last_capture_data']: JSON.parse(safeReadFile(path.resolve(rootDir, resolveVars(params.path, ctx)), { encoding: 'utf8' }) as string) };
    case 'read_file':
      return { ...ctx, [params.export_as || 'last_capture']: safeReadFile(path.resolve(rootDir, resolveVars(params.path, ctx)), { encoding: 'utf8' }) };
    case 'shell':
      return { ...ctx, [params.export_as || 'last_capture']: safeExec(resolveVars(params.cmd, ctx)).trim() };
    case 'intent_detect':
      const mapping = yaml.load(safeReadFile(path.resolve(rootDir, resolveVars(params.mapping_path, ctx)), { encoding: 'utf8' }) as string) as any;
      const query = resolveVars(params.query, ctx).toLowerCase();
      const detected = mapping.intents.find((i: any) => i.trigger_phrases.some((p: string) => query.includes(p.toLowerCase())));
      return { ...ctx, [params.export_as || 'detected_intent']: detected };
    default: return ctx;
  }
}

/**
 * TRANSFORM Operators
 */
async function opTransform(op: string, params: any, ctx: any) {
  switch (op) {
    case 'json_query':
      const data = ctx[params.from || 'last_capture_data'];
      const result = params.path.split('.').reduce((o: any, i: string) => o?.[i], data);
      return { ...ctx, [params.export_as]: result };
    case 'variable_hydrate':
      const input = typeof ctx[params.from] === 'object' ? JSON.stringify(ctx[params.from]) : String(ctx[params.from]);
      const hydrated = resolveVars(input, ctx);
      return { ...ctx, [params.export_as || 'last_transform']: params.is_json ? JSON.parse(hydrated) : hydrated };
    default: return ctx;
  }
}

/**
 * APPLY Operators
 */
async function opApply(op: string, params: any, ctx: any) {
  const rootDir = process.cwd();
  switch (op) {
    case 'write_file':
      const out = path.resolve(rootDir, resolveVars(params.path, ctx));
      const content = ctx[params.from || 'last_transform'] || ctx[params.from || 'last_capture'];
      if (!fs.existsSync(path.dirname(out))) safeMkdir(path.dirname(out), { recursive: true });
      safeWriteFile(out, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
      break;
    case 'mkdir': safeMkdir(path.resolve(rootDir, resolveVars(params.path, ctx)), { recursive: true }); break;
    case 'symlink':
      const target = path.resolve(rootDir, resolveVars(params.target, ctx));
      const source = path.resolve(rootDir, resolveVars(params.source, ctx));
      if (fs.existsSync(target)) fs.unlinkSync(target);
      if (!fs.existsSync(path.dirname(target))) safeMkdir(path.dirname(target), { recursive: true });
      fs.symlinkSync(path.relative(path.dirname(target), source), target, params.type || 'dir');
      break;
    case 'git_checkpoint':
      safeExec('git', ['add', '.'], { cwd: rootDir });
      safeExec('git', ['commit', '-m', resolveVars(params.message || 'checkpoint', ctx)], { cwd: rootDir });
      break;
    case 'log': logger.info(`[ORCH_LOG] ${resolveVars(params.message || 'Action completed', ctx)}`); break;
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
    await executePipeline(strategy.pipeline, strategy.params || {}, input.options);
  }
  return { status: 'reconciled' };
}

/**
 * CLI Runner
 */
const main = async () => {
  const argv = await createStandardYargs().option('input', { alias: 'i', type: 'string', required: true }).parseSync();
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
