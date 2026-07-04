import {
  logger,
  safeReadFile,
  safeWriteFile,
  safeMkdir,
  safeExistsSync,
  safeReaddir,
  derivePipelineStatus,
  TraceContext,
  persistTrace,
  pathResolver,
  resolveVars,
  evaluateCondition,
  getPathValue,
  retry,
  classifyError,
} from '@agent/core';
import { browserRuntimeHelpers } from './browser-runtime-helpers.js';
import { chromium, type CDPSession, type Page } from '@playwright/test';
import * as path from 'node:path';

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
    lease_ms?: number;
    keep_alive?: boolean;
    user_data_dir?: string;
    browser_channel?: 'chromium' | 'chrome';
    profile_directory?: string;
    launch_args?: string[];
    connect_over_cdp?: boolean;
    cdp_url?: string;
    cdp_port?: number;
    video_artifact_dir?: string;
  };
  context?: Record<string, any>;
}

interface BrowserRuntime {
  context: any;
  tabs: Map<string, Page>;
  pageIds: WeakMap<Page, string>;
  cdpSessions: WeakMap<Page, CDPSession>;
  activeTabId: string;
  consoleEvents: Array<{ tab_id: string; type: string; text: string; ts: string }>;
  networkEvents: Array<{
    tab_id: string;
    method: string;
    url: string;
    resourceType: string;
    ts: string;
  }>;
  webAuthn?: {
    authenticatorId?: string;
    enabled: boolean;
    options?: Record<string, any>;
    credentials: Array<Record<string, any>>;
    events: Array<{
      type: string;
      credential?: Record<string, any>;
      credentialId?: string;
      ts: string;
    }>;
  };
}

interface BrowserRecordedAction {
  kind: 'control' | 'capture' | 'apply';
  op: string;
  tab_id?: string;
  url?: string;
  title?: string;
  ref?: string;
  selector?: string;
  text?: string;
  key?: string;
  element_name?: string;
  element_role?: string | null;
  content_excerpt?: string;
  ts: string;
}

interface BrowserSessionMetadata {
  recent_actions: Array<{
    op: string;
    kind: 'control' | 'capture' | 'apply';
    tab_id?: string;
    ref?: string;
    selector?: string;
    ts: string;
  }>;
}

interface BrowserRuntimeLeaseLike {
  userDataDir: string;
  cdpUrl?: string;
  cdpPort?: number;
}

const BROWSER_RUNTIME_DIR = pathResolver.shared('runtime/browser');
const BROWSER_SESSION_DIR = path.join(BROWSER_RUNTIME_DIR, 'sessions');
const EVIDENCE_DIR = pathResolver.rootResolve('evidence/browser');
const BROWSER_MANIFEST_PATH = pathResolver.rootResolve(
  'libs/actuators/browser-actuator/manifest.json'
);
const DEFAULT_BROWSER_RETRY = {
  maxRetries: 2,
  initialDelayMs: 500,
  maxDelayMs: 5000,
  factor: 2,
  jitter: true,
};
let cachedRecoveryPolicy: Record<string, any> | null = null;

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function loadRecoveryPolicy(): Record<string, any> {
  if (cachedRecoveryPolicy) return cachedRecoveryPolicy;
  try {
    const manifest = JSON.parse(
      safeReadFile(BROWSER_MANIFEST_PATH, { encoding: 'utf8' }) as string
    );
    cachedRecoveryPolicy = isPlainObject(manifest?.recovery_policy) ? manifest.recovery_policy : {};
    return cachedRecoveryPolicy;
  } catch (_) {
    cachedRecoveryPolicy = {};
    return cachedRecoveryPolicy;
  }
}

function buildRetryOptions(stepParams: Record<string, any>) {
  const recoveryPolicy = loadRecoveryPolicy();
  const manifestRetry = isPlainObject(recoveryPolicy.retry) ? recoveryPolicy.retry : {};
  const retryableCategories = new Set<string>(
    Array.isArray(recoveryPolicy.retryable_categories)
      ? recoveryPolicy.retryable_categories.map(String)
      : []
  );
  const explicitRetry = isPlainObject(stepParams.retry) ? stepParams.retry : {};
  const resolved = {
    ...DEFAULT_BROWSER_RETRY,
    ...manifestRetry,
    ...explicitRetry,
    maxRetries: Number(
      stepParams.max_retries ??
        explicitRetry.maxRetries ??
        manifestRetry.maxRetries ??
        DEFAULT_BROWSER_RETRY.maxRetries
    ),
    initialDelayMs: Number(
      stepParams.retry_delay_ms ??
        explicitRetry.initialDelayMs ??
        manifestRetry.initialDelayMs ??
        DEFAULT_BROWSER_RETRY.initialDelayMs
    ),
  };

  return {
    ...resolved,
    shouldRetry: (error: Error) => {
      const classification = classifyError(error);
      if (retryableCategories.size > 0) {
        return retryableCategories.has(classification.category);
      }
      const message = error.message?.toLowerCase?.() || '';
      return (
        classification.category === 'timeout' ||
        classification.category === 'network' ||
        classification.category === 'resource_unavailable' ||
        message.includes('selector') ||
        message.includes('not visible') ||
        message.includes('strict mode violation') ||
        message.includes('detached')
      );
    },
  };
}

