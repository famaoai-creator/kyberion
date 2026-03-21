import { 
  logger, 
  safeReadFile, 
  safeWriteFile, 
  safeMkdir, 
  safeExec, 
  safeExistsSync,
  pathResolver,
  resolveVars,
  evaluateCondition,
  withRetry,
  derivePipelineStatus
} from '@agent/core';
import { getAllFiles } from '@agent/core/fs-utils';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

/**
 * Wisdom-Actuator v2.2.0 [DYNAMIC KNOWLEDGE ENABLED]
 * Pure ADF-driven engine for the Wisdom domain with Dynamic Context Injection.
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
 * Universal Pipeline Engine
 */
async function executePipeline(steps: PipelineStep[], initialCtx: any = {}, options: any = {}, state: any = { stepCount: 0, startTime: Date.now() }) {
  const rootDir = pathResolver.rootDir();
  const MAX_STEPS = options.max_steps || 1000;
  const TIMEOUT = options.timeout_ms || 60000;

  let ctx = { ...initialCtx, today: new Date().toISOString().split('T')[0] };
  
  if (initialCtx.context_path && safeExistsSync(pathResolver.rootResolve(initialCtx.context_path))) {
    const saved = JSON.parse(safeReadFile(pathResolver.rootResolve(initialCtx.context_path), { encoding: 'utf8' }) as string);
    ctx = { ...ctx, ...saved };
  }

  const results = [];
  for (const step of steps) {
    state.stepCount++;
    if (state.stepCount > MAX_STEPS) throw new Error(`[SAFETY_LIMIT] Exceeded maximum pipeline steps (${MAX_STEPS})`);
    if (Date.now() - state.startTime > TIMEOUT) throw new Error(`[SAFETY_LIMIT] Pipeline execution timed out (${TIMEOUT}ms)`);

    try {
      logger.info(`  [WISDOM_PIPELINE] [Step ${state.stepCount}] ${step.type}:${step.op}...`);
      
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
      logger.error(`  [WISDOM_PIPELINE] Step failed (${step.op}): ${err.message}`);
      results.push({ op: step.op, status: 'failed', error: err.message });
      break; 
    }
  }

  if (initialCtx.context_path) {
    safeWriteFile(pathResolver.rootResolve(initialCtx.context_path), JSON.stringify(ctx, null, 2));
  }

  return { status: derivePipelineStatus(results), results, context: ctx, total_steps: state.stepCount };
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
    case 'shell':
      const cmd = resolveVars(params.cmd, ctx);
      return { ...ctx, [params.export_as || 'last_capture']: safeExec(cmd).trim() };
    case 'read_file':
      return { ...ctx, [params.export_as || 'last_capture']: safeReadFile(pathResolver.rootResolve(resolveVars(params.path, ctx)), { encoding: 'utf8' }) };
    case 'read_json':
      return { ...ctx, [params.export_as || 'last_capture_data']: JSON.parse(safeReadFile(pathResolver.rootResolve(resolveVars(params.path, ctx)), { encoding: 'utf8' }) as string) };
    case 'glob_files':
      const searchDir = pathResolver.rootResolve(resolveVars(params.dir, ctx));
      return { ...ctx, [params.export_as || 'file_list']: getAllFiles(searchDir).filter(f => !params.ext || f.endsWith(params.ext)).map(f => path.relative(pathResolver.rootDir(), f)) };
    case 'knowledge_search':
      const query = resolveVars(params.query, ctx).toLowerCase();
      const manifestPath = pathResolver.knowledge('_manifest.json');
      const manifest = JSON.parse(safeReadFile(manifestPath, { encoding: 'utf8' }) as string);
      const matched = manifest.documents?.filter((doc: any) => 
        doc.title.toLowerCase().includes(query) || doc.tags?.some((t: string) => t.toLowerCase().includes(query))
      ) || [];
      return { ...ctx, [params.export_as || 'found_knowledge']: matched };
    default: return ctx;
  }
}

/**
 * TRANSFORM Operators
 */
