import { logger, safeReadFile, safeWriteFile, safeMkdir } from '@agent/core';
import { getAllFiles } from '@agent/core/fs-utils';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import * as yaml from 'js-yaml';

/**
 * Wisdom-Actuator v2.0.0 [ULTIMATE PIPELINE ENGINE]
 * Strictly compliant with Layer 2 (Shield).
 * A pure ADF-driven engine that executes data pipelines for the Wisdom domain.
 * Zero hardcoded domain logic; all behaviors are defined in ADF contracts.
 */

interface PipelineStep {
  type: 'capture' | 'transform' | 'apply';
  op: string;
  params: any;
}

interface WisdomAction {
  action: 'pipeline' | 'reconcile';
  steps?: PipelineStep[];
  strategy_path?: string;
  context?: Record<string, any>;
}

/**
 * Main Entry Point
 */
async function handleAction(input: WisdomAction) {
  if (input.action === 'reconcile') {
    return await performReconcile(input);
  }
  return await executePipeline(input.steps || [], input.context || {});
}

/**
 * Universal Pipeline Engine
 */
async function executePipeline(steps: PipelineStep[], initialCtx: any = {}) {
  const rootDir = process.cwd();
  let ctx = { ...initialCtx, today: new Date().toISOString().split('T')[0] };
  
  // Load persistent context if provided
  if (initialCtx.context_path && fs.existsSync(path.resolve(rootDir, initialCtx.context_path))) {
    const saved = JSON.parse(safeReadFile(path.resolve(rootDir, initialCtx.context_path), { encoding: 'utf8' }) as string);
    ctx = { ...ctx, ...saved };
  }

  const results = [];
  for (const step of steps) {
    try {
      logger.info(`  [PIPELINE] Executing ${step.type}:${step.op}...`);
      switch (step.type) {
        case 'capture': ctx = await opCapture(step.op, step.params, ctx); break;
        case 'transform': ctx = await opTransform(step.op, step.params, ctx); break;
        case 'apply': await opApply(step.op, step.params, ctx); break;
      }
      results.push({ op: step.op, status: 'success' });
    } catch (err: any) {
      logger.error(`  [PIPELINE] Step failed (${step.op}): ${err.message}`);
      results.push({ op: step.op, status: 'failed', error: err.message });
      break; 
    }
  }

  // Persist context if requested
  if (initialCtx.context_path) {
    safeWriteFile(path.resolve(rootDir, initialCtx.context_path), JSON.stringify(ctx, null, 2));
  }

  return { status: 'finished', results, final_context_keys: Object.keys(ctx) };
}

/**
 * CAPTURE Operators: Bring data INTO the context
 */
async function opCapture(op: string, params: any, ctx: any) {
  const rootDir = process.cwd();
  const resolve = (val: string) => val.replace(/{{(.*?)}}/g, (_, p) => ctx[p.trim()] || '');

  switch (op) {
    case 'shell':
      const output = execSync(resolve(params.cmd), { encoding: 'utf8' }).trim();
      return { ...ctx, [params.export_as || 'last_capture']: output };

    case 'read_file':
      const content = safeReadFile(path.resolve(rootDir, resolve(params.path)), { encoding: 'utf8' }) as string;
      return { ...ctx, [params.export_as || 'last_capture']: content };

    case 'read_json':
      const json = JSON.parse(safeReadFile(path.resolve(rootDir, resolve(params.path)), { encoding: 'utf8' }) as string);
      return { ...ctx, [params.export_as || 'last_capture_data']: json };

    case 'glob_files':
      const files = getAllFiles(path.resolve(rootDir, resolve(params.dir)))
        .filter(f => !params.ext || f.endsWith(params.ext))
        .map(f => path.relative(rootDir, f));
      return { ...ctx, [params.export_as || 'file_list']: files };

    default: return ctx;
  }
}

/**
 * TRANSFORM Operators: Mutate data in the context
 */