export async function executePipeline(
  steps: PipelineStep[],
  sessionId: string,
  options: any,
  initialCtx: any = {},
  state: any = { stepCount: 0, startTime: Date.now() }
) {
  const MAX_STEPS = options.max_steps || 1000;
  const TIMEOUT = options.timeout_ms || 300000;

  const userDataDir = pathResolver.rootResolve(
    options.user_data_dir || path.join(BROWSER_RUNTIME_DIR, sessionId)
  );
  if (!safeExistsSync(userDataDir)) safeMkdir(userDataDir, { recursive: true });
  if (!safeExistsSync(BROWSER_SESSION_DIR)) safeMkdir(BROWSER_SESSION_DIR, { recursive: true });
  const sessionMetadataPath = path.join(BROWSER_SESSION_DIR, `${sessionId}.json`);

  const tracePath = path.join(EVIDENCE_DIR, `trace_${sessionId}_${Date.now()}.zip`);
  const videoDir = path.join(EVIDENCE_DIR, 'videos', sessionId);
  const resolvedVideoDir = pathResolver.rootResolve(options.video_artifact_dir || videoDir);
  if (options.record_video && !safeExistsSync(resolvedVideoDir))
    safeMkdir(resolvedVideoDir, { recursive: true });

  const browserContext = await browserRuntimeHelpers.getOrCreateBrowserContext(
    sessionId,
    userDataDir,
    sessionMetadataPath,
    options,
    resolvedVideoDir
  );

  // Start Tracing if requested
  if (options.record_trace) {
    await browserContext.tracing.start({ screenshots: true, snapshots: true, sources: true });
  }

  const runtime = browserRuntimeHelpers.getOrCreateBrowserRuntime(
    sessionId,
    browserContext,
    userDataDir,
    sessionMetadataPath
  );
  const activeLease = browserRuntimeHelpers.findBrowserRuntimeLease(runtime) as
    | BrowserRuntimeLeaseLike
    | undefined;
  if (runtime.tabs.size === 0) {
    const page = await browserContext.newPage();
    browserRuntimeHelpers.registerBrowserPage(runtime, page, 'tab-1');
  }

  let ctx = {
    ...initialCtx,
    session_id: sessionId,
    active_tab_id: runtime.activeTabId,
    browser_tabs: await browserRuntimeHelpers.summarizeTabs(runtime),
    action_trail: Array.isArray(initialCtx?.action_trail) ? initialCtx.action_trail : [],
    timestamp: new Date().toISOString(),
  };

  const traceCtx = new TraceContext(`browser-pipeline:${sessionId}`, {
    actuator: 'browser-actuator',
    pipelineId: sessionId,
  });

  const resolve = (val: any): any => resolveVars(val, ctx);

  const results = [];
  let stepIndex = 0;
  try {
    for (const step of steps) {
      state.stepCount++;
      stepIndex++;
      if (state.stepCount > MAX_STEPS)
        throw new Error(`[SAFETY_LIMIT] Exceeded maximum pipeline steps (${MAX_STEPS})`);
      if (Date.now() - state.startTime > TIMEOUT)
        throw new Error(`[SAFETY_LIMIT] Pipeline execution timed out (${TIMEOUT}ms)`);

      const spanId = traceCtx.startSpan(`${step.type}:${step.op}`, {
        stepId: (step as any).id || `step-${stepIndex}`,
      });
      const trailBefore = Array.isArray(ctx.action_trail) ? ctx.action_trail.length : 0;

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

        if (step.op === 'screenshot') {
          const screenshotPath =
            ctx.last_screenshot || ctx[step.params?.export_as || 'last_screenshot'];
          if (screenshotPath) {
            traceCtx.addArtifact('screenshot', screenshotPath, (step as any).id || 'screenshot');
          }
        }

        // Emit each new browser action as a trace event so the trail is queryable in Chronos
        if (Array.isArray(ctx.action_trail) && ctx.action_trail.length > trailBefore) {
          for (const act of (ctx.action_trail as any[]).slice(trailBefore)) {
            const attrs: Record<string, string | number | boolean> = {
              kind: String(act.kind || ''),
              op: String(act.op || ''),
            };
            if (act.tab_id) attrs.tab_id = String(act.tab_id);
            if (act.url) attrs.url = String(act.url).slice(0, 200);
            if (act.title) attrs.title = String(act.title).slice(0, 120);
            if (act.selector) attrs.selector = String(act.selector).slice(0, 200);
            traceCtx.addEvent('browser.action', attrs);
          }
        }

        traceCtx.endSpan('ok');
        results.push({ op: step.op, status: 'success' });
      } catch (err: any) {
        traceCtx.endSpan('error', err.message);

        const stepOnError = (step as any).on_error;
        if (stepOnError) {
          try {
            const { handleStepError } = await import('@agent/core');
            const recovery = await handleStepError(
              err,
              step,
              stepOnError,
              ctx,
              async (fallbackSteps: any[], errCtx: any) => {
                const res = await executePipelineInternal(
                  fallbackSteps,
                  runtime,
                  errCtx,
                  options,
                  state,
                  resolve
                );
                return res.context;
              },
              resolve as (val: any) => any
            );
            if (recovery.recovered) {
              ctx = recovery.ctx;
              results.push({ op: step.op, status: 'recovered' as any });
              continue;
            }
          } catch (_) {
            /* fallthrough */
          }
        }
        logger.error(`  [BROWSER_PIPELINE] Step failed (${step.op}): ${err.message}`);
        results.push({ op: step.op, status: 'failed', error: err.message });
        break;
      }
    }
  } finally {
    const videoRecordingEnabled = options.record_video === true;
    let finalizedVideoPaths: string[] | undefined;
    if (options.record_trace) {
      if (!safeExistsSync(EVIDENCE_DIR)) safeMkdir(EVIDENCE_DIR, { recursive: true });
      await browserContext.tracing.stop({ path: tracePath });
      logger.info(`🎞️ [BROWSER] Trace recorded at: ${tracePath}`);
      ctx.last_trace_path = tracePath;
      traceCtx.addArtifact('log', tracePath, 'playwright-trace');
    }
    ctx.browser_tabs = await browserRuntimeHelpers.summarizeTabs(runtime);
    ctx.active_tab_id = runtime.activeTabId;
    const keepAlive = options.keep_alive === true || Number(options.lease_ms || 0) > 0;
    const shouldClose = ctx.__close_browser_session === true || !keepAlive;
    const leaseExpiresAt = shouldClose
      ? undefined
      : Date.now() + Number(options.lease_ms || 5 * 60 * 1000);
    browserRuntimeHelpers.saveBrowserSessionMetadata(sessionMetadataPath, {
      session_id: sessionId,
      user_data_dir: userDataDir,
      active_tab_id: runtime.activeTabId,
      tab_count: runtime.tabs.size,
      tabs: ctx.browser_tabs,
      updated_at: new Date().toISOString(),
      last_trace_path: ctx.last_trace_path,
      last_video_paths: undefined,
      video_output_dir: videoRecordingEnabled ? resolvedVideoDir : undefined,
      video_recording_pending: videoRecordingEnabled ? !shouldClose : undefined,
      lease_expires_at: leaseExpiresAt ? new Date(leaseExpiresAt).toISOString() : undefined,
      lease_status: shouldClose ? 'released' : 'active',
      retained: !shouldClose,
      cdp_url: activeLease?.cdpUrl,
      cdp_port: activeLease?.cdpPort,
      action_trail_count: Array.isArray(ctx.action_trail) ? ctx.action_trail.length : 0,
      recent_actions: browserRuntimeHelpers.summarizeRecentActions(ctx.action_trail),
    } as any);
    if (shouldClose) {
      finalizedVideoPaths = videoRecordingEnabled
        ? await browserRuntimeHelpers.collectRecordedVideoPaths(runtime)
        : undefined;
      ctx.recorded_videos = finalizedVideoPaths || [];
      for (const vp of finalizedVideoPaths ?? []) {
        traceCtx.addArtifact('file', vp, 'browser-video');
      }
      ctx.video_output_dir = videoRecordingEnabled ? resolvedVideoDir : undefined;
      ctx.video_recording_pending = false;
      browserRuntimeHelpers.saveBrowserSessionMetadata(sessionMetadataPath, {
        session_id: sessionId,
        user_data_dir: userDataDir,
        active_tab_id: runtime.activeTabId,
        tab_count: runtime.tabs.size,
        tabs: ctx.browser_tabs,
        updated_at: new Date().toISOString(),
        last_trace_path: ctx.last_trace_path,
        last_video_paths: finalizedVideoPaths,
        video_output_dir: videoRecordingEnabled ? resolvedVideoDir : undefined,
        video_recording_pending: false,
        lease_status: 'released',
        retained: false,
        cdp_url: activeLease?.cdpUrl,
        cdp_port: activeLease?.cdpPort,
        action_trail_count: Array.isArray(ctx.action_trail) ? ctx.action_trail.length : 0,
        recent_actions: browserRuntimeHelpers.summarizeRecentActions(ctx.action_trail),
      } as any);
      await browserContext.close();
    } else {
      ctx.recorded_videos = [];
      ctx.video_output_dir = videoRecordingEnabled ? resolvedVideoDir : undefined;
      ctx.video_recording_pending = videoRecordingEnabled;
    }
  }

  const trace = traceCtx.finalize();
  ctx.trace = trace;
  ctx.trace_summary = traceCtx.summary();
  try {
    const persistedTracePath = persistTrace(trace);
    ctx.trace_persisted_path = persistedTracePath;
  } catch (err: any) {
    logger.warn(`[BROWSER_PIPELINE] Failed to persist trace: ${err?.message || err}`);
  }

  return {
    status: derivePipelineStatus(results),
    results,
    context: ctx,
    total_steps: state.stepCount,
  };
}

