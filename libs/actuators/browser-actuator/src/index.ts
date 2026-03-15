import { logger, safeReadFile, safeWriteFile, safeMkdir, safeExec, safeExistsSync, derivePipelineStatus } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { chromium, BrowserContext, Page } from 'playwright';

/**
 * Browser-Actuator v2.2.0 [TRACE & RECORD ENABLED]
 * Strictly compliant with Layer 2 (Shield).
 * Standardized with Control Flow, Safety Guards, and Playwright Tracing.
 * Supports {{env.VAR_NAME}} for secure credential injection.
 */

interface PipelineStep {
  type: 'capture' | 'transform' | 'apply' | 'control';
  op: string;
  params: any;
}

interface BrowserAction {
  action: 'pipeline';
  steps: PipelineStep[];
  session_id?: string;
  options?: {
    headless?: boolean;
    viewport?: { width: number; height: number };
    max_steps?: number;
    timeout_ms?: number;
    record_trace?: boolean;
    record_video?: boolean;
    locale?: string;
  };
  context?: Record<string, any>;
}

const BROWSER_RUNTIME_DIR = path.join(process.cwd(), 'active/shared/runtime/browser');
const EVIDENCE_DIR = path.join(process.cwd(), 'evidence/browser');

/**
 * Main Entry Point
 */
async function handleAction(input: BrowserAction) {
  if (input.action !== 'pipeline') {
    throw new Error(`Unsupported action: ${input.action}. Browser-Actuator v2.1 is pure pipeline-driven.`);
  }
  return await executePipeline(input.steps || [], input.session_id || 'default', input.options || {}, input.context || {});
}

/**
 * Universal Browser Pipeline Engine
 */
async function executePipeline(steps: PipelineStep[], sessionId: string, options: any, initialCtx: any = {}, state: any = { stepCount: 0, startTime: Date.now() }) {
  const rootDir = process.cwd();
  const MAX_STEPS = options.max_steps || 1000;
  const TIMEOUT = options.timeout_ms || 300000;

  const userDataDir = path.join(BROWSER_RUNTIME_DIR, sessionId);
  if (!safeExistsSync(userDataDir)) safeMkdir(userDataDir, { recursive: true });

  const tracePath = path.join(EVIDENCE_DIR, `trace_${sessionId}_${Date.now()}.zip`);
  const videoDir = path.join(EVIDENCE_DIR, 'videos', sessionId);
  if (options.record_video && !safeExistsSync(videoDir)) safeMkdir(videoDir, { recursive: true });

  logger.info(`🚀 [BROWSER] Launching session: ${sessionId} (Headless: ${options.headless !== false})`);
  
  const browserContext = await chromium.launchPersistentContext(userDataDir, {
    headless: options.headless !== false,
    viewport: options.viewport || { width: 1280, height: 720 },
    locale: options.locale || 'ja-JP',
    recordVideo: options.record_video ? { dir: videoDir } : undefined
  });

  // Start Tracing if requested
  if (options.record_trace) {
    await browserContext.tracing.start({ screenshots: true, snapshots: true, sources: true });
  }

  const page = browserContext.pages().length > 0 ? browserContext.pages()[0] : await browserContext.newPage();

  // Auto-accept all dialogs (confirm, alert, prompt)
  page.on('dialog', async (dialog) => {
    logger.info(`[BROWSER] Dialog intercepted: ${dialog.type()} - "${dialog.message().substring(0, 100)}"`);
    await dialog.accept();
  });

  let ctx = { ...initialCtx, timestamp: new Date().toISOString() };
  
  const resolveKey = (key: string): any => {
    // {{env.VAR_NAME}} → process.env.VAR_NAME
    if (key.startsWith('env.')) {
      return process.env[key.slice(4)] || '';
    }
    const parts = key.split('.');
    let current: any = ctx;
    for (const part of parts) { current = current?.[part]; }
    return current;
  };

  const resolve = (val: any): any => {
    if (typeof val !== 'string') return val;

    // 単一の変数参照 "{{var}}" の場合は、型を維持して生データを返す
    const singleVarMatch = val.match(/^{{(.*?)}}$/);
    if (singleVarMatch) {
      const resolved = resolveKey(singleVarMatch[1].trim());
      return resolved !== undefined ? resolved : '';
    }

    // 文字列混在の場合は従来通り文字列展開
    return val.replace(/{{(.*?)}}/g, (_, p: string) => {
      const resolved = resolveKey(p.trim());
      return resolved !== undefined ? (typeof resolved === 'object' ? JSON.stringify(resolved) : String(resolved)) : '';
    });
  };

  const results = [];
  try {
    for (const step of steps) {
      state.stepCount++;
      if (state.stepCount > MAX_STEPS) throw new Error(`[SAFETY_LIMIT] Exceeded maximum pipeline steps (${MAX_STEPS})`);
      if (Date.now() - state.startTime > TIMEOUT) throw new Error(`[SAFETY_LIMIT] Pipeline execution timed out (${TIMEOUT}ms)`);

      try {
        logger.info(`  [BROWSER_PIPELINE] [Step ${state.stepCount}] ${step.type}:${step.op}...`);
        
        if (step.type === 'control') {
          ctx = await opControl(step.op, step.params, page, ctx, options, state, resolve);
        } else if (step.type === 'capture') {
          ctx = await opCapture(step.op, step.params, page, ctx, resolve);
        } else if (step.type === 'transform') {
          ctx = await opTransform(step.op, step.params, ctx, resolve);
        } else if (step.type === 'apply') {
          ctx = await opApply(step.op, step.params, page, ctx, resolve);
        } else {
          throw new Error(`Unknown step type: ${step.type}`);
        }
        results.push({ op: step.op, status: 'success' });
      } catch (err: any) {
        logger.error(`  [BROWSER_PIPELINE] Step failed (${step.op}): ${err.message}`);
        results.push({ op: step.op, status: 'failed', error: err.message });
        break; 
      }
    }
  } finally {
    if (options.record_trace) {
      if (!safeExistsSync(EVIDENCE_DIR)) safeMkdir(EVIDENCE_DIR, { recursive: true });
      await browserContext.tracing.stop({ path: tracePath });
      logger.info(`🎞️ [BROWSER] Trace recorded at: ${tracePath}`);
      ctx.last_trace_path = tracePath;
    }
    await browserContext.close();
  }

  return { status: derivePipelineStatus(results), results, context: ctx, total_steps: state.stepCount };
}

