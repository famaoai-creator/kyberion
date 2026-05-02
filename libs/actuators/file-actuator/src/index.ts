import {
  logger, 
  safeReadFile, 
  safeWriteFile, 
  safeMkdir, 
  safeExistsSync,
  safeExec, 
  safeStat, 
  safeReaddir,
  safeAppendFileSync,
  safeCopyFileSync,
  safeMoveSync,
  safeRmSync,
  derivePipelineStatus,
  pathResolver,
  resolveVars,
  evaluateCondition,
  resolveWriteArtifactSpec
} from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * File-Actuator v2.1.1 [RESILIENT PIPELINE]
 * Strictly compliant with Layer 2 (Shield).
 * A pure ADF-driven engine for filesystem operations with Control Flow and Safety Guards.
 * Restored specialized ops: tail, append, exists, copy, move.
 */

interface PipelineStep {
  type: 'capture' | 'transform' | 'apply' | 'control';
  op: string;
  params: any;
}

interface FileAction {
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
async function handleAction(input: FileAction) {
  if (input.action !== 'pipeline') {
    throw new Error(`Unsupported action: ${input.action}. File-Actuator v2.1 is pure pipeline-driven.`);
  }
  return await executePipeline(input.steps || [], input.context || {}, input.options);
}

/**
 * Universal File Pipeline Engine
 */
async function executePipeline(steps: PipelineStep[], initialCtx: any = {}, options: any = {}, state: any = { stepCount: 0, startTime: Date.now() }) {
  const rootDir = pathResolver.rootDir();
  const MAX_STEPS = options.max_steps || 1000;
  const TIMEOUT = options.timeout_ms || 60000;

  let ctx = { ...initialCtx, root: rootDir };
  
  if (initialCtx.context_path && safeExistsSync(path.resolve(rootDir, initialCtx.context_path))) {
    const saved = JSON.parse(safeReadFile(path.resolve(rootDir, initialCtx.context_path), { encoding: 'utf8' }) as string);
    ctx = { ...ctx, ...saved };
  }

  const resolve = (val: any) => resolveVars(val, ctx);

  const results = [];
  for (const step of steps) {
    state.stepCount++;
    if (state.stepCount > MAX_STEPS) throw new Error(`[SAFETY_LIMIT] Exceeded maximum pipeline steps (${MAX_STEPS})`);
    if (Date.now() - state.startTime > TIMEOUT) throw new Error(`[SAFETY_LIMIT] Pipeline execution timed out (${TIMEOUT}ms)`);

    try {
      logger.info(`  [FILE_PIPELINE] [Step ${state.stepCount}] ${step.type}:${step.op}...`);
      
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
      logger.error(`  [FILE_PIPELINE] Step failed (${step.op}): ${err.message}`);
      results.push({ op: step.op, status: 'failed', error: err.message });
      break; 
    }
  }

  if (initialCtx.context_path) {
    safeWriteFile(path.resolve(rootDir, initialCtx.context_path), JSON.stringify(ctx, null, 2));
  }

  return { status: derivePipelineStatus(results), results, context: ctx, total_steps: state.stepCount };
}

/**
 * CONTROL Operators
 */
async function opControl(op: string, params: any, ctx: any, options: any, state: any, resolve: (value: any) => any) {
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
async function opCapture(op: string, params: any, ctx: any, resolve: (value: any) => any) {
  const rootDir = pathResolver.rootDir();
  switch (op) {
    case 'read':
      return { ...ctx, [params.export_as || 'last_capture']: safeReadFile(path.resolve(rootDir, resolve(params.path)), { encoding: 'utf8' }) };
    case 'list':
      return { ...ctx, [params.export_as || 'file_list']: safeReaddir(path.resolve(rootDir, resolve(params.path))) };
    case 'stat':
      const s = safeStat(path.resolve(rootDir, resolve(params.path)));
      return { ...ctx, [params.export_as || 'last_stat']: { size: s.size, mtime: s.mtime, isFile: s.isFile(), isDirectory: s.isDirectory() } };
    case 'exists':
      return { ...ctx, [params.export_as || 'exists']: safeExistsSync(path.resolve(rootDir, resolve(params.path))) };
    case 'search': {
      const pattern = resolve(params.pattern);
      const targetPath = path.resolve(rootDir, resolve(params.path));
      const rgOutput = safeExec('rg', ['--json', String(pattern), targetPath], { encoding: 'utf8' });
      return { ...ctx, [params.export_as || 'search_results']: JSON.parse(rgOutput) };
    }
    case 'tail': {
      const tailPath = path.resolve(rootDir, resolve(params.path));
      const stats = safeStat(tailPath);
      const posKey = params.pos_key || 'last_pos';
      const lastPos = ctx[posKey] || 0;
      const fullText = safeReadFile(tailPath, { encoding: 'utf8' }) as string;
      const newText = fullText.substring(lastPos);
      return { ...ctx, [params.export_as || 'last_capture']: newText, [posKey]: stats.size };
    }
    default: return ctx;
  }
}

/**
 * TRANSFORM Operators
 */
async function opTransform(op: string, params: any, ctx: any, resolve: (value: any) => any) {
  switch (op) {
    case 'regex_replace':
      return { ...ctx, [params.export_as || 'last_transform']: String(ctx[params.from || 'last_capture'] || '').replace(new RegExp(params.pattern, 'g'), resolve(params.template)) };
    case 'json_parse':
      return { ...ctx, [params.export_as || 'last_capture_data']: JSON.parse(ctx[params.from || 'last_capture']) };
    case 'path_join':
      return { ...ctx, [params.export_as]: path.join(...params.parts.map((p: string) => resolve(p))) };
    default: return ctx;
  }
}

/**
 * APPLY Operators
 */
async function opApply(op: string, params: any, ctx: any, resolve: (value: any) => any) {
  const rootDir = pathResolver.rootDir();
  switch (op) {
    case 'write': {
      const out = path.resolve(rootDir, resolve(params.path));
      const content = ctx[params.from || 'last_transform'] || ctx[params.from || 'last_capture'] || resolve(params.content);
      safeWriteFile(out, content);
      break;
    }
    case 'write_file':
    case 'write_artifact': {
      const spec = resolveWriteArtifactSpec(params, ctx, resolve);
      const out = path.resolve(rootDir, spec.path);
      const content = typeof spec.content === 'string' ? spec.content : spec.content === undefined ? '' : JSON.stringify(spec.content, null, 2);
      if (!safeExistsSync(path.dirname(out))) safeMkdir(path.dirname(out), { recursive: true });
      safeWriteFile(out, content);
      break;
    }
    case 'append': {
      const out = path.resolve(rootDir, resolve(params.path));
      const content = ctx[params.from || 'last_transform'] || ctx[params.from || 'last_capture'] || resolve(params.content);
      const payload = content + (params.newline !== false ? '\n' : '');
      safeAppendFileSync(out, payload);
      break;
    }
    case 'delete': {
      const target = path.resolve(rootDir, resolve(params.path));
      safeRmSync(target, { recursive: true, force: true });
      break;
    }
    case 'mkdir': safeMkdir(path.resolve(rootDir, resolve(params.path)), { recursive: true }); break;
    case 'copy': {
      const src = path.resolve(rootDir, resolve(params.from));
      const dest = path.resolve(rootDir, resolve(params.to));
      if (!safeExistsSync(path.dirname(dest))) safeMkdir(path.dirname(dest), { recursive: true });
      safeCopyFileSync(src, dest);
      break;
    }
    case 'move': {
      const src = path.resolve(rootDir, resolve(params.from));
      const dest = path.resolve(rootDir, resolve(params.to));
      if (!safeExistsSync(path.dirname(dest))) safeMkdir(path.dirname(dest), { recursive: true });
      safeMoveSync(src, dest);
      break;
    }
  }
}

/**
 * CLI Runner
 */
const main = async () => {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();
  const inputContent = safeReadFile(path.resolve(pathResolver.rootDir(), argv.input as string), { encoding: 'utf8' }) as string;
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