async function executePipelineInternal(
  steps: PipelineStep[],
  runtime: BrowserRuntime,
  ctx: any,
  options: any,
  state: any,
  resolve: Function
) {
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
      const stepOnError = (step as any).on_error;
      if (stepOnError) {
        try {
          const { handleStepError } = await import('@agent/core');
          const recovery = await handleStepError(
            err,
            step,
            stepOnError,
            ctx,
            async (fallbackSteps: any[], errCtx: any) => {
              const res = await executePipelineInternal(
                fallbackSteps,
                runtime,
                errCtx,
                options,
                state,
                resolve
              );
              return res.context;
            },
            resolve as (val: any) => any
          );
          if (recovery.recovered) {
            ctx = recovery.ctx;
            results.push({ op: step.op, status: 'recovered' as any });
            continue;
          }
        } catch (_) {}
      }
      results.push({ op: step.op, status: 'failed', error: err.message });
      break;
    }
  }
  return { context: ctx };
}

async function opControl(
  op: string,
  params: any,
  runtime: BrowserRuntime,
  ctx: any,
  options: any,
  state: any,
  resolve: Function
) {
  switch (op) {
    case 'open_tab': {
      const page = await runtime.context.newPage();
      const tabId = params.tab_id || `tab-${runtime.tabs.size + 1}`;
      browserRuntimeHelpers.registerBrowserPage(runtime, page, tabId);
      if (params.url) {
        await page.goto(resolve(params.url), { waitUntil: params.waitUntil || 'networkidle' });
      }
      if (params.select !== false) runtime.activeTabId = tabId;
      return browserRuntimeHelpers.recordBrowserAction(
        {
          ...ctx,
          active_tab_id: runtime.activeTabId,
          browser_tabs: await browserRuntimeHelpers.summarizeTabs(runtime),
        },
        {
          kind: 'control',
          op: 'open_tab',
          tab_id: tabId,
          url: params.url ? resolve(params.url) : undefined,
        }
      );
    }
    case 'select_tab': {
      const tabId = resolve(params.tab_id);
      if (!runtime.tabs.has(tabId)) throw new Error(`Unknown browser tab: ${tabId}`);
      runtime.activeTabId = tabId;
      return browserRuntimeHelpers.recordBrowserAction(
        {
          ...ctx,
          active_tab_id: runtime.activeTabId,
          browser_tabs: await browserRuntimeHelpers.summarizeTabs(runtime),
        },
        {
          kind: 'control',
          op: 'select_tab',
          tab_id: tabId,
        }
      );
    }
    case 'select_tab_matching': {
      const urlIncludes = params.url_includes ? String(resolve(params.url_includes)) : undefined;
      const titleIncludes = params.title_includes
        ? String(resolve(params.title_includes))
        : undefined;
      if (!urlIncludes && !titleIncludes) {
        throw new Error('select_tab_matching requires url_includes or title_includes');
      }

      let selected: { tabId: string; page: Page; url: string; title: string } | undefined;
      for (const [tabId, page] of runtime.tabs.entries()) {
        if (typeof page.isClosed === 'function' && page.isClosed()) continue;
        const url = page.url();
        const title = await page.title();
        if (urlIncludes && !url.includes(urlIncludes)) continue;
        if (titleIncludes && !title.includes(titleIncludes)) continue;
        selected = { tabId, page, url, title };
        break;
      }

      if (!selected) {
        throw new Error(
          `No browser tab matched url_includes=${urlIncludes || '*'} title_includes=${titleIncludes || '*'}`
        );
      }

      runtime.activeTabId = selected.tabId;
      if (typeof (selected.page as any).bringToFront === 'function') {
        await (selected.page as any).bringToFront();
      }
      return browserRuntimeHelpers.recordBrowserAction(
        {
          ...ctx,
          active_tab_id: runtime.activeTabId,
          browser_tabs: await browserRuntimeHelpers.summarizeTabs(runtime),
        },
        {
          kind: 'control',
          op: 'select_tab_matching',
          tab_id: selected.tabId,
          url: selected.url,
        }
      );
    }
    case 'close_session':
      return browserRuntimeHelpers.recordBrowserAction(
        {
          ...ctx,
          __close_browser_session: true,
        },
        {
          kind: 'control',
          op: 'close_session',
          tab_id: runtime.activeTabId,
        }
      );
    case 'pause_for_operator': {
      const message = resolve(
        params.message || 'Operator input required. Press Enter to continue.'
      );
      await browserRuntimeHelpers.waitForOperatorContinue({
        sessionId: ctx.session_id || 'default',
        message,
        continueFile: params.continue_file
          ? pathResolver.rootResolve(resolve(params.continue_file))
          : undefined,
        pollMs: Number(params.poll_ms || 250),
        timeoutMs: params.timeout_ms ? Number(params.timeout_ms) : undefined,
      });
      return browserRuntimeHelpers.recordBrowserAction(ctx, {
        kind: 'control',
        op: 'pause_for_operator',
        tab_id: runtime.activeTabId,
      });
    }
    case 'if':
      if (evaluateCondition(params.condition, ctx)) {
        const res = await executePipelineInternal(
          params.then,
          runtime,
          ctx,
          options,
          state,
          resolve
        );
        return res.context;
      } else if (params.else) {
        const res = await executePipelineInternal(
          params.else,
          runtime,
          ctx,
          options,
          state,
          resolve
        );
        return res.context;
      }
      return ctx;
    case 'while':
      let iterations = 0;
      const maxIter = params.max_iterations || 100;
      while (evaluateCondition(params.condition, ctx) && iterations < maxIter) {
        const res = await executePipelineInternal(
          params.pipeline,
          runtime,
          ctx,
          options,
          state,
          resolve
        );
        ctx = res.context;
        iterations++;
      }
      return ctx;
    case 'setup_passkey_authenticator': {
      const page = browserRuntimeHelpers.getActivePage(runtime);
      const setup = await setupVirtualPasskeyAuthenticator(runtime, page, {
        enableUI: params.enable_ui === true,
        replaceExisting: params.replace_existing !== false,
        protocol: resolve(params.protocol || 'ctap2') as 'ctap2' | 'u2f',
        transport: resolve(params.transport || 'internal') as 'usb' | 'nfc' | 'ble' | 'internal',
        hasResidentKey: params.has_resident_key !== false,
        hasUserVerification: params.has_user_verification !== false,
        hasLargeBlob: params.has_large_blob === true,
        automaticPresenceSimulation: params.automatic_presence !== false,
        isUserVerified: params.user_verified !== false,
      });
      return browserRuntimeHelpers.recordBrowserAction(
        {
          ...ctx,
          [params.export_as || 'passkey_authenticator']: setup,
        },
        {
          kind: 'control',
          op: 'setup_passkey_authenticator',
          tab_id: runtime.activeTabId,
        }
      );
    }
    case 'remove_passkey_authenticator': {
      const page = browserRuntimeHelpers.getActivePage(runtime);
      await removeVirtualPasskeyAuthenticator(runtime, page);
      return browserRuntimeHelpers.recordBrowserAction(ctx, {
        kind: 'control',
        op: 'remove_passkey_authenticator',
        tab_id: runtime.activeTabId,
      });
    }
    case 'ref': {
      const { resolveRef } = await import('@agent/core');
      const refPath = resolve(params.path);
      const bindResolved: Record<string, any> = {};
      if (params.bind) {
        for (const [k, v] of Object.entries(params.bind as Record<string, any>)) {
          bindResolved[k] = resolve(v);
        }
      }
      const refResult = await resolveRef(refPath, bindResolved, ctx, resolve as (val: any) => any);
      const subResult = await executePipelineInternal(
        refResult.steps,
        runtime,
        { ...ctx, ...refResult.mergedCtx },
        options,
        state,
        resolve
      );
      if (params.export_as) {
        ctx = { ...ctx, [params.export_as]: subResult.context };
      } else {
        const { _refDepth, ...subCtxClean } = subResult.context || {};
        ctx = { ...ctx, ...subCtxClean };
      }
      return browserRuntimeHelpers.recordBrowserAction(ctx, {
        kind: 'control',
        op: 'ref',
        tab_id: runtime.activeTabId,
      });
    }
    default:
      throw new Error(`Unsupported control operator in Browser-Actuator: ${op}`);
  }
}

