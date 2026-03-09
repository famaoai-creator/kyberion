import { logger, safeReadFile, safeWriteFile, safeMkdir } from '@agent/core';
import { getAllFiles } from '@agent/core/fs-utils';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import * as yaml from 'js-yaml';

/**
 * Wisdom-Actuator v2.1.0 [AUTONOMOUS CONTROL ENABLED]
 * Strictly compliant with Layer 2 (Shield).
 * A pure ADF-driven engine for the Wisdom domain with Control Flow and Safety Guards.
 */

interface PipelineStep {
  type: 'capture' | 'transform' | 'apply' | 'control';
  op: string;
  params: any;
}

interface WisdomAction {
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
async function handleAction(input: WisdomAction) {
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

  let ctx = { ...initialCtx, today: new Date().toISOString().split('T')[0] };
  
  if (initialCtx.context_path && fs.existsSync(path.resolve(rootDir, initialCtx.context_path))) {
    const saved = JSON.parse(safeReadFile(path.resolve(rootDir, initialCtx.context_path), { encoding: 'utf8' }) as string);
    ctx = { ...ctx, ...saved };
  }

      const resolve = (val: any) => {
    if (typeof val !== 'string') return val;
    
    // 単一の変数参照 "{{var}}" の場合は、型を維持して生データを返す
    const singleVarMatch = val.match(/^{{(.*?)}}$/);
    if (singleVarMatch) {
      const parts = singleVarMatch[1].trim().split('.');
      let current = ctx;
      for (const part of parts) { current = current?.[part]; }
      return current !== undefined ? current : '';
    }

    // 文字列混在の場合は従来通り文字列展開
    return val.replace(/{{(.*?)}}/g, (_, p) => {
      const parts = p.trim().split('.');
      let current = ctx;
      for (const part of parts) { current = current?.[part]; }
      return current !== undefined ? (typeof current === 'object' ? JSON.stringify(current) : String(current)) : '';
    });
  };

  const results = [];
  for (const step of steps) {
    state.stepCount++;
    if (state.stepCount > MAX_STEPS) throw new Error(`[SAFETY_LIMIT] Exceeded maximum pipeline steps (${MAX_STEPS})`);
    if (Date.now() - state.startTime > TIMEOUT) throw new Error(`[SAFETY_LIMIT] Pipeline execution timed out (${TIMEOUT}ms)`);

    try {
      logger.info(`  [WISDOM_PIPELINE] [Step ${state.stepCount}] ${step.type}:${step.op}...`);
      
      if (step.type === 'control') {
        ctx = await opControl(step.op, step.params, ctx, options, state, resolve);
      } else {
        switch (step.type) {
          case 'capture': ctx = await opCapture(step.op, step.params, ctx, resolve); break;
          case 'transform': ctx = await opTransform(step.op, step.params, ctx, resolve); break;
          case 'apply': await opApply(step.op, step.params, ctx, resolve); break;
        }
      }
      results.push({ op: step.op, status: 'success' });
    } catch (err: any) {
      logger.error(`  [WISDOM_PIPELINE] Step failed (${step.op}): ${err.message}`);
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
async function opControl(op: string, params: any, ctx: any, options: any, state: any, resolve: Function) {
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

function evaluateCondition(cond: any, ctx: any): boolean {
  if (!cond) return true;
  const parts = cond.from.split('.');
  let val = ctx;
  for (const part of parts) { val = val?.[part]; }
  
  switch (cond.operator) {
    case 'exists': return val !== undefined && val !== null;
    case 'not_exists': return val === undefined || val === null;
    case 'empty': return Array.isArray(val) ? val.length === 0 : !val;
    case 'not_empty': return Array.isArray(val) ? val.length > 0 : !!val;
    case 'eq': return val === cond.value;
    case 'ne': return val !== cond.value;
    default: return !!val;
  }
}

/**
 * CAPTURE Operators
 */
async function opCapture(op: string, params: any, ctx: any, resolve: Function) {
  const rootDir = process.cwd();
  switch (op) {
    case 'shell':
      return { ...ctx, [params.export_as || 'last_capture']: execSync(resolve(params.cmd), { encoding: 'utf8' }).trim() };
    case 'read_file':
      return { ...ctx, [params.export_as || 'last_capture']: safeReadFile(path.resolve(rootDir, resolve(params.path)), { encoding: 'utf8' }) };
    case 'read_json':
      return { ...ctx, [params.export_as || 'last_capture_data']: JSON.parse(safeReadFile(path.resolve(rootDir, resolve(params.path)), { encoding: 'utf8' }) as string) };
    case 'glob_files':
      return { ...ctx, [params.export_as || 'file_list']: getAllFiles(path.resolve(rootDir, resolve(params.dir))).filter(f => !params.ext || f.endsWith(params.ext)).map(f => path.relative(rootDir, f)) };
    default: return ctx;
  }
}

/**
 * TRANSFORM Operators
 */
async function opTransform(op: string, params: any, ctx: any, resolve: Function) {
  switch (op) {
    case 'regex_extract': {
      const input = String(ctx[params.from || 'last_capture'] || '');
      const regex = new RegExp(params.pattern, params.count_all ? 'gm' : 'm');
      if (params.count_all) {
        return { ...ctx, [params.export_as]: (input.match(regex) || []).length };
      }
      const match = input.match(regex);
      return { ...ctx, [params.export_as]: match ? match[1] || match[0] : null };
    }
    case 'regex_replace': {
      const input = String(ctx[params.from || 'last_capture'] || '');
      return { ...ctx, [params.export_as || 'last_transform']: input.replace(new RegExp(params.pattern, 'g'), resolve(params.template)) };
    }
    case 'yaml_update': {
      const content = String(ctx[params.from || 'last_capture'] || '');
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/m);
      if (!fmMatch) return ctx;
      const fm = yaml.load(fmMatch[1]) as any;
      fm[params.field] = resolve(params.value);
      const newFm = yaml.dump(fm, { lineWidth: -1 }).trim();
      return { ...ctx, [params.export_as || 'last_transform']: content.replace(/^---\n[\s\S]*?\n---/m, `---\n${newFm}\n---`) };
    }
    case 'json_query': {
      const data = ctx[params.from || 'last_capture_data'];
      const result = params.path.split('.').reduce((o: any, i: string) => o?.[i], data);
      return { ...ctx, [params.export_as]: result };
    }
    case 'array_count': {
      const list = ctx[params.from] || [];
      const count = list.filter((item: any) => {
        return !params.where || Object.entries(params.where).every(([k, v]) => item[k] === v);
      }).length;
      return { ...ctx, [params.export_as]: count };
    }
    default: return ctx;
  }
}

/**
 * APPLY Operators
 */
async function opApply(op: string, params: any, ctx: any, resolve: Function) {
  const rootDir = process.cwd();
  switch (op) {
    case 'write_file':
      const out = path.resolve(rootDir, resolve(params.path));
      const content = ctx[params.from || 'last_transform'] || ctx[params.from || 'last_capture'];
      if (!fs.existsSync(path.dirname(out))) safeMkdir(path.dirname(out), { recursive: true });
      safeWriteFile(out, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
      break;
    case 'log': logger.info(`[WISDOM_LOG] ${resolve(params.message || 'Action completed')}`); break;
  }
}

/**
 * Strategic Reconciliation
 */
async function performReconcile(input: WisdomAction) {
  const strategyPath = path.resolve(process.cwd(), input.strategy_path || 'knowledge/governance/wisdom-reconcile-strategy.json');
  if (!fs.existsSync(strategyPath)) throw new Error(`Strategy not found: ${strategyPath}`);
  const config = JSON.parse(safeReadFile(strategyPath, { encoding: 'utf8' }) as string);
  for (const strategy of config.strategies) {
    if (strategy.for_each) {
      const listCtx = await opCapture(strategy.for_each.op, strategy.for_each.params, {}, (v: any) => v);
      const list = listCtx[strategy.for_each.params.export_as] || [];
      for (const item of list) {
        await executePipeline(strategy.pipeline, { ...strategy.params, item }, input.options);
      }
    } else {
      await executePipeline(strategy.pipeline, strategy.params || {}, input.options);
    }
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
