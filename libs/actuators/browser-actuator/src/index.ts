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

interface BrowserRecordedAction {
  kind: 'control' | 'capture' | 'apply';
  op: string;
  tab_id?: string;
  url?: string;
  ref?: string;
  selector?: string;
  text?: string;
  key?: string;
  ts: string;
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
    action_trail: Array.isArray(initialCtx?.action_trail) ? initialCtx.action_trail : [],
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
      return recordBrowserAction({
        ...ctx,
        active_tab_id: runtime.activeTabId,
        browser_tabs: await summarizeTabs(runtime),
      }, {
        kind: 'control',
        op: 'open_tab',
        tab_id: tabId,
        url: params.url ? resolve(params.url) : undefined,
      });
    }
    case 'select_tab': {
      const tabId = resolve(params.tab_id);
      if (!runtime.tabs.has(tabId)) throw new Error(`Unknown browser tab: ${tabId}`);
      runtime.activeTabId = tabId;
      return recordBrowserAction({
        ...ctx,
        active_tab_id: runtime.activeTabId,
        browser_tabs: await summarizeTabs(runtime),
      }, {
        kind: 'control',
        op: 'select_tab',
        tab_id: tabId,
      });
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
    case 'goto': {
      const url = resolve(params.url);
      await page.goto(url, { waitUntil: params.waitUntil || 'networkidle' });
      return recordBrowserAction({ ...ctx, last_url: page.url() }, {
        kind: 'capture',
        op: 'goto',
        tab_id: runtime.activeTabId,
        url,
      });
    }
    case 'tabs':
      return recordBrowserAction({
        ...ctx,
        browser_tabs: await summarizeTabs(runtime),
        [params.export_as || 'browser_tabs']: await summarizeTabs(runtime),
      }, {
        kind: 'capture',
        op: 'tabs',
        tab_id: runtime.activeTabId,
      });
    case 'snapshot': {
      const snapshot = await buildSnapshot(page, {
        sessionId: ctx.session_id || 'default',
        tabId: runtime.activeTabId,
        maxElements: Number(params.max_elements || 200),
      });
      return recordBrowserAction({
        ...ctx,
        last_snapshot: snapshot,
        last_capture: snapshot,
        ref_map: Object.fromEntries(snapshot.elements.map((element) => [element.ref, element.selector])),
        [params.export_as || 'last_snapshot']: snapshot,
      }, {
        kind: 'capture',
        op: 'snapshot',
        tab_id: runtime.activeTabId,
        url: snapshot.url,
      });
    }
    case 'console':
      return recordBrowserAction({
        ...ctx,
        [params.export_as || 'console_events']: runtime.consoleEvents.slice(-(params.limit || 50)),
      }, {
        kind: 'capture',
        op: 'console',
        tab_id: runtime.activeTabId,
      });
    case 'network':
      return recordBrowserAction({
        ...ctx,
        [params.export_as || 'network_events']: runtime.networkEvents.slice(-(params.limit || 50)),
      }, {
        kind: 'capture',
        op: 'network',
        tab_id: runtime.activeTabId,
      });
    case 'screenshot':
      const outPath = path.resolve(process.cwd(), resolve(params.path || `evidence/browser/screenshot_${Date.now()}.png`));
      logger.info(`📸 [BROWSER] Taking screenshot to: ${outPath}`);
      if (!safeExistsSync(path.dirname(outPath))) safeMkdir(path.dirname(outPath), { recursive: true });
      await page.screenshot({ path: outPath, fullPage: params.fullPage });
      return recordBrowserAction({ ...ctx, [params.export_as || 'last_screenshot']: outPath }, {
        kind: 'capture',
        op: 'screenshot',
        tab_id: runtime.activeTabId,
        url: page.url(),
      });
    case 'content':
      return recordBrowserAction({ ...ctx, [params.export_as || 'last_capture']: params.selector ? await page.innerText(params.selector) : await page.content() }, {
        kind: 'capture',
        op: 'content',
        tab_id: runtime.activeTabId,
        selector: params.selector ? resolve(params.selector) : undefined,
      });
    case 'evaluate':
      return recordBrowserAction({ ...ctx, [params.export_as || 'last_capture']: await page.evaluate(params.script) }, {
        kind: 'capture',
        op: 'evaluate',
        tab_id: runtime.activeTabId,
      });
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
    case 'export_playwright': {
      const trail = readRecordedActions(ctx, params.from);
      const outPath = path.resolve(process.cwd(), resolve(params.path || `active/shared/tmp/browser/${ctx.session_id || 'default'}-playwright.spec.ts`));
      if (!safeExistsSync(path.dirname(outPath))) safeMkdir(path.dirname(outPath), { recursive: true });
      const content = renderPlaywrightSkeleton(trail);
      safeWriteFile(outPath, content);
      return { ...ctx, [params.export_as || 'playwright_spec_path']: outPath };
    }
    case 'export_adf': {
      const trail = readRecordedActions(ctx, params.from);
      const outPath = path.resolve(process.cwd(), resolve(params.path || `active/shared/tmp/browser/${ctx.session_id || 'default'}-pipeline.json`));
      if (!safeExistsSync(path.dirname(outPath))) safeMkdir(path.dirname(outPath), { recursive: true });
      const adf = renderBrowserAdf(trail, ctx.session_id || 'default');
      safeWriteFile(outPath, JSON.stringify(adf, null, 2));
      return { ...ctx, [params.export_as || 'adf_path']: outPath };
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
    case 'click':
      await page.click(resolve(params.selector), { timeout: params.timeout || 5000 });
      return recordBrowserAction(ctx, { kind: 'apply', op: 'click', tab_id: runtime.activeTabId, selector: resolve(params.selector) });
    case 'fill':
      await page.fill(resolve(params.selector), resolve(params.text), { timeout: params.timeout || 5000 });
      return recordBrowserAction(ctx, { kind: 'apply', op: 'fill', tab_id: runtime.activeTabId, selector: resolve(params.selector), text: resolve(params.text) });
    case 'press':
      await page.press(resolve(params.selector), resolve(params.key), { timeout: params.timeout || 5000 });
      return recordBrowserAction(ctx, { kind: 'apply', op: 'press', tab_id: runtime.activeTabId, selector: resolve(params.selector), key: resolve(params.key) });
    case 'click_ref': {
      const ref = resolve(params.ref);
      const selector = resolveRefSelector(ctx, ref);
      await page.click(selector, { timeout: params.timeout || 5000 });
      return recordBrowserAction(ctx, { kind: 'apply', op: 'click_ref', tab_id: runtime.activeTabId, ref, selector });
    }
    case 'fill_ref': {
      const ref = resolve(params.ref);
      const text = resolve(params.text);
      const selector = resolveRefSelector(ctx, ref);
      await page.fill(selector, text, { timeout: params.timeout || 5000 });
      return recordBrowserAction(ctx, { kind: 'apply', op: 'fill_ref', tab_id: runtime.activeTabId, ref, selector, text });
    }
    case 'press_ref': {
      const ref = resolve(params.ref);
      const key = resolve(params.key);
      const selector = resolveRefSelector(ctx, ref);
      await page.press(selector, key, { timeout: params.timeout || 5000 });
      return recordBrowserAction(ctx, { kind: 'apply', op: 'press_ref', tab_id: runtime.activeTabId, ref, selector, key });
    }
    case 'wait':
      if (params.selector) { await page.waitForSelector(resolve(params.selector), { state: params.state || 'visible', timeout: params.timeout || 10000 }); } 
      else { await page.waitForTimeout(params.duration || 1000); }
      return recordBrowserAction(ctx, { kind: 'apply', op: 'wait', tab_id: runtime.activeTabId, selector: params.selector ? resolve(params.selector) : undefined });
    case 'wait_ref': {
      const ref = resolve(params.ref);
      const selector = resolveRefSelector(ctx, ref);
      await page.waitForSelector(selector, { state: params.state || 'visible', timeout: params.timeout || 10000 });
      return recordBrowserAction(ctx, { kind: 'apply', op: 'wait_ref', tab_id: runtime.activeTabId, ref, selector });
    }
    case 'log':
      logger.info(`[BROWSER_LOG] ${resolve(params.message || 'Action completed')}`);
      return recordBrowserAction(ctx, { kind: 'apply', op: 'log', tab_id: runtime.activeTabId });
    default:
      throw new Error(`Unsupported apply operator in Browser-Actuator: ${op}`);
  }
}