async function opCapture(
  op: string,
  params: any,
  runtime: BrowserRuntime,
  ctx: any,
  resolve: Function
) {
  const page = browserRuntimeHelpers.getActivePage(runtime);
  switch (op) {
    case 'goto': {
      const url = resolve(params.url);
      await page.goto(url, { waitUntil: params.waitUntil || 'networkidle' });
      return browserRuntimeHelpers.recordBrowserAction(
        { ...ctx, last_url: page.url() },
        {
          kind: 'capture',
          op: 'goto',
          tab_id: runtime.activeTabId,
          url,
        }
      );
    }
    case 'tabs':
      return browserRuntimeHelpers.recordBrowserAction(
        {
          ...ctx,
          browser_tabs: await browserRuntimeHelpers.summarizeTabs(runtime),
          [params.export_as || 'browser_tabs']: await browserRuntimeHelpers.summarizeTabs(runtime),
        },
        {
          kind: 'capture',
          op: 'tabs',
          tab_id: runtime.activeTabId,
        }
      );
    case 'snapshot': {
      const snapshot = await browserRuntimeHelpers.buildSnapshot(page, {
        sessionId: ctx.session_id || 'default',
        tabId: runtime.activeTabId,
        maxElements: Number(params.max_elements || 200),
      });
      browserRuntimeHelpers.saveBrowserSessionSnapshot(ctx.session_id || 'default', snapshot);
      return browserRuntimeHelpers.recordBrowserAction(
        {
          ...ctx,
          last_snapshot: snapshot,
          last_capture: snapshot,
          ref_map: Object.fromEntries(
            snapshot.elements.map((element) => [element.ref, element.selector])
          ),
          [params.export_as || 'last_snapshot']: snapshot,
        },
        {
          kind: 'capture',
          op: 'snapshot',
          tab_id: runtime.activeTabId,
          url: snapshot.url,
          title: snapshot.title,
        }
      );
    }
    case 'console':
      return browserRuntimeHelpers.recordBrowserAction(
        {
          ...ctx,
          [params.export_as || 'console_events']: runtime.consoleEvents.slice(
            -(params.limit || 50)
          ),
        },
        {
          kind: 'capture',
          op: 'console',
          tab_id: runtime.activeTabId,
        }
      );
    case 'network':
      return browserRuntimeHelpers.recordBrowserAction(
        {
          ...ctx,
          [params.export_as || 'network_events']: runtime.networkEvents.slice(
            -(params.limit || 50)
          ),
        },
        {
          kind: 'capture',
          op: 'network',
          tab_id: runtime.activeTabId,
        }
      );
    case 'screenshot': {
      const outPath = pathResolver.rootResolve(
        resolve(params.path || `evidence/browser/screenshot_${Date.now()}.png`)
      );
      logger.info(`📸 [BROWSER] Taking screenshot to: ${outPath}`);
      if (!safeExistsSync(path.dirname(outPath)))
        safeMkdir(path.dirname(outPath), { recursive: true });
      await page.screenshot({ path: outPath, fullPage: params.fullPage });
      return browserRuntimeHelpers.recordBrowserAction(
        { ...ctx, [params.export_as || 'last_screenshot']: outPath },
        {
          kind: 'capture',
          op: 'screenshot',
          tab_id: runtime.activeTabId,
          url: page.url(),
        }
      );
    }
    case 'content': {
      const selector = params.selector ? resolve(params.selector) : undefined;
      const content = selector ? await page.innerText(selector) : await page.content();
      return browserRuntimeHelpers.recordBrowserAction(
        { ...ctx, [params.export_as || 'last_capture']: content },
        {
          kind: 'capture',
          op: 'content',
          tab_id: runtime.activeTabId,
          selector,
          content_excerpt: typeof content === 'string' ? content.trim().slice(0, 120) : undefined,
        }
      );
    }
    case 'evaluate':
      return browserRuntimeHelpers.recordBrowserAction(
        { ...ctx, [params.export_as || 'last_capture']: await page.evaluate(params.script) },
        {
          kind: 'capture',
          op: 'evaluate',
          tab_id: runtime.activeTabId,
        }
      );
    case 'query_elements': {
      // Count visible elements matching a selector (and optional text). Result is
      // stored to `export_as` so a `while`/`if` condition can read it — the
      // declarative equivalent of "is there still a button to process?".
      const selector = resolve(params.selector || '*');
      const textMatch =
        params.text != null
          ? String(resolve(params.text))
          : params.text_match != null
            ? String(resolve(params.text_match))
            : null;
      const exact = params.exact === true;
      const count = await page.evaluate(
        (args: { selector: string; textMatch: string | null; exact: boolean }) => {
          const els = Array.from(document.querySelectorAll(args.selector)) as HTMLElement[];
          const visible = els.filter((el) => el.offsetParent !== null);
          if (args.textMatch == null) return visible.length;
          return visible.filter((el) => {
            const label = (el.textContent || (el as HTMLInputElement).value || '').trim();
            return args.exact ? label === args.textMatch : label.includes(args.textMatch);
          }).length;
        },
        { selector, textMatch, exact }
      );
      return browserRuntimeHelpers.recordBrowserAction(
        { ...ctx, [params.export_as || 'element_count']: count },
        { kind: 'capture', op: 'query_elements', tab_id: runtime.activeTabId, selector }
      );
    }
    case 'passkey_credentials': {
      const credentials = await getVirtualPasskeyCredentials(runtime, page);
      return browserRuntimeHelpers.recordBrowserAction(
        {
          ...ctx,
          [params.export_as || 'passkey_credentials']: credentials,
        },
        {
          kind: 'capture',
          op: 'passkey_credentials',
          tab_id: runtime.activeTabId,
        }
      );
    }
    case 'passkey_events':
      return browserRuntimeHelpers.recordBrowserAction(
        {
          ...ctx,
          [params.export_as || 'passkey_events']: runtime.webAuthn?.events || [],
        },
        {
          kind: 'capture',
          op: 'passkey_events',
          tab_id: runtime.activeTabId,
        }
      );
    case 'export_session_handoff': {
      const targetUrl = String(resolve(params.target_url || page.url())).trim();
      const origin = browserRuntimeHelpers.deriveOrigin(targetUrl || page.url());
      const handoff = await browserRuntimeHelpers.buildSessionHandoff(page, runtime, ctx, {
        targetUrl,
        origin,
        browserSessionId: resolve(params.browser_session_id || ctx.session_id || 'default'),
        preferPersistentContext: params.prefer_persistent_context !== false,
      });
      const outPath = params.path ? pathResolver.rootResolve(resolve(params.path)) : undefined;
      if (outPath) {
        if (!safeExistsSync(path.dirname(outPath)))
          safeMkdir(path.dirname(outPath), { recursive: true });
        safeWriteFile(outPath, JSON.stringify(handoff, null, 2));
      }
      return browserRuntimeHelpers.recordBrowserAction(
        {
          ...ctx,
          [params.export_as || 'session_handoff']: handoff,
          ...(outPath ? { session_handoff_path: outPath } : {}),
        },
        {
          kind: 'capture',
          op: 'export_session_handoff',
          tab_id: runtime.activeTabId,
          url: targetUrl,
        }
      );
    }
    case 'title':
      return browserRuntimeHelpers.recordBrowserAction(
        { ...ctx, [params.export_as || 'page_title']: await page.title() },
        {
          kind: 'capture',
          op: 'title',
          tab_id: runtime.activeTabId,
        }
      );
    case 'url':
      return browserRuntimeHelpers.recordBrowserAction(
        { ...ctx, [params.export_as || 'current_url']: page.url() },
        {
          kind: 'capture',
          op: 'url',
          tab_id: runtime.activeTabId,
        }
      );
    default:
      throw new Error(`Unsupported capture operator in Browser-Actuator: ${op}`);
  }
}