async function opTransform(op: string, params: any, ctx: any) {
  const resolve = (val: string) => typeof val === 'string' ? val.replace(/{{(.*?)}}/g, (_, p) => ctx[p.trim()] || '') : val;

  switch (op) {
    case 'regex_extract': {
      const input = ctx[params.from || 'last_capture'] || '';
      const regex = new RegExp(params.pattern, 'gm');
      if (params.count_all) {
        const count = (input.match(regex) || []).length;
        return { ...ctx, [params.export_as]: count };
      }
      const match = input.match(new RegExp(params.pattern, 'm'));
      return { ...ctx, [params.export_as]: match ? match[1] : null };
    }

    case 'regex_replace': {
      const input = ctx[params.from || 'last_capture'] || '';
      const regex = new RegExp(params.pattern, 'g');
      const replacement = resolve(params.template);
      return { ...ctx, [params.export_as || 'last_transform']: input.replace(regex, replacement) };
    }

    case 'yaml_update': {
      const content = ctx[params.from || 'last_capture'] || '';
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/m);
      if (!fmMatch) return ctx;
      const fm = yaml.load(fmMatch[1]) as any;
      fm[params.field] = resolve(params.value) || ctx.last_capture;
      const newFm = yaml.dump(fm, { lineWidth: -1 }).trim();
      const updated = content.replace(/^---\n[\s\S]*?\n---/m, `---\n${newFm}\n---`);
      return { ...ctx, [params.export_as || 'last_transform']: updated };
    }

    case 'json_query': {
      const data = ctx[params.from || 'last_capture_data'];
      const result = params.path.split('.').reduce((o: any, i: string) => o?.[i], data);
      return { ...ctx, [params.export_as]: result };
    }

    case 'array_filter': {
      const list = ctx[params.from] || [];
      const result = list.filter((item: any) => {
        return Object.entries(params.where).every(([k, v]) => item[k] === v);
      });
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
 * APPLY Operators: Push data OUT of the context
 */
async function opApply(op: string, params: any, ctx: any) {
  const rootDir = process.cwd();
  const resolve = (val: string) => typeof val === 'string' ? val.replace(/{{(.*?)}}/g, (_, p) => ctx[p.trim()] || '') : val;

  switch (op) {
    case 'write_file':
      const outPath = path.resolve(rootDir, resolve(params.path));
      const content = ctx[params.from || 'last_transform'] || ctx[params.from || 'last_capture'];
      safeWriteFile(outPath, content);
      break;

    case 'log':
      logger.info(`[PIPELINE_LOG] ${resolve(params.message || '{{last_capture}}')}`);
      break;
  }
}

/**
 * Strategic Reconciliation (Orchestrates multiple pipelines)
 */
async function performReconcile(input: WisdomAction) {
  const strategyPath = path.resolve(process.cwd(), input.strategy_path || 'knowledge/governance/wisdom-reconcile-strategy.json');
  if (!fs.existsSync(strategyPath)) throw new Error(`Reconciliation Strategy not found: ${strategyPath}`);

  const config = JSON.parse(safeReadFile(strategyPath, { encoding: 'utf8' }) as string);
  const results: any[] = [];
  logger.info(`🧘 [WISDOM] Reconciling ecosystem via ${config.strategies.length} strategies...`);

  for (const strategy of config.strategies) {
    logger.info(`▶️ Strategy: ${strategy.id}`);
    let strategyResult;
    
    if (strategy.for_each) {
      const listCtx = await opCapture(strategy.for_each.op, strategy.for_each.params, {});
      const list = listCtx[strategy.for_each.params.export_as] || [];
      const itemResults = [];
      for (const item of list) {
        const res = await executePipeline(strategy.pipeline, { ...strategy.params, item, file: item, rel_file: item });
        itemResults.push({ item, status: res.status });
      }
      strategyResult = { id: strategy.id, type: 'for_each', count: list.length, items: itemResults };
    } else {
      const res = await executePipeline(strategy.pipeline, strategy.params || {});
      strategyResult = { id: strategy.id, type: 'single', status: res.status, pipeline_results: res.results };
    }
    results.push(strategyResult);
  }
  return { status: 'reconciled', strategies: results };
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