function resolveRefSelector(ctx: any, ref: string): string {
  const selector = ctx?.ref_map?.[ref];
  if (!selector) {
    throw new Error(`Unknown browser ref: ${ref}. Capture a snapshot before using *_ref actions.`);
  }
  return selector;
}

function recordBrowserAction(ctx: any, action: Omit<BrowserRecordedAction, 'ts'>): any {
  const trail = Array.isArray(ctx?.action_trail) ? ctx.action_trail : [];
  return {
    ...ctx,
    action_trail: [...trail, { ...action, ts: new Date().toISOString() }],
  };
}

function readRecordedActions(ctx: any, from?: string): BrowserRecordedAction[] {
  const candidate = from ? ctx?.[from] : ctx?.action_trail;
  if (!Array.isArray(candidate)) return [];
  return candidate as BrowserRecordedAction[];
}

function renderPlaywrightSkeleton(trail: BrowserRecordedAction[]): string {
  const lines = [
    "import { test, expect } from '@playwright/test';",
    '',
    "test('browser recorded flow', async ({ page }) => {",
  ];

  for (const action of trail) {
    switch (action.op) {
      case 'goto':
      case 'open_tab':
        if (action.url) lines.push(`  await page.goto(${JSON.stringify(action.url)});`);
        break;
      case 'click':
      case 'click_ref':
        if (action.selector) lines.push(`  await page.click(${JSON.stringify(action.selector)});`);
        break;
      case 'fill':
      case 'fill_ref':
        if (action.selector) lines.push(`  await page.fill(${JSON.stringify(action.selector)}, ${JSON.stringify(action.text || '')});`);
        break;
      case 'press':
      case 'press_ref':
        if (action.selector) lines.push(`  await page.press(${JSON.stringify(action.selector)}, ${JSON.stringify(action.key || 'Enter')});`);
        break;
      case 'wait':
      case 'wait_ref':
        if (action.selector) lines.push(`  await page.waitForSelector(${JSON.stringify(action.selector)});`);
        break;
      default:
        break;
    }
  }

  lines.push('});', '');
  return lines.join('\n');
}