async function opTransform(op: string, params: any, ctx: any, resolve: Function) {
  switch (op) {
    case 'regex_extract': {
      const input = String(ctx[params.from || 'last_capture'] || '');
      const match = input.match(new RegExp(params.pattern, 'm'));
      return { ...ctx, [params.export_as]: match ? match[1] : null };
    }
    case 'json_query': {
      const data = ctx[params.from || 'last_capture'];
      const res = getPathValue(data, params.path);
      return { ...ctx, [params.export_as]: res };
    }
    case 'export_playwright': {
      const trail = browserRuntimeHelpers.readRecordedActions(ctx, params.from);
      const outPath = pathResolver.rootResolve(
        resolve(
          params.path ||
            `active/shared/tmp/browser/${ctx.session_id || 'default'}-playwright.spec.ts`
        )
      );
      if (!safeExistsSync(path.dirname(outPath)))
        safeMkdir(path.dirname(outPath), { recursive: true });
      const content = browserRuntimeHelpers.renderPlaywrightSkeleton(trail, {
        assertions: params.assertions === 'hint' ? 'hint' : 'strict',
      });
      safeWriteFile(outPath, content);
      return { ...ctx, [params.export_as || 'playwright_spec_path']: outPath };
    }
    case 'export_adf': {
      const trail = browserRuntimeHelpers.readRecordedActions(ctx, params.from);
      const outPath = pathResolver.rootResolve(
        resolve(
          params.path || `active/shared/tmp/browser/${ctx.session_id || 'default'}-pipeline.json`
        )
      );
      if (!safeExistsSync(path.dirname(outPath)))
        safeMkdir(path.dirname(outPath), { recursive: true });
      const adf = browserRuntimeHelpers.renderBrowserAdf(trail, ctx.session_id || 'default');
      safeWriteFile(outPath, JSON.stringify(adf, null, 2));
      return { ...ctx, [params.export_as || 'adf_path']: outPath };
    }
    default:
      throw new Error(`Unsupported transform operator in Browser-Actuator: ${op}`);
  }
}

