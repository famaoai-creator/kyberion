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

interface BrowserSnapshotElement {
  ref: string;
  tag: string;
  role: string | null;
  text: string;
  name: string;
  type: string | null;
  placeholder: string | null;
  href: string | null;
  value: string | null;
  visible: boolean;
  editable: boolean;
  selector: string;
}

interface BrowserSnapshot {
  session_id: string;
  tab_id: string;
  url: string;
  title: string;
  captured_at: string;
  element_count: number;
  elements: BrowserSnapshotElement[];
}

interface BrowserTabSummary {
  tab_id: string;
  url: string;
  title: string;
  active: boolean;
}

interface BrowserSessionMetadata {
  session_id: string;
  user_data_dir: string;
  active_tab_id: string;
  tab_count: number;
  tabs: BrowserTabSummary[];
  updated_at: string;
  last_trace_path?: string;
}

interface BrowserRuntime {
  context: BrowserContext;
  tabs: Map<string, Page>;
  pageIds: WeakMap<Page, string>;
  activeTabId: string;
  consoleEvents: Array<{ tab_id: string; type: string; text: string; ts: string }>;
  networkEvents: Array<{ tab_id: string; method: string; url: string; resourceType: string; ts: string }>;
}

const BROWSER_RUNTIME_DIR = path.join(process.cwd(), 'active/shared/runtime/browser');
const BROWSER_SESSION_DIR = path.join(BROWSER_RUNTIME_DIR, 'sessions');
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
  const MAX_STEPS = options.max_steps || 1000;
  const TIMEOUT = options.timeout_ms || 300000;

  const userDataDir = path.join(BROWSER_RUNTIME_DIR, sessionId);
  if (!safeExistsSync(userDataDir)) safeMkdir(userDataDir, { recursive: true });
  if (!safeExistsSync(BROWSER_SESSION_DIR)) safeMkdir(BROWSER_SESSION_DIR, { recursive: true });
  const sessionMetadataPath = path.join(BROWSER_SESSION_DIR, `${sessionId}.json`);

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

  const runtime = createBrowserRuntime(browserContext);
  if (runtime.tabs.size === 0) {
    const page = await browserContext.newPage();
    registerBrowserPage(runtime, page, 'tab-1');
  }

  let ctx = {
    ...initialCtx,
    session_id: sessionId,
    active_tab_id: runtime.activeTabId,
    browser_tabs: await summarizeTabs(runtime),
    timestamp: new Date().toISOString(),
  };
  
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
          ctx = await opControl(step.op, step.params, runtime, ctx, options, state, resolve);
        } else if (step.type === 'capture') {
          ctx = await opCapture(step.op, step.params, runtime, ctx, resolve);
        } else if (step.type === 'transform') {
          ctx = await opTransform(step.op, step.params, ctx, resolve);
        } else if (step.type === 'apply') {
          ctx = await opApply(step.op, step.params, runtime, ctx, resolve);
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
    ctx.browser_tabs = await summarizeTabs(runtime);
    ctx.active_tab_id = runtime.activeTabId;
    saveBrowserSessionMetadata(sessionMetadataPath, {
      session_id: sessionId,
      user_data_dir: userDataDir,
      active_tab_id: runtime.activeTabId,
      tab_count: runtime.tabs.size,
      tabs: ctx.browser_tabs,
      updated_at: new Date().toISOString(),
      last_trace_path: ctx.last_trace_path,
    });
    await browserContext.close();
  }

  return { status: derivePipelineStatus(results), results, context: ctx, total_steps: state.stepCount };
}

/**
 * CONTROL Operators
 */
