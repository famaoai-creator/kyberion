import { logger, safeReadFile, safeWriteFile, safeMkdir, safeExec } from '@agent/core';
import { getAllFiles } from '@agent/core/fs-utils';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import * as visionJudge from '@agent/shared-vision';

/**
 * System-Actuator v2.0.0 [ULTIMATE PIPELINE ENGINE]
 * Strictly compliant with Layer 2 (Shield).
 * Unified ADF-driven engine for OS interactions, QA, and governance.
 * Zero hardcoded domain logic; all behaviors are defined in ADF contracts.
 */

interface PipelineStep {
  type: 'capture' | 'transform' | 'apply';
  op: string;
  params: any;
}

interface SystemAction {
  action: 'pipeline' | 'reconcile';
  steps?: PipelineStep[];
  strategy_path?: string;
  context?: Record<string, any>;
}

/**
 * Main Entry Point
 */
async function handleAction(input: SystemAction) {
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
      logger.info(`  [SYS_PIPELINE] Executing ${step.type}:${step.op}...`);
      switch (step.type) {
        case 'capture': ctx = await opCapture(step.op, step.params, ctx); break;
        case 'transform': ctx = await opTransform(step.op, step.params, ctx); break;
        case 'apply': await opApply(step.op, step.params, ctx); break;
      }
      results.push({ op: step.op, status: 'success' });
    } catch (err: any) {
      logger.error(`  [SYS_PIPELINE] Step failed (${step.op}): ${err.message}`);
      results.push({ op: step.op, status: 'failed', error: err.message });
      break; 
    }
  }
  return { status: 'finished', results, final_context_keys: Object.keys(ctx) };
}

/**
 * CAPTURE Operators: Bring data INTO the context
 */
async function opCapture(op: string, params: any, ctx: any) {
  const rootDir = process.cwd();
  const resolve = (val: string) => typeof val === 'string' ? val.replace(/{{(.*?)}}/g, (_, p) => ctx[p.trim()] || '') : val;

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

    case 'vision_consult':
      const decision = await visionJudge.consultVision(resolve(params.context), params.tie_break_options);
      return { ...ctx, [params.export_as || 'vision_decision']: decision };

    case 'pulse_status':
      const { ledger } = await import('@agent/core');
      const isChainValid = ledger.verifyIntegrity();
      return { ...ctx, [params.export_as || 'ledger_valid']: isChainValid };

    default: return ctx;
  }
}

/**
 * TRANSFORM Operators: Mutate data in context
 */
async function opTransform(op: string, params: any, ctx: any) {
  const resolve = (val: string) => typeof val === 'string' ? val.replace(/{{(.*?)}}/g, (_, p) => ctx[p.trim()] || '') : val;

  switch (op) {
    case 'regex_extract': {
      const input = String(ctx[params.from || 'last_capture'] || '');
      const regex = new RegExp(params.pattern, 'm');
      const match = input.match(regex);
      return { ...ctx, [params.export_as]: match ? match[1] : null };
    }

    case 'json_query': {
      const data = ctx[params.from || 'last_capture_data'];
      const result = params.path.split('.').reduce((o: any, i: string) => o?.[i], data);
      return { ...ctx, [params.export_as]: result };
    }

    case 'sre_analyze': {
      const { sre } = await import('@agent/core');
      const logs = ctx[params.from || 'last_capture'];
      const analysis = sre.analyzeRootCause(logs);
      return { ...ctx, [params.export_as || 'root_cause']: analysis };
    }

    default: return ctx;
  }
}

/**
 * APPLY Operators: Physical world interactions
 */
async function opApply(op: string, params: any, ctx: any) {
  const rootDir = process.cwd();
  const resolve = (val: string) => typeof val === 'string' ? val.replace(/{{(.*?)}}/g, (_, p) => ctx[p.trim()] || '') : val;

  switch (op) {
    case 'keyboard':
      if (process.platform === 'darwin') {
        const text = resolve(params.text || '{{last_capture}}').replace(/"/g, '\\"');
        safeExec('osascript', ['-e', `tell application "System Events" to keystroke "${text}"`]);
      }
      break;

    case 'mouse_click':
      if (process.platform === 'darwin') {
        const script = `tell application "System Events" to click at {${params.x}, ${params.y}}`;
        safeExec('osascript', ['-e', script]);
      }
      break;

    case 'voice':
      const { say } = await import('@agent/core');
      await say(resolve(params.text || '{{last_capture}}'));
      break;

    case 'notify':
      logger.info(`🔔 [NOTIFICATION] ${resolve(params.text)}`);
      break;

    case 'write_file':
      const outPath = path.resolve(rootDir, resolve(params.path));
      const content = ctx[params.from || 'last_transform'] || ctx[params.from || 'last_capture'];
      if (!fs.existsSync(path.dirname(outPath))) safeMkdir(path.dirname(outPath), { recursive: true });
      safeWriteFile(outPath, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
      break;

    case 'mkdir':
      safeMkdir(path.resolve(rootDir, resolve(params.path)), { recursive: true });
      break;

    case 'log':
      logger.info(`[SYSTEM_LOG] ${resolve(params.message || 'Action completed')}`);
      break;
  }
}

/**
 * Strategic Reconciliation
 */
async function performReconcile(input: SystemAction) {
  const strategyPath = path.resolve(process.cwd(), input.strategy_path || 'knowledge/governance/system-strategy.json');
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