async function opApply(
  op: string,
  params: any,
  runtime: BrowserRuntime,
  ctx: any,
  resolve: Function
) {
  const page = browserRuntimeHelpers.getActivePage(runtime);
  switch (op) {
    case 'goto': {
      const url = resolve(params.url);
      await retry(async () => {
        await page.goto(url, { waitUntil: params.waitUntil || 'networkidle' });
      }, buildRetryOptions(params));
      return browserRuntimeHelpers.recordBrowserAction(
        { ...ctx, last_url: page.url() },
        {
          kind: 'apply',
          op: 'goto',
          tab_id: runtime.activeTabId,
          url,
        }
      );
    }
    case 'click':
      await retry(async () => {
        await page.click(resolve(params.selector), { timeout: params.timeout || 5000 });
      }, buildRetryOptions(params));
      return browserRuntimeHelpers.recordBrowserAction(ctx, {
        kind: 'apply',
        op: 'click',
        tab_id: runtime.activeTabId,
        selector: resolve(params.selector),
      });
    case 'click_first_match': {
      // Click the first VISIBLE element matching any of the fallback selectors
      // (optionally constrained by text). Declarative resilience against UIs that
      // vary their markup (the equivalent of try-these-selectors-in-order).
      const selectors = (Array.isArray(params.selectors) ? params.selectors : [params.selector])
        .filter(Boolean)
        .map((sel: string) => resolve(sel));
      const text = params.text != null ? String(resolve(params.text)) : null;
      const exact = params.exact === true;
      const clicked = await page.evaluate(
        (args: { selectors: string[]; text: string | null; exact: boolean }) => {
          for (const selector of args.selectors) {
            const els = Array.from(document.querySelectorAll(selector)) as HTMLElement[];
            for (const el of els) {
              if (el.offsetParent === null) continue; // visible only
              const label = (el.textContent || (el as HTMLInputElement).value || '').trim();
              if (
                args.text != null &&
                !(args.exact ? label === args.text : label.includes(args.text))
              )
                continue;
              el.click();
              return label || selector;
            }
          }
          return null;
        },
        { selectors, text, exact }
      );
      return browserRuntimeHelpers.recordBrowserAction(
        { ...ctx, [params.export_as || 'clicked_match']: clicked },
        {
          kind: 'apply',
          op: 'click_first_match',
          tab_id: runtime.activeTabId,
          text: clicked ?? '(none)',
        }
      );
    }
    case 'fill':
      await retry(async () => {
        await page.fill(resolve(params.selector), resolve(params.text), {
          timeout: params.timeout || 5000,
        });
      }, buildRetryOptions(params));
      return browserRuntimeHelpers.recordBrowserAction(ctx, {
        kind: 'apply',
        op: 'fill',
        tab_id: runtime.activeTabId,
        selector: resolve(params.selector),
        text: resolve(params.text),
      });
    case 'press':
      await retry(async () => {
        await page.press(resolve(params.selector), resolve(params.key), {
          timeout: params.timeout || 5000,
        });
      }, buildRetryOptions(params));
      return browserRuntimeHelpers.recordBrowserAction(ctx, {
        kind: 'apply',
        op: 'press',
        tab_id: runtime.activeTabId,
        selector: resolve(params.selector),
        key: resolve(params.key),
      });
    case 'click_ref': {
      const ref = resolve(params.ref);
      const selector = browserRuntimeHelpers.resolveRefSelector(ctx, ref);
      const element = browserRuntimeHelpers.findSnapshotElement(ctx, ref);
      await retry(async () => {
        await page.click(selector, { timeout: params.timeout || 5000 });
      }, buildRetryOptions(params));
      return browserRuntimeHelpers.recordBrowserAction(ctx, {
        kind: 'apply',
        op: 'click_ref',
        tab_id: runtime.activeTabId,
        ref,
        selector,
        element_name: element?.name,
        element_role: element?.role,
      });
    }
    case 'fill_ref': {
      const ref = resolve(params.ref);
      const text = resolve(params.text);
      const selector = browserRuntimeHelpers.resolveRefSelector(ctx, ref);
      const element = browserRuntimeHelpers.findSnapshotElement(ctx, ref);
      await retry(async () => {
        await page.fill(selector, text, { timeout: params.timeout || 5000 });
      }, buildRetryOptions(params));
      return browserRuntimeHelpers.recordBrowserAction(ctx, {
        kind: 'apply',
        op: 'fill_ref',
        tab_id: runtime.activeTabId,
        ref,
        selector,
        text,
        element_name: element?.name,
        element_role: element?.role,
      });
    }
    case 'press_ref': {
      const ref = resolve(params.ref);
      const key = resolve(params.key);
      const selector = browserRuntimeHelpers.resolveRefSelector(ctx, ref);
      const element = browserRuntimeHelpers.findSnapshotElement(ctx, ref);
      await retry(async () => {
        await page.press(selector, key, { timeout: params.timeout || 5000 });
      }, buildRetryOptions(params));
      return browserRuntimeHelpers.recordBrowserAction(ctx, {
        kind: 'apply',
        op: 'press_ref',
        tab_id: runtime.activeTabId,
        ref,
        selector,
        key,
        element_name: element?.name,
        element_role: element?.role,
      });
    }
    case 'wait':
      if (params.selector) {
        await retry(async () => {
          await page.waitForSelector(resolve(params.selector), {
            state: params.state || 'visible',
            timeout: params.timeout || 10000,
          });
        }, buildRetryOptions(params));
      } else {
        await page.waitForTimeout(params.duration || 1000);
      }
      return browserRuntimeHelpers.recordBrowserAction(ctx, {
        kind: 'apply',
        op: 'wait',
        tab_id: runtime.activeTabId,
        selector: params.selector ? resolve(params.selector) : undefined,
      });
    case 'wait_ref': {
      const ref = resolve(params.ref);
      const selector = browserRuntimeHelpers.resolveRefSelector(ctx, ref);
      await retry(async () => {
        await page.waitForSelector(selector, {
          state: params.state || 'visible',
          timeout: params.timeout || 10000,
        });
      }, buildRetryOptions(params));
      return browserRuntimeHelpers.recordBrowserAction(ctx, {
        kind: 'apply',
        op: 'wait_ref',
        tab_id: runtime.activeTabId,
        ref,
        selector,
      });
    }
    case 'log':
      logger.info(`[BROWSER_LOG] ${resolve(params.message || 'Action completed')}`);
      return browserRuntimeHelpers.recordBrowserAction(ctx, {
        kind: 'apply',
        op: 'log',
        tab_id: runtime.activeTabId,
      });
    case 'list_profiles': {
      let managedProfiles: string[] = [];
      let nativeProfiles: string[] = [];
      const lease = browserRuntimeHelpers.findBrowserRuntimeLease(runtime) as
        | BrowserRuntimeLeaseLike
        | undefined;
      try {
        const managedDir = pathResolver.rootResolve('active/shared/runtime/browser/profiles');
        if (safeExistsSync(managedDir)) {
          managedProfiles = (await safeReaddir(managedDir)).filter(
            (name) =>
              !name.startsWith('.') &&
              (safeExistsSync(path.join(managedDir, name, 'Preferences')) ||
                safeExistsSync(path.join(managedDir, name, 'Default', 'Preferences')))
          );
        }
      } catch (e) {
        /* ignore */
      }
      try {
        if (lease && safeExistsSync(lease.userDataDir)) {
          nativeProfiles = (await safeReaddir(lease.userDataDir)).filter(
            (name) => name === 'Default' || name.startsWith('Profile ')
          );
        }
      } catch (e) {
        /* ignore */
      }

      const profilesList = {
        managed: managedProfiles,
        native: nativeProfiles,
      };

      if (params.export_as) {
        ctx[params.export_as] = profilesList;
      }
      return browserRuntimeHelpers.recordBrowserAction(ctx, {
        kind: 'apply',
        op: 'list_profiles',
        tab_id: runtime.activeTabId,
      });
    }
    case 'set_passkey_user_verified': {
      const authenticatorId = getPasskeyAuthenticatorId(runtime);
      const cdp = await getOrCreatePageCdpSession(runtime, page);
      await cdp.send('WebAuthn.setUserVerified', {
        authenticatorId,
        isUserVerified: params.is_user_verified !== false,
      });
      return browserRuntimeHelpers.recordBrowserAction(ctx, {
        kind: 'apply',
        op: 'set_passkey_user_verified',
        tab_id: runtime.activeTabId,
      });
    }
    case 'set_passkey_presence': {
      const authenticatorId = getPasskeyAuthenticatorId(runtime);
      const cdp = await getOrCreatePageCdpSession(runtime, page);
      await cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
        authenticatorId,
        enabled: params.enabled !== false,
      });
      return browserRuntimeHelpers.recordBrowserAction(ctx, {
        kind: 'apply',
        op: 'set_passkey_presence',
        tab_id: runtime.activeTabId,
      });
    }
    case 'clear_passkey_credentials': {
      const authenticatorId = getPasskeyAuthenticatorId(runtime);
      const cdp = await getOrCreatePageCdpSession(runtime, page);
      await cdp.send('WebAuthn.clearCredentials', { authenticatorId });
      if (runtime.webAuthn) runtime.webAuthn.credentials = [];
      return browserRuntimeHelpers.recordBrowserAction(ctx, {
        kind: 'apply',
        op: 'clear_passkey_credentials',
        tab_id: runtime.activeTabId,
      });
    }
    case 'register_passkey': {
      const registration = await registerPasskey(page, runtime, ctx, params, resolve);
      return browserRuntimeHelpers.recordBrowserAction(
        {
          ...ctx,
          [params.export_as || 'passkey_registration']: registration,
          passkey_credentials: registration.credentials,
        },
        {
          kind: 'apply',
          op: 'register_passkey',
          tab_id: runtime.activeTabId,
        }
      );
    }
    case 'authenticate_passkey': {
      const authentication = await authenticatePasskey(page, runtime, ctx, params, resolve);
      return browserRuntimeHelpers.recordBrowserAction(
        {
          ...ctx,
          [params.export_as || 'passkey_authentication']: authentication,
          passkey_credentials: authentication.credentials,
        },
        {
          kind: 'apply',
          op: 'authenticate_passkey',
          tab_id: runtime.activeTabId,
        }
      );
    }
    case 'delete_passkey': {
      const deletion = await deletePasskey(page, runtime, ctx, params, resolve);
      return browserRuntimeHelpers.recordBrowserAction(
        {
          ...ctx,
          [params.export_as || 'passkey_deletion']: deletion,
          passkey_credentials: deletion.credentials,
        },
        {
          kind: 'apply',
          op: 'delete_passkey',
          tab_id: runtime.activeTabId,
        }
      );
    }
    case 'import_session_handoff': {
      const handoff = await browserRuntimeHelpers.resolveSessionHandoff(
        params,
        ctx,
        resolve as (value: any) => any
      );
      if (Array.isArray(handoff.cookies) && handoff.cookies.length > 0) {
        await runtime.context.addCookies(handoff.cookies as any);
      }
      if (handoff.headers && Object.keys(handoff.headers).length > 0) {
        await runtime.context.setExtraHTTPHeaders(handoff.headers as Record<string, string>);
      }
      const targetUrl = String(handoff.target_url || resolve(params.target_url || '')).trim();
      if (!targetUrl) throw new Error('import_session_handoff requires a target_url');
      await page.goto(targetUrl, { waitUntil: params.waitUntil || 'domcontentloaded' });
      if (
        (handoff.local_storage && Object.keys(handoff.local_storage).length > 0) ||
        (handoff.session_storage && Object.keys(handoff.session_storage).length > 0)
      ) {
        await page.evaluate(
          ({ localStorageEntries, sessionStorageEntries }) => {
            for (const [key, value] of Object.entries(localStorageEntries || {})) {
              window.localStorage.setItem(key, String(value));
            }
            for (const [key, value] of Object.entries(sessionStorageEntries || {})) {
              window.sessionStorage.setItem(key, String(value));
            }
          },
          {
            localStorageEntries: handoff.local_storage || {},
            sessionStorageEntries: handoff.session_storage || {},
          }
        );
        if (params.reload_after_import !== false) {
          await page.reload({ waitUntil: params.waitUntil || 'domcontentloaded' });
        }
      }
      return browserRuntimeHelpers.recordBrowserAction(
        {
          ...ctx,
          [params.export_as || 'imported_session_handoff']: handoff,
          last_url: page.url(),
        },
        {
          kind: 'apply',
          op: 'import_session_handoff',
          tab_id: runtime.activeTabId,
          url: targetUrl,
        }
      );
    }
    default:
      throw new Error(`Unsupported apply operator in Browser-Actuator: ${op}`);
  }
}