async function opControl(op: string, params: any, runtime: BrowserRuntime, ctx: any, options: any, state: any, resolve: Function) {
  switch (op) {
    case 'open_tab': {
      const page = await runtime.context.newPage();
      const tabId = params.tab_id || `tab-${runtime.tabs.size + 1}`;
      registerBrowserPage(runtime, page, tabId);
      if (params.url) {
        await page.goto(resolve(params.url), { waitUntil: params.waitUntil || 'networkidle' });
      }
      if (params.select !== false) runtime.activeTabId = tabId;
      return {
        ...ctx,
        active_tab_id: runtime.activeTabId,
        browser_tabs: await summarizeTabs(runtime),
      };
    }
    case 'select_tab': {
      const tabId = resolve(params.tab_id);
      if (!runtime.tabs.has(tabId)) throw new Error(`Unknown browser tab: ${tabId}`);
      runtime.activeTabId = tabId;
      return {
        ...ctx,
        active_tab_id: runtime.activeTabId,
        browser_tabs: await summarizeTabs(runtime),
      };
    }
    case 'if':
      if (evaluateCondition(params.condition, ctx)) {
        const res = await executePipelineInternal(params.then, runtime, ctx, options, state, resolve);
        return res.context;
      } else if (params.else) {
        const res = await executePipelineInternal(params.else, runtime, ctx, options, state, resolve);
        return res.context;
      }
      return ctx;

    case 'while':
      let iterations = 0;
      const maxIter = params.max_iterations || 100;
      while (evaluateCondition(params.condition, ctx) && iterations < maxIter) {
        const res = await executePipelineInternal(params.pipeline, runtime, ctx, options, state, resolve);
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
async function executePipelineInternal(steps: PipelineStep[], runtime: BrowserRuntime, ctx: any, options: any, state: any, resolve: Function) {
  const results = [];
  for (const step of steps) {
    state.stepCount++;
    try {
      if (step.type === 'control') {
        ctx = await opControl(step.op, step.params, runtime, ctx, options, state, resolve);
      } else if (step.type === 'capture') {
        ctx = await opCapture(step.op, step.params, runtime, ctx, resolve);
      } else if (step.type === 'transform') {
        ctx = await opTransform(step.op, step.params, ctx, resolve);
      } else if (step.type === 'apply') {
        ctx = await opApply(step.op, step.params, runtime, ctx, resolve);
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
async function opCapture(op: string, params: any, runtime: BrowserRuntime, ctx: any, resolve: Function) {
  const page = getActivePage(runtime);
  switch (op) {
    case 'goto': await page.goto(resolve(params.url), { waitUntil: params.waitUntil || 'networkidle' }); return { ...ctx, last_url: page.url() };
    case 'tabs':
      return {
        ...ctx,
        browser_tabs: await summarizeTabs(runtime),
        [params.export_as || 'browser_tabs']: await summarizeTabs(runtime),
      };
    case 'snapshot': {
      const snapshot = await buildSnapshot(page, {
        sessionId: ctx.session_id || 'default',
        tabId: runtime.activeTabId,
        maxElements: Number(params.max_elements || 200),
      });
      return {
        ...ctx,
        last_snapshot: snapshot,
        last_capture: snapshot,
        ref_map: Object.fromEntries(snapshot.elements.map((element) => [element.ref, element.selector])),
        [params.export_as || 'last_snapshot']: snapshot,
      };
    }
    case 'console':
      return {
        ...ctx,
        [params.export_as || 'console_events']: runtime.consoleEvents.slice(-(params.limit || 50)),
      };
    case 'network':
      return {
        ...ctx,
        [params.export_as || 'network_events']: runtime.networkEvents.slice(-(params.limit || 50)),
      };
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
async function opApply(op: string, params: any, runtime: BrowserRuntime, ctx: any, resolve: Function) {
  const page = getActivePage(runtime);
  switch (op) {
    case 'click': await page.click(resolve(params.selector), { timeout: params.timeout || 5000 }); break;
    case 'fill': await page.fill(resolve(params.selector), resolve(params.text), { timeout: params.timeout || 5000 }); break;
    case 'press': await page.press(resolve(params.selector), resolve(params.key), { timeout: params.timeout || 5000 }); break;
    case 'click_ref': {
      const selector = resolveRefSelector(ctx, resolve(params.ref));
      await page.click(selector, { timeout: params.timeout || 5000 });
      break;
    }
    case 'fill_ref': {
      const selector = resolveRefSelector(ctx, resolve(params.ref));
      await page.fill(selector, resolve(params.text), { timeout: params.timeout || 5000 });
      break;
    }
    case 'press_ref': {
      const selector = resolveRefSelector(ctx, resolve(params.ref));
      await page.press(selector, resolve(params.key), { timeout: params.timeout || 5000 });
      break;
    }
    case 'wait':
      if (params.selector) { await page.waitForSelector(resolve(params.selector), { state: params.state || 'visible', timeout: params.timeout || 10000 }); } 
      else { await page.waitForTimeout(params.duration || 1000); }
      break;
    case 'wait_ref': {
      const selector = resolveRefSelector(ctx, resolve(params.ref));
      await page.waitForSelector(selector, { state: params.state || 'visible', timeout: params.timeout || 10000 });
      break;
    }
    case 'log': logger.info(`[BROWSER_LOG] ${resolve(params.message || 'Action completed')}`); break;
    default:
      throw new Error(`Unsupported apply operator in Browser-Actuator: ${op}`);
  }
  return ctx;
}

function resolveRefSelector(ctx: any, ref: string): string {
  const selector = ctx?.ref_map?.[ref];
  if (!selector) {
    throw new Error(`Unknown browser ref: ${ref}. Capture a snapshot before using *_ref actions.`);
  }
  return selector;
}

function createBrowserRuntime(context: BrowserContext): BrowserRuntime {
  const tabs = new Map<string, Page>();
  const pageIds = new WeakMap<Page, string>();
  const runtime: BrowserRuntime = {
    context,
    tabs,
    pageIds,
    activeTabId: 'tab-1',
    consoleEvents: [],
    networkEvents: [],
  };

  const pages = context.pages();
  for (const [index, page] of pages.entries()) {
    registerBrowserPage(runtime, page, `tab-${index + 1}`);
  }
  if (pages.length > 0) runtime.activeTabId = pageIds.get(pages[0]) || 'tab-1';
  return runtime;
}

function registerBrowserPage(runtime: BrowserRuntime, page: Page, tabId: string): void {
  runtime.tabs.set(tabId, page);
  runtime.pageIds.set(page, tabId);
  if (!runtime.activeTabId) runtime.activeTabId = tabId;
  attachPageObservers(runtime, page);
}

function attachPageObservers(runtime: BrowserRuntime, page: Page): void {
  const tabId = runtime.pageIds.get(page) || `tab-${runtime.tabs.size}`;
  page.on('dialog', async (dialog) => {
    logger.info(`[BROWSER] Dialog intercepted: ${dialog.type()} - "${dialog.message().substring(0, 100)}"`);
    await dialog.accept();
  });
  page.on('console', (msg) => {
    runtime.consoleEvents.push({
      tab_id: tabId,
      type: msg.type(),
      text: msg.text(),
      ts: new Date().toISOString(),
    });
    runtime.consoleEvents = runtime.consoleEvents.slice(-200);
  });
  page.on('request', (request) => {
    runtime.networkEvents.push({
      tab_id: tabId,
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      ts: new Date().toISOString(),
    });
    runtime.networkEvents = runtime.networkEvents.slice(-200);
  });
}

function getActivePage(runtime: BrowserRuntime): Page {
  const page = runtime.tabs.get(runtime.activeTabId);
  if (!page) throw new Error(`Active browser tab not found: ${runtime.activeTabId}`);
  return page;
}

async function summarizeTabs(runtime: BrowserRuntime): Promise<BrowserTabSummary[]> {
  const summaries: BrowserTabSummary[] = [];
  for (const [tabId, page] of runtime.tabs.entries()) {
    summaries.push({
      tab_id: tabId,
      url: page.url(),
      title: await page.title(),
      active: tabId === runtime.activeTabId,
    });
  }
  return summaries;
}

function saveBrowserSessionMetadata(filePath: string, metadata: BrowserSessionMetadata): void {
  safeWriteFile(filePath, JSON.stringify(metadata, null, 2));
}

async function buildSnapshot(page: Page, options: { sessionId: string; tabId: string; maxElements: number }): Promise<BrowserSnapshot> {
  const { sessionId, tabId, maxElements } = options;
  const raw = await page.evaluate((max) => {
    function buildCssPathFromDom(el: Element): string {
      const segments: string[] = [];
      let current: Element | null = el;
      while (current && current.nodeType === Node.ELEMENT_NODE && current.tagName.toLowerCase() !== 'html') {
        const tag = current.tagName.toLowerCase();
        const htmlEl = current as HTMLElement;
        if (htmlEl.id) {
          segments.unshift(`${tag}#${CSS.escape(htmlEl.id)}`);
          break;
        }
        let index = 1;
        let sibling = current.previousElementSibling;
        while (sibling) {
          if (sibling.tagName === current.tagName) index++;
          sibling = sibling.previousElementSibling;
        }
        segments.unshift(`${tag}:nth-of-type(${index})`);
        current = current.parentElement;
      }
      return segments.length ? segments.join(' > ') : 'body';
    }

    const candidates = Array.from(document.querySelectorAll('a, button, input, select, textarea, summary, [role], [tabindex]'));
    const visible = candidates.filter((node) => {
      const el = node as HTMLElement;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    });

    return visible.slice(0, max).map((node, index) => {
      const el = node as HTMLElement;
      const role = el.getAttribute('role');
      const aria = el.getAttribute('aria-label');
      const placeholder = el.getAttribute('placeholder');
      const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
      const name = aria || placeholder || text || el.getAttribute('name') || el.id || el.tagName.toLowerCase();
      const href = el instanceof HTMLAnchorElement ? el.href : null;
      const value = 'value' in el ? String((el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value || '') : null;
      return {
        ref: `@e${index + 1}`,
        tag: el.tagName.toLowerCase(),
        role,
        text,
        name,
        type: el.getAttribute('type'),
        placeholder,
        href,
        value,
        visible: true,
        editable: el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement,
        selector: buildCssPathFromDom(el),
      };
    });
  }, maxElements);

  return {
    session_id: sessionId,
    tab_id: tabId,
    url: page.url(),
    title: await page.title(),
    captured_at: new Date().toISOString(),
    element_count: raw.length,
    elements: raw,
  };
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

export { handleAction, buildSnapshot, resolveRefSelector };