function renderBrowserAdf(trail: BrowserRecordedAction[], sessionId: string): BrowserAction {
  const steps: PipelineStep[] = [];
  for (const action of trail) {
    switch (action.op) {
      case 'goto':
      case 'open_tab':
        if (action.url) steps.push({ type: 'capture', op: 'goto', params: { url: action.url } });
        break;
      case 'click_ref':
        if (action.ref) steps.push({ type: 'apply', op: 'click_ref', params: { ref: action.ref } });
        break;
      case 'fill_ref':
        if (action.ref) steps.push({ type: 'apply', op: 'fill_ref', params: { ref: action.ref, text: action.text || '' } });
        break;
      case 'press_ref':
        if (action.ref) steps.push({ type: 'apply', op: 'press_ref', params: { ref: action.ref, key: action.key || 'Enter' } });
        break;
      case 'wait_ref':
        if (action.ref) steps.push({ type: 'apply', op: 'wait_ref', params: { ref: action.ref } });
        break;
      case 'click':
        if (action.selector) steps.push({ type: 'apply', op: 'click', params: { selector: action.selector } });
        break;
      case 'fill':
        if (action.selector) steps.push({ type: 'apply', op: 'fill', params: { selector: action.selector, text: action.text || '' } });
        break;
      case 'press':
        if (action.selector) steps.push({ type: 'apply', op: 'press', params: { selector: action.selector, key: action.key || 'Enter' } });
        break;
      case 'wait':
        if (action.selector) steps.push({ type: 'apply', op: 'wait', params: { selector: action.selector } });
        break;
      default:
        break;
    }
  }

  return {
    action: 'pipeline',
    session_id: sessionId,
    steps,
  };
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

export { handleAction, buildSnapshot, resolveRefSelector, renderPlaywrightSkeleton, renderBrowserAdf };