function getPasskeyPreset(provider?: string) {
  const catalog = loadPasskeyProviderCatalog();
  const presetKey = provider || catalog.default_provider || 'webauthn.io';
  const preset = catalog.providers?.[presetKey];
  if (!preset) {
    throw new Error(`Unsupported passkey provider: ${presetKey}`);
  }
  return preset;
}

function loadPasskeyProviderCatalog(): {
  default_provider?: string;
  providers: Record<string, any>;
} {
  const passkeyProviderCatalogPath = pathResolver.knowledge(
    'product/orchestration/browser-passkey-providers.json'
  );
  if (safeExistsSync(passkeyProviderCatalogPath)) {
    try {
      const parsed = JSON.parse(
        safeReadFile(passkeyProviderCatalogPath, { encoding: 'utf8' }) as string
      );
      if (parsed && typeof parsed === 'object' && parsed.providers) return parsed;
    } catch (_) {}
  }

  return {
    default_provider: 'webauthn.io',
    providers: {
      'webauthn.io': {
        baseUrl: 'https://webauthn.io/',
        usernameSelector: '#input-email',
        registerSelector: '#register-button',
        authenticateSelector: '#login-button',
        postAuthUrlIncludes: '/profile',
      },
    },
  };
}

async function getOrCreatePageCdpSession(runtime: BrowserRuntime, page: Page): Promise<CDPSession> {
  const existing = runtime.cdpSessions.get(page);
  if (existing) return existing;
  const session = await runtime.context.newCDPSession(page);
  runtime.cdpSessions.set(page, session);
  attachWebAuthnObservers(runtime, session);
  return session;
}

function attachWebAuthnObservers(runtime: BrowserRuntime, session: CDPSession): void {
  if (!runtime.webAuthn) {
    runtime.webAuthn = { enabled: false, credentials: [], events: [] };
  }

  session.on('WebAuthn.credentialAdded', (event: any) => {
    runtime.webAuthn!.events.push({
      type: 'credentialAdded',
      credential: event.credential,
      ts: new Date().toISOString(),
    });
    runtime.webAuthn!.credentials = upsertPasskeyCredential(
      runtime.webAuthn!.credentials,
      event.credential
    );
  });
  session.on('WebAuthn.credentialAsserted', (event: any) => {
    runtime.webAuthn!.events.push({
      type: 'credentialAsserted',
      credential: event.credential,
      ts: new Date().toISOString(),
    });
    runtime.webAuthn!.credentials = upsertPasskeyCredential(
      runtime.webAuthn!.credentials,
      event.credential
    );
  });
  session.on('WebAuthn.credentialDeleted', (event: any) => {
    runtime.webAuthn!.events.push({
      type: 'credentialDeleted',
      credentialId: event.credentialId,
      ts: new Date().toISOString(),
    });
    runtime.webAuthn!.credentials = runtime.webAuthn!.credentials.filter(
      (credential) => credential.credentialId !== event.credentialId
    );
  });
  session.on('WebAuthn.credentialUpdated', (event: any) => {
    runtime.webAuthn!.events.push({
      type: 'credentialUpdated',
      credential: event.credential,
      ts: new Date().toISOString(),
    });
    runtime.webAuthn!.credentials = upsertPasskeyCredential(
      runtime.webAuthn!.credentials,
      event.credential
    );
  });
}

async function setupVirtualPasskeyAuthenticator(
  runtime: BrowserRuntime,
  page: Page,
  options: {
    enableUI: boolean;
    replaceExisting: boolean;
    protocol: 'ctap2' | 'u2f';
    transport: 'usb' | 'nfc' | 'ble' | 'internal';
    hasResidentKey: boolean;
    hasUserVerification: boolean;
    hasLargeBlob: boolean;
    automaticPresenceSimulation: boolean;
    isUserVerified: boolean;
  }
): Promise<Record<string, any>> {
  const cdp = await getOrCreatePageCdpSession(runtime, page);
  await cdp.send('WebAuthn.enable', { enableUI: options.enableUI });

  if (!runtime.webAuthn) {
    runtime.webAuthn = { enabled: true, credentials: [], events: [] };
  }
  runtime.webAuthn.enabled = true;

  if (options.replaceExisting !== false && runtime.webAuthn.authenticatorId) {
    await cdp.send('WebAuthn.removeVirtualAuthenticator', {
      authenticatorId: runtime.webAuthn.authenticatorId,
    });
    runtime.webAuthn.credentials = [];
  }

  const authenticator = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: options.protocol,
      transport: options.transport,
      hasResidentKey: options.hasResidentKey,
      hasUserVerification: options.hasUserVerification,
      hasLargeBlob: options.hasLargeBlob,
      automaticPresenceSimulation: options.automaticPresenceSimulation,
      isUserVerified: options.isUserVerified,
    },
  });

  runtime.webAuthn.authenticatorId = authenticator.authenticatorId;
  runtime.webAuthn.options = {
    protocol: options.protocol,
    transport: options.transport,
    hasResidentKey: options.hasResidentKey,
    hasUserVerification: options.hasUserVerification,
    hasLargeBlob: options.hasLargeBlob,
    automaticPresenceSimulation: options.automaticPresenceSimulation,
    isUserVerified: options.isUserVerified,
  };

  await cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
    authenticatorId: authenticator.authenticatorId,
    enabled: options.automaticPresenceSimulation,
  });
  await cdp.send('WebAuthn.setUserVerified', {
    authenticatorId: authenticator.authenticatorId,
    isUserVerified: options.isUserVerified,
  });

  return {
    authenticator_id: authenticator.authenticatorId,
    ...runtime.webAuthn.options,
  };
}

async function removeVirtualPasskeyAuthenticator(
  runtime: BrowserRuntime,
  page: Page
): Promise<void> {
  const authenticatorId = getPasskeyAuthenticatorId(runtime);
  const cdp = await getOrCreatePageCdpSession(runtime, page);
  await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
  runtime.webAuthn = {
    enabled: true,
    credentials: [],
    events: [],
  };
}

async function getVirtualPasskeyCredentials(
  runtime: BrowserRuntime,
  page: Page
): Promise<Array<Record<string, any>>> {
  const authenticatorId = getPasskeyAuthenticatorId(runtime);
  const cdp = await getOrCreatePageCdpSession(runtime, page);
  const result = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  const credentials = Array.isArray(result.credentials) ? result.credentials : [];
  if (!runtime.webAuthn) {
    runtime.webAuthn = { enabled: true, authenticatorId, credentials: [], events: [] };
  }
  runtime.webAuthn.credentials = credentials;
  return credentials;
}

function getPasskeyAuthenticatorId(runtime: BrowserRuntime): string {
  const authenticatorId = runtime.webAuthn?.authenticatorId;
  if (!authenticatorId) {
    throw new Error(
      'No virtual passkey authenticator is active. Run setup_passkey_authenticator first.'
    );
  }
  return authenticatorId;
}

