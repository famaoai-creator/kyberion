import { logger, safeReadFile, safeWriteFile, safeMkdir } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { chromium, BrowserContext, Page } from 'playwright';

/**
 * Browser-Actuator v2.0.0 [PLAYWRIGHT PIPELINE DRIVEN]
 * Strictly compliant with Layer 2 (Shield).
 * A pure ADF-driven engine for browser automation aligned with Playwright semantics.
 */

interface PipelineStep {
  type: 'capture' | 'transform' | 'apply';
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
  };
  context?: Record<string, any>;
}

const BROWSER_RUNTIME_DIR = path.join(process.cwd(), 'active/shared/runtime/browser');

/**
 * Main Entry Point
 */
async function handleAction(input: BrowserAction) {
  if (input.action !== 'pipeline') {
    throw new Error(`Unsupported action: ${input.action}. Browser-Actuator v2.0 is pure pipeline-driven.`);
  }
  return await executePipeline(input.steps || [], input.session_id || 'default', input.options || {}, input.context || {});
}

/**
 * Universal Browser Pipeline Engine
 */
async function executePipeline(steps: PipelineStep[], sessionId: string, options: any, initialCtx: any = {}) {
  const userDataDir = path.join(BROWSER_RUNTIME_DIR, sessionId);
  if (!fs.existsSync(userDataDir)) safeMkdir(userDataDir, { recursive: true });

  logger.info(`🚀 [BROWSER] Initializing session: ${sessionId}`);
  const browserContext = await chromium.launchPersistentContext(userDataDir, {
    headless: options.headless !== false,
    viewport: options.viewport || { width: 1280, height: 720 }
  });

  const page = browserContext.pages().length > 0 ? browserContext.pages()[0] : await browserContext.newPage();
  let ctx = { ...initialCtx, timestamp: new Date().toISOString() };
  const results = [];

  try {
    for (const step of steps) {
      try {
        logger.info(`  [BROWSER_PIPELINE] Executing ${step.type}:${step.op}...`);
        switch (step.type) {
          case 'capture': ctx = await opCapture(step.op, step.params, page, ctx); break;
          case 'transform': ctx = await opTransform(step.op, step.params, ctx); break;
          case 'apply': await opApply(step.op, step.params, page, ctx); break;
        }
        results.push({ op: step.op, status: 'success' });
      } catch (err: any) {
        logger.error(`  [BROWSER_PIPELINE] Step failed (${step.op}): ${err.message}`);
        results.push({ op: step.op, status: 'failed', error: err.message });
        break; 
      }
    }
  } finally {
    await browserContext.close();
  }

  return { status: 'finished', results, final_context_keys: Object.keys(ctx) };
}

/**
 * CAPTURE Operators: Bring browser data INTO the context
 */
async function opCapture(op: string, params: any, page: Page, ctx: any) {
  const resolve = (val: string) => typeof val === 'string' ? val.replace(/{{(.*?)}}/g, (_, p) => ctx[p.trim()] || '') : val;

  switch (op) {
    case 'goto':
      await page.goto(resolve(params.url), { waitUntil: params.waitUntil || 'networkidle' });
      return { ...ctx, last_url: page.url() };

    case 'screenshot':
      const outPath = path.resolve(process.cwd(), resolve(params.path || `evidence/screenshots/browser_${Date.now()}.png`));
      if (!fs.existsSync(path.dirname(outPath))) safeMkdir(path.dirname(outPath), { recursive: true });
      await page.screenshot({ path: outPath, fullPage: params.fullPage });
      return { ...ctx, [params.export_as || 'last_screenshot']: outPath };

    case 'content':
      const content = params.selector ? await page.innerText(params.selector) : await page.content();
      return { ...ctx, [params.export_as || 'last_capture']: content };

    case 'evaluate':
      const result = await page.evaluate(params.script);
      return { ...ctx, [params.export_as || 'last_capture']: result };

    default: return ctx;
  }
}

/**
 * TRANSFORM Operators
 */
async function opTransform(op: string, params: any, ctx: any) {
  switch (op) {
    case 'regex_extract':
      const input = String(ctx[params.from || 'last_capture'] || '');
      const match = input.match(new RegExp(params.pattern, 'm'));
      return { ...ctx, [params.export_as]: match ? match[1] : null };

    case 'json_query':
      const data = ctx[params.from || 'last_capture'];
      const res = params.path.split('.').reduce((o: any, i: string) => o?.[i], data);
      return { ...ctx, [params.export_as]: res };

    default: return ctx;
  }
}

/**
 * APPLY Operators: Interactions with the browser page
 */
async function opApply(op: string, params: any, page: Page, ctx: any) {
  const resolve = (val: string) => typeof val === 'string' ? val.replace(/{{(.*?)}}/g, (_, p) => ctx[p.trim()] || '') : val;

  switch (op) {
    case 'click':
      await page.click(resolve(params.selector), { timeout: params.timeout || 5000 });
      break;

    case 'fill':
      await page.fill(resolve(params.selector), resolve(params.text), { timeout: params.timeout || 5000 });
      break;

    case 'press':
      await page.press(resolve(params.selector), resolve(params.key), { timeout: params.timeout || 5000 });
      break;

    case 'wait':
      if (params.selector) {
        await page.waitForSelector(resolve(params.selector), { state: params.state || 'visible', timeout: params.timeout || 10000 });
      } else {
        await page.waitForTimeout(params.duration || 1000);
      }
      break;

    case 'log':
      logger.info(`[BROWSER_LOG] ${resolve(params.message || 'Action completed')}`);
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