/**
 * CONTROL Operators
 */
async function opControl(op: string, params: any, page: Page, ctx: any, options: any, state: any, resolve: Function) {
  switch (op) {
    case 'if':
      if (evaluateCondition(params.condition, ctx)) {
        const res = await executePipelineInternal(params.then, page, ctx, options, state, resolve);
        return res.context;
      } else if (params.else) {
        const res = await executePipelineInternal(params.else, page, ctx, options, state, resolve);
        return res.context;
      }
      return ctx;

    case 'while':
      let iterations = 0;
      const maxIter = params.max_iterations || 100;
      while (evaluateCondition(params.condition, ctx) && iterations < maxIter) {
        const res = await executePipelineInternal(params.pipeline, page, ctx, options, state, resolve);
        ctx = res.context;
        iterations++;
      }
      return ctx;

    default: 
      throw new Error(`Unsupported control operator in Browser-Actuator: ${op}`);
  }
}

/**
 * Internal execution within an already open page
 */
async function executePipelineInternal(steps: PipelineStep[], page: Page, ctx: any, options: any, state: any, resolve: Function) {
  const results = [];
  for (const step of steps) {
    state.stepCount++;
    try {
      if (step.type === 'control') {
        ctx = await opControl(step.op, step.params, page, ctx, options, state, resolve);
      } else if (step.type === 'capture') {
        ctx = await opCapture(step.op, step.params, page, ctx, resolve);
      } else if (step.type === 'transform') {
        ctx = await opTransform(step.op, step.params, ctx, resolve);
      } else if (step.type === 'apply') {
        ctx = await opApply(step.op, step.params, page, ctx, resolve);
      } else {
        throw new Error(`Unknown step type: ${step.type}`);
      }
      results.push({ op: step.op, status: 'success' });
    } catch (err: any) {
      results.push({ op: step.op, status: 'failed', error: err.message });
      break;
    }
  }
  return { context: ctx };
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
async function opCapture(op: string, params: any, page: Page, ctx: any, resolve: Function) {
  switch (op) {
    case 'goto': await page.goto(resolve(params.url), { waitUntil: params.waitUntil || 'networkidle' }); return { ...ctx, last_url: page.url() };
    case 'screenshot':
      const outPath = path.resolve(process.cwd(), resolve(params.path || `evidence/browser/screenshot_${Date.now()}.png`));
      logger.info(`📸 [BROWSER] Taking screenshot to: ${outPath}`);
      if (!safeExistsSync(path.dirname(outPath))) safeMkdir(path.dirname(outPath), { recursive: true });
      await page.screenshot({ path: outPath, fullPage: params.fullPage });
      return { ...ctx, [params.export_as || 'last_screenshot']: outPath };
    case 'content': return { ...ctx, [params.export_as || 'last_capture']: params.selector ? await page.innerText(params.selector) : await page.content() };
    case 'evaluate': return { ...ctx, [params.export_as || 'last_capture']: await page.evaluate(params.script) };
    default: 
      throw new Error(`Unsupported capture operator in Browser-Actuator: ${op}`);
  }
}

/**
 * TRANSFORM Operators
 */
async function opTransform(op: string, params: any, ctx: any, resolve: Function) {
  switch (op) {
    case 'regex_extract': {
      const input = String(ctx[params.from || 'last_capture'] || '');
      const match = input.match(new RegExp(params.pattern, 'm'));
      return { ...ctx, [params.export_as]: match ? match[1] : null };
    }
    case 'json_query': {
      const data = ctx[params.from || 'last_capture'];
      const res = params.path.split('.').reduce((o: any, i: string) => o?.[i], data);
      return { ...ctx, [params.export_as]: res };
    }
    default: 
      throw new Error(`Unsupported transform operator in Browser-Actuator: ${op}`);
  }
}

/**
 * APPLY Operators
 */
async function opApply(op: string, params: any, page: Page, ctx: any, resolve: Function) {
  switch (op) {
    case 'click': await page.click(resolve(params.selector), { timeout: params.timeout || 5000 }); break;
    case 'fill': await page.fill(resolve(params.selector), resolve(params.text), { timeout: params.timeout || 5000 }); break;
    case 'press': await page.press(resolve(params.selector), resolve(params.key), { timeout: params.timeout || 5000 }); break;
    case 'wait':
      if (params.selector) { await page.waitForSelector(resolve(params.selector), { state: params.state || 'visible', timeout: params.timeout || 10000 }); } 
      else { await page.waitForTimeout(params.duration || 1000); }
      break;
    case 'log': logger.info(`[BROWSER_LOG] ${resolve(params.message || 'Action completed')}`); break;
    default:
      throw new Error(`Unsupported apply operator in Browser-Actuator: ${op}`);
  }
  return ctx;
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