function upsertPasskeyCredential(
  credentials: Array<Record<string, any>>,
  nextCredential: Record<string, any> | undefined
): Array<Record<string, any>> {
  if (!nextCredential?.credentialId) return credentials;
  const next = credentials.filter(
    (credential) => credential.credentialId !== nextCredential.credentialId
  );
  next.push(nextCredential);
  return next;
}

async function registerPasskey(
  page: Page,
  runtime: BrowserRuntime,
  ctx: any,
  params: any,
  resolve: Function
) {
  const preset = getPasskeyPreset(resolve(params.provider));
  const username = String(resolve(params.username ?? ctx.username ?? 'kyberion_passkey_user'));
  const waitMs = Number(params.wait_ms || 1500);
  if (params.navigate !== false) {
    await page.goto(String(resolve(params.url || preset.baseUrl)), {
      waitUntil: params.waitUntil || 'networkidle',
    });
  }
  if (!runtime.webAuthn?.authenticatorId || params.setup_authenticator !== false) {
    await setupVirtualPasskeyAuthenticator(runtime, page, {
      enableUI: params.enable_ui === true,
      replaceExisting: params.replace_existing !== false,
      protocol: resolve(params.protocol || 'ctap2') as 'ctap2' | 'u2f',
      transport: resolve(params.transport || 'internal') as 'usb' | 'nfc' | 'ble' | 'internal',
      hasResidentKey: params.has_resident_key !== false,
      hasUserVerification: params.has_user_verification !== false,
      hasLargeBlob: params.has_large_blob === true,
      automaticPresenceSimulation: params.automatic_presence !== false,
      isUserVerified: params.user_verified !== false,
    });
  }
  await page.fill(resolve(params.username_selector || preset.usernameSelector), username, {
    timeout: params.timeout || 5000,
  });
  await page.click(resolve(params.register_selector || preset.registerSelector), {
    timeout: params.timeout || 5000,
  });
  await page.waitForTimeout(waitMs);
  const credentials = await getVirtualPasskeyCredentials(runtime, page);
  return {
    provider: resolve(params.provider || 'webauthn.io'),
    username,
    credentials,
    url: page.url(),
  };
}

async function authenticatePasskey(
  page: Page,
  runtime: BrowserRuntime,
  ctx: any,
  params: any,
  resolve: Function
) {
  const preset = getPasskeyPreset(resolve(params.provider));
  const waitMs = Number(params.wait_ms || 1500);
  const username = params.username !== undefined ? String(resolve(params.username)) : undefined;
  let authPage = page;
  if (params.clear_session !== false) {
    await clearPasskeySiteSession(runtime, authPage);
  }
  if (preset.postAuthUrlIncludes && authPage.url().includes(preset.postAuthUrlIncludes)) {
    authPage = await openFreshPasskeyPage(runtime);
  }
  if (params.navigate !== false) {
    await authPage.goto(String(resolve(params.url || preset.baseUrl)), {
      waitUntil: params.waitUntil || 'networkidle',
    });
  }
  if (preset.postAuthUrlIncludes && authPage.url().includes(preset.postAuthUrlIncludes)) {
    const credentials = await getVirtualPasskeyCredentials(runtime, authPage);
    return {
      provider: resolve(params.provider || 'webauthn.io'),
      username,
      credentials,
      url: authPage.url(),
      authenticated: true,
      mode: 'already_authenticated',
    };
  }
  try {
    if (username) {
      await authPage.fill(resolve(params.username_selector || preset.usernameSelector), username, {
        timeout: params.timeout || 5000,
      });
    }
    await authPage.click(resolve(params.authenticate_selector || preset.authenticateSelector), {
      timeout: params.timeout || 5000,
    });
  } catch (err) {
    if (preset.postAuthUrlIncludes && authPage.url().includes(preset.postAuthUrlIncludes)) {
      const credentials = await getVirtualPasskeyCredentials(runtime, authPage);
      return {
        provider: resolve(params.provider || 'webauthn.io'),
        username,
        credentials,
        url: authPage.url(),
        authenticated: true,
        mode: 'already_authenticated',
      };
    }
    throw err;
  }
  await authPage.waitForTimeout(waitMs);
  const credentials = await getVirtualPasskeyCredentials(runtime, authPage);
  return {
    provider: resolve(params.provider || 'webauthn.io'),
    username,
    credentials,
    url: authPage.url(),
    authenticated: preset.postAuthUrlIncludes
      ? authPage.url().includes(preset.postAuthUrlIncludes)
      : true,
  };
}

async function deletePasskey(
  page: Page,
  runtime: BrowserRuntime,
  ctx: any,
  params: any,
  resolve: Function
) {
  const authenticatorId = getPasskeyAuthenticatorId(runtime);
  const cdp = await getOrCreatePageCdpSession(runtime, page);
  const credentials = await getVirtualPasskeyCredentials(runtime, page);
  let credentialToDelete: Record<string, any> | undefined;

  if (params.credential_id) {
    const credentialId = String(resolve(params.credential_id));
    credentialToDelete = credentials.find((credential) => credential.credentialId === credentialId);
  } else if (params.username) {
    const username = String(resolve(params.username));
    credentialToDelete = credentials.find(
      (credential) => credential.userName === username || credential.userDisplayName === username
    );
  } else if (credentials.length === 1) {
    credentialToDelete = credentials[0];
  }

  if (!credentialToDelete?.credentialId) {
    throw new Error(
      'Unable to determine passkey credential to delete. Provide credential_id or username.'
    );
  }

  await cdp.send('WebAuthn.removeCredential', {
    authenticatorId,
    credentialId: credentialToDelete.credentialId,
  });
  const remainingCredentials = await getVirtualPasskeyCredentials(runtime, page);
  return {
    deleted_credential_id: credentialToDelete.credentialId,
    credentials: remainingCredentials,
    deleted: true,
  };
}

async function clearPasskeySiteSession(runtime: BrowserRuntime, page: Page): Promise<void> {
  await runtime.context.clearCookies();
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
}

async function openFreshPasskeyPage(runtime: BrowserRuntime): Promise<Page> {
  const page = await runtime.context.newPage();
  const tabId = `tab-${runtime.tabs.size + 1}`;
  browserRuntimeHelpers.registerBrowserPage(runtime, page, tabId);
  runtime.activeTabId = tabId;
  if (runtime.webAuthn?.enabled && runtime.webAuthn.options) {
    await clonePasskeyAuthenticatorToPage(runtime, page);
  }
  return page;
}

async function clonePasskeyAuthenticatorToPage(runtime: BrowserRuntime, page: Page): Promise<void> {
  const options = runtime.webAuthn?.options;
  if (!options) return;

  const existingCredentials = [...(runtime.webAuthn?.credentials || [])];
  const cdp = await getOrCreatePageCdpSession(runtime, page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const authenticator = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: options.protocol,
      transport: options.transport,
      hasResidentKey: options.hasResidentKey,
      hasUserVerification: options.hasUserVerification,
      hasLargeBlob: options.hasLargeBlob,
      automaticPresenceSimulation: options.automaticPresenceSimulation,
      isUserVerified: options.isUserVerified,
    },
  });
  for (const credential of existingCredentials) {
    await cdp.send('WebAuthn.addCredential', {
      authenticatorId: authenticator.authenticatorId,
      credential: credential as any,
    });
  }
  runtime.webAuthn = {
    ...runtime.webAuthn,
    authenticatorId: authenticator.authenticatorId,
    credentials: existingCredentials,
  };
}
