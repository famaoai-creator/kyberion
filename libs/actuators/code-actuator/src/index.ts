import { logger, safeExec, safeReadFile, safeWriteFile, safeMkdir } from '@agent/core';
import { getAllFiles } from '@agent/core/fs-utils';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as util from 'node:util';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';

/**
 * Code-Actuator v2.0.0 [ULTIMATE PIPELINE ENGINE]
 * Strictly compliant with Layer 2 (Shield).
 * Generic data pipeline engine for source code analysis, refactoring, and maintenance.
 */

interface PipelineStep {
  type: 'capture' | 'transform' | 'apply';
  op: string;
  params: any;
}

interface CodeAction {
  action: 'pipeline' | 'reconcile';
  steps?: PipelineStep[];
  strategy_path?: string;
  context?: Record<string, any>;
}

/**
 * Main Entry Point
 */
async function handleAction(input: CodeAction) {
  if (input.action === 'reconcile') {
    return await performReconcile(input);
  }
  return await executePipeline(input.steps || [], input.context || {});
}

/**
 * Universal Pipeline Engine
 */
async function executePipeline(steps: PipelineStep[], initialCtx: any = {}) {
  let ctx = { ...initialCtx, root: process.cwd() };
  const results = [];

  for (const step of steps) {
    try {
      logger.info(`  [CODE_PIPELINE] Executing ${step.type}:${step.op}...`);
      switch (step.type) {
        case 'capture': ctx = await opCapture(step.op, step.params, ctx); break;
        case 'transform': ctx = await opTransform(step.op, step.params, ctx); break;
        case 'apply': await opApply(step.op, step.params, ctx); break;
      }
      results.push({ op: step.op, status: 'success' });
    } catch (err: any) {
      logger.error(`  [CODE_PIPELINE] Step failed (${step.op}): ${err.message}`);
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
    case 'read_file':
      return { ...ctx, [params.export_as || 'last_capture']: safeReadFile(path.resolve(rootDir, resolve(params.path)), { encoding: 'utf8' }) };

    case 'glob_files':
      const files = getAllFiles(path.resolve(rootDir, resolve(params.dir)))
        .filter(f => !params.ext || f.endsWith(params.ext))
        .map(f => path.relative(rootDir, f));
      return { ...ctx, [params.export_as || 'file_list']: files };

    case 'shell':
      return { ...ctx, [params.export_as || 'last_capture']: execSync(resolve(params.cmd), { encoding: 'utf8' }).trim() };

    case 'discover_skills':
      const skillsRootDir = path.join(rootDir, 'skills');
      const skills: any[] = [];
      if (fs.existsSync(skillsRootDir)) {
        const categories = fs.readdirSync(skillsRootDir).filter(f => fs.lstatSync(path.join(skillsRootDir, f)).isDirectory());
        for (const cat of categories) {
          const catPath = path.join(skillsRootDir, cat);
          const skillDirs = fs.readdirSync(catPath).filter(f => fs.lstatSync(path.join(catPath, f)).isDirectory());
          for (const dir of skillDirs) {
            skills.push({ name: dir, path: path.join('skills', cat, dir), category: cat });
          }
        }
      }
      return { ...ctx, [params.export_as || 'skills_list']: skills };

    default: return ctx;
  }
}

/**
 * TRANSFORM Operators
 */
async function opTransform(op: string, params: any, ctx: any) {
  const resolve = (val: string) => typeof val === 'string' ? val.replace(/{{(.*?)}}/g, (_, p) => ctx[p.trim()] || '') : val;

  switch (op) {
    case 'regex_replace':
      const input = String(ctx[params.from || 'last_capture'] || '');
      return { ...ctx, [params.export_as || 'last_transform']: input.replace(new RegExp(params.pattern, 'g'), resolve(params.template)) };

    case 'json_update':
      const json = JSON.parse(ctx[params.from || 'last_capture']);
      params.updates.forEach((u: any) => { json[u.key] = resolve(u.value); });
      return { ...ctx, [params.export_as || 'last_transform']: JSON.stringify(json, null, 2) + '\n' };

    case 'run_js':
      const sandbox = { Buffer, process: { env: { ...process.env } }, console, ctx };
      vm.createContext(sandbox);
      const result = await new vm.Script(resolve(params.code)).runInContext(sandbox);
      return { ...ctx, [params.export_as || 'js_result']: result };

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
      safeWriteFile(outPath, content);
      break;

    case 'log':
      logger.info(`[CODE_LOG] ${resolve(params.message || 'Action completed')}`);
      break;
  }
}

/**
 * Strategic Reconciliation
 */
async function performReconcile(input: CodeAction) {
  const strategyPath = path.resolve(process.cwd(), input.strategy_path || 'knowledge/governance/code-strategy.json');
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
