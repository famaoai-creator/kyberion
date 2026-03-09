import { logger, safeReadFile, safeWriteFile, safeExec, safeReaddir, safeStat, safeUnlink, safeMkdir } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * File-Actuator v2.0.0 [PIPELINE DRIVEN]
 * Strictly compliant with Layer 2 (Shield).
 * A pure ADF-driven engine for high-fidelity filesystem operations.
 */

interface PipelineStep {
  type: 'capture' | 'transform' | 'apply';
  op: string;
  params: any;
}

interface FileAction {
  action: 'pipeline';
  steps: PipelineStep[];
  context?: Record<string, any>;
}

/**
 * Main Entry Point
 */
async function handleAction(input: FileAction) {
  if (input.action !== 'pipeline') {
    throw new Error(`Unsupported action: ${input.action}. File-Actuator v2.0 is pure pipeline-driven.`);
  }
  return await executePipeline(input.steps || [], input.context || {});
}

/**
 * Universal File Pipeline Engine
 */
async function executePipeline(steps: PipelineStep[], initialCtx: any = {}) {
  let ctx = { ...initialCtx, root: process.cwd() };
  const results = [];

  for (const step of steps) {
    try {
      logger.info(`  [FILE_PIPELINE] Executing ${step.type}:${step.op}...`);
      switch (step.type) {
        case 'capture': ctx = await opCapture(step.op, step.params, ctx); break;
        case 'transform': ctx = await opTransform(step.op, step.params, ctx); break;
        case 'apply': await opApply(step.op, step.params, ctx); break;
      }
      results.push({ op: step.op, status: 'success' });
    } catch (err: any) {
      logger.error(`  [FILE_PIPELINE] Step failed (${step.op}): ${err.message}`);
      results.push({ op: step.op, status: 'failed', error: err.message });
      break; 
    }
  }
  return { status: 'finished', results, final_context_keys: Object.keys(ctx) };
}

/**
 * CAPTURE Operators: Bring filesystem data INTO the context
 */
async function opCapture(op: string, params: any, ctx: any) {
  const rootDir = process.cwd();
  const resolve = (val: string) => typeof val === 'string' ? val.replace(/{{(.*?)}}/g, (_, p) => ctx[p.trim()] || '') : val;

  switch (op) {
    case 'read':
      const content = safeReadFile(path.resolve(rootDir, resolve(params.path)), { encoding: 'utf8' }) as string;
      return { ...ctx, [params.export_as || 'last_capture']: content };

    case 'list':
      const files = safeReaddir(path.resolve(rootDir, resolve(params.path)));
      return { ...ctx, [params.export_as || 'file_list']: files };

    case 'stat':
      const s = safeStat(path.resolve(rootDir, resolve(params.path)));
      const metadata = { size: s.size, mtime: s.mtime, isDirectory: s.isDirectory(), isFile: s.isFile() };
      return { ...ctx, [params.export_as || 'last_stat']: metadata };

    case 'search':
      // Optimized search via ripgrep
      const searchPath = path.resolve(rootDir, resolve(params.path));
      const rgOutput = safeExec('rg', ['--json', resolve(params.pattern), searchPath]);
      return { ...ctx, [params.export_as || 'search_results']: JSON.parse(rgOutput) };

    case 'tail':
      const tailPath = path.resolve(rootDir, resolve(params.path));
      const stats = safeStat(tailPath);
      const lastPos = ctx[params.pos_key || 'last_pos'] || 0;
      const fullText = safeReadFile(tailPath, { encoding: 'utf8' }) as string;
      return { 
        ...ctx, 
        [params.export_as || 'last_capture']: fullText.substring(lastPos),
        [params.pos_key || 'last_pos']: stats.size 
      };

    default: return ctx;
  }
}

/**
 * TRANSFORM Operators: Mutate data in the context
 */
async function opTransform(op: string, params: any, ctx: any) {
  const resolve = (val: string) => typeof val === 'string' ? val.replace(/{{(.*?)}}/g, (_, p) => ctx[p.trim()] || '') : val;

  switch (op) {
    case 'regex_replace':
      const input = ctx[params.from || 'last_capture'] || '';
      const regex = new RegExp(params.pattern, 'g');
      return { ...ctx, [params.export_as || 'last_transform']: input.replace(regex, resolve(params.template)) };

    case 'json_parse':
      return { ...ctx, [params.export_as || 'last_capture_data']: JSON.parse(ctx[params.from || 'last_capture']) };

    case 'path_join':
      return { ...ctx, [params.export_as]: path.join(...params.parts.map(resolve)) };

    default: return ctx;
  }
}

/**
 * APPLY Operators: Push data OUT to the filesystem
 */
async function opApply(op: string, params: any, ctx: any) {
  const rootDir = process.cwd();
  const resolve = (val: string) => typeof val === 'string' ? val.replace(/{{(.*?)}}/g, (_, p) => ctx[p.trim()] || '') : val;

  switch (op) {
    case 'write':
      const outPath = path.resolve(rootDir, resolve(params.path));
      const content = ctx[params.from || 'last_transform'] || ctx[params.from || 'last_capture'] || params.content;
      safeWriteFile(outPath, content);
      break;

    case 'delete':
      const target = path.resolve(rootDir, resolve(params.path));
      const s = safeStat(target);
      if (s.isDirectory()) {
        safeExec('rm', ['-rf', target]);
      } else {
        safeUnlink(target);
      }
      break;

    case 'mkdir':
      safeMkdir(path.resolve(rootDir, resolve(params.path)), { recursive: true });
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