async function opTransform(op: string, params: any, ctx: any) {
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
      return { ...ctx, [params.export_as || 'last_transform']: input.replace(new RegExp(params.pattern, 'g'), resolveVars(params.template, ctx)) };
    }
    case 'yaml_update': {
      const content = String(ctx[params.from || 'last_capture'] || '');
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/m);
      if (!fmMatch) return ctx;
      const fm = yaml.load(fmMatch[1]) as any;
      fm[params.field] = resolveVars(params.value, ctx);
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
async function opApply(op: string, params: any, ctx: any) {
  switch (op) {
    case 'write_file':
      const out = pathResolver.rootResolve(resolveVars(params.path, ctx));
      const content = ctx[params.from || 'last_transform'] || ctx[params.from || 'last_capture'];
      if (!safeExistsSync(path.dirname(out))) safeMkdir(path.dirname(out), { recursive: true });
      safeWriteFile(out, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
      break;
    case 'knowledge_inject':
      const kPath = resolveVars(params.knowledge_path, ctx);
      const missionId = resolveVars(params.mission_id, ctx);
      const missionPath = (pathResolver as any).findMissionPath(missionId);
      if (!missionPath) throw new Error(`Mission ${missionId} not found.`);
      
      const sourcePath = pathResolver.knowledge(kPath);
      const fileName = path.basename(sourcePath);
      const targetPath = path.join(missionPath, `evidence/injected_${fileName}`);
      
      if (safeExistsSync(sourcePath)) {
        const data = safeReadFile(sourcePath, { encoding: 'utf8' }) as string;
        safeWriteFile(targetPath, data);
        logger.success(`💉 [Wisdom] Injected knowledge ${kPath} into mission ${missionId}`);
      } else {
        throw new Error(`Knowledge source not found: ${sourcePath}`);
      }
      break;
    case 'log': logger.info(`[WISDOM_LOG] ${resolveVars(params.message || 'Action completed', ctx)}`); break;
    case 'knowledge_export':
      const sourceFile = pathResolver.knowledge(resolveVars(params.path, ctx));
      if (!safeExistsSync(sourceFile)) throw new Error(`Knowledge source not found: ${sourceFile}`);
      
      const agentId = JSON.parse(safeReadFile(pathResolver.knowledge('personal/agent-identity.json'), { encoding: 'utf8' }) as string).agent_id;
      const rawData = safeReadFile(sourceFile, { encoding: 'utf8' }) as string;
      const { createHash } = await import('node:crypto');
      const hash = createHash('sha256').update(rawData).digest('hex');

      const kkp = {
        metadata: {
          package_id: `KKP-${Date.now()}`,
          origin_agent_id: agentId,
          timestamp: new Date().toISOString(),
          domain: params.domain || 'general',
          hash: hash,
          visibility: params.visibility || 'public'
        },
        content: {
          path: resolveVars(params.path, ctx),
          raw_data: rawData
        }
      };

      const outPath = pathResolver.rootResolve(
        resolveVars(params.output_path || pathResolver.sharedExports(`wisdom/${kkp.metadata.package_id}.kkp`), ctx)
      );
      safeWriteFile(outPath, JSON.stringify(kkp, null, 2));
      logger.success(`📦 [Wisdom] Knowledge exported to ${outPath}`);
      break;

    case 'knowledge_import':
      const pkgPath = pathResolver.rootResolve(resolveVars(params.package_path, ctx));
      if (!safeExistsSync(pkgPath)) throw new Error(`Package not found: ${pkgPath}`);
      
      const pkg = JSON.parse(safeReadFile(pkgPath, { encoding: 'utf8' }) as string);
      const { createHash: vHash } = await import('node:crypto');
      const actualHash = vHash('sha256').update(pkg.content.raw_data).digest('hex');

      if (actualHash !== pkg.metadata.hash) {
        throw new Error(`CRITICAL: Knowledge Package integrity check failed. Expected: ${pkg.metadata.hash}, Got: ${actualHash}`);
      }

      const targetTier = params.tier || 'confidential';
      const importDir = pathResolver.knowledge(`${targetTier}/external/${pkg.metadata.origin_agent_id}`);
      if (!safeExistsSync(importDir)) safeMkdir(importDir, { recursive: true });

      const targetFile = path.join(importDir, path.basename(pkg.content.path));
      safeWriteFile(targetFile, pkg.content.raw_data);
      
      logger.success(`📥 [Wisdom] Imported knowledge from ${pkg.metadata.origin_agent_id} to ${targetFile}`);
      break;
  }
}

/**
 * Strategic Reconciliation
 */
async function performReconcile(input: WisdomAction) {
  const strategyPath = pathResolver.knowledge(input.strategy_path || 'governance/wisdom-reconcile-strategy.json');
  if (!safeExistsSync(strategyPath)) throw new Error(`Strategy not found: ${strategyPath}`);
  const config = JSON.parse(safeReadFile(strategyPath, { encoding: 'utf8' }) as string);
  for (const strategy of config.strategies) {
    if (strategy.for_each) {
      const listCtx = await opCapture(strategy.for_each.op, strategy.for_each.params, {});
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
  const inputContent = safeReadFile(pathResolver.rootResolve(argv.input as string), { encoding: 'utf8' }) as string;
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
