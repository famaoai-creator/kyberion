import { logger, safeReadFile, safeWriteFile, safeMkdir, safeExec, safeExistsSync, safeReaddir, safeRmSync, derivePipelineStatus, emitComputerSurfacePatch, TraceContext, pathResolver } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { chromium, Browser, BrowserContext, CDPSession, Page } from '@playwright/test';

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
    lease_ms?: number;
    keep_alive?: boolean;
    user_data_dir?: string;
    browser_channel?: 'chromium' | 'chrome';
    profile_directory?: string;
    launch_args?: string[];
    connect_over_cdp?: boolean;
    cdp_url?: string;
    cdp_port?: number;
  };
  context?: Record<string, any>;
}

interface ComputerInteractionAction {
  version: '0.1';
  kind: 'computer_interaction';
  session_id?: string;
  target?: {
    surface_id?: string;
    runtime_id?: string;
    tab_id?: string;
    display_id?: string;
    domain?: string;
  };
  observation?: {
    mode?: 'screen' | 'dom_snapshot' | 'console' | 'network' | 'mixed';
    include_screenshot?: boolean;
    include_refs?: boolean;
    include_console?: boolean;
    include_network?: boolean;
    viewport?: {
      width?: number;
      height?: number;
      scale?: number;
    };
  };
  action: {
    type:
      | 'snapshot'
      | 'screenshot'
      | 'open_tab'
      | 'select_tab'
      | 'left_click'
      | 'double_click'
      | 'right_click'
      | 'mouse_move'
      | 'left_mouse_down'
      | 'left_mouse_up'
      | 'drag'
      | 'scroll'
      | 'type'
      | 'key'
      | 'wait'
      | 'click_ref'
      | 'fill_ref'
      | 'press_ref'
      | 'wait_for_ref'
      | 'extract_text_ref'
      | 'capture_console'
      | 'capture_network';
    coordinate?: { x: number; y: number };
    to_coordinate?: { x: number; y: number };
    button?: 'left' | 'right' | 'middle';
    text?: string;
    key?: string;
    ref?: string;
    url?: string;
    timeout_ms?: number;
    scroll_delta?: { x?: number; y?: number };
  };
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
  last_video_paths?: string[];
  video_output_dir?: string;
  video_recording_pending?: boolean;
  lease_expires_at?: string;
  lease_status: 'active' | 'released' | 'expired';
  retained: boolean;
  cdp_url?: string;
  cdp_port?: number;
  action_trail_count: number;
  recent_actions: Array<{
    op: string;
    kind: BrowserRecordedAction['kind'];
    tab_id?: string;
    ref?: string;
    selector?: string;
    ts: string;
  }>;
}

interface BrowserRuntime {
  context: BrowserContext;
  tabs: Map<string, Page>;
  pageIds: WeakMap<Page, string>;
  cdpSessions: WeakMap<Page, CDPSession>;
  activeTabId: string;
  consoleEvents: Array<{ tab_id: string; type: string; text: string; ts: string }>;
  networkEvents: Array<{ tab_id: string; method: string; url: string; resourceType: string; ts: string }>;
  webAuthn?: {
    authenticatorId?: string;
    enabled: boolean;
    options?: Record<string, any>;
    credentials: Array<Record<string, any>>;
    events: Array<{ type: string; credential?: Record<string, any>; credentialId?: string; ts: string }>;
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

interface BrowserRuntimeLease {
  runtime: BrowserRuntime;
  userDataDir: string;
  sessionMetadataPath: string;
  videoDir?: string;
  leaseExpiresAt?: number;
  cdpUrl?: string;
  cdpPort?: number;
  browser?: Browser;
  externalConnection?: boolean;
}

const BROWSER_RUNTIME_DIR = pathResolver.shared('runtime/browser');
const BROWSER_SESSION_DIR = path.join(BROWSER_RUNTIME_DIR, 'sessions');
const BROWSER_SNAPSHOT_DIR = path.join(BROWSER_RUNTIME_DIR, 'snapshots');
const EVIDENCE_DIR = pathResolver.rootResolve('evidence/browser');
const browserRuntimeLeases = new Map<string, BrowserRuntimeLease>();
const PASSKEY_PROVIDER_CATALOG_PATH = pathResolver.knowledge('public/orchestration/browser-passkey-providers.json');

/**
 * Main Entry Point
 */
async function handleAction(input: BrowserAction) {
  if ((input as any).kind === 'computer_interaction') {
    return await handleComputerInteraction(input as unknown as ComputerInteractionAction);
  }
  if (input.action !== 'pipeline') {
    throw new Error(`Unsupported action: ${(input as any).action}. Browser-Actuator accepts pipeline and computer_interaction contracts.`);
  }
  return await executePipeline(input.steps || [], input.session_id || 'default', input.options || {}, input.context || {});
}

async function handleComputerInteraction(input: ComputerInteractionAction) {
  const browserAction = translateComputerInteractionToBrowserAction(input);
  const result = await executePipeline(
    browserAction.steps || [],
    browserAction.session_id || 'default',
    browserAction.options || {},
    browserAction.context || {},
  );
  const ctx = (result as any).context || {};
  emitComputerSurfacePatch({
    sessionId: browserAction.session_id || 'default',
    executor: 'browser',
    status: String((result as any).status || 'unknown'),
    latestAction: input.action.type,
    target: typeof ctx.active_tab_id === 'string' ? ctx.active_tab_id : input.target?.tab_id,
    detail: typeof ctx.last_snapshot?.url === 'string' ? ctx.last_snapshot.url : undefined,
    screenshotPath: typeof ctx.last_screenshot === 'string' ? ctx.last_screenshot : undefined,
    actionCount: Array.isArray(ctx.action_trail) ? ctx.action_trail.length : undefined,
  });
  return result;
}

function translateComputerInteractionToBrowserAction(input: ComputerInteractionAction): BrowserAction {
  const interaction = input.action || { type: 'snapshot' as const };
  const sessionId = input.session_id || input.target?.runtime_id || 'computer-session';
  const viewport = input.observation?.viewport?.width && input.observation?.viewport?.height
    ? {
        width: input.observation.viewport.width,
        height: input.observation.viewport.height,
      }
    : undefined;

  const steps: PipelineStep[] = [];
  const options: BrowserAction['options'] = {
    headless: true,
    keep_alive: true,
    lease_ms: 5 * 60 * 1000,
    ...(viewport ? { viewport } : {}),
  };

  if (input.target?.tab_id && interaction.type !== 'open_tab' && interaction.type !== 'select_tab') {
    steps.push({ type: 'control', op: 'select_tab', params: { tab_id: input.target.tab_id } });
  }

  const requiresRefSnapshot = interaction.type === 'click_ref'
    || interaction.type === 'fill_ref'
    || interaction.type === 'press_ref'
    || interaction.type === 'wait_for_ref'
    || interaction.type === 'extract_text_ref';
  if (requiresRefSnapshot) {
    steps.push({ type: 'capture', op: 'snapshot', params: { export_as: 'last_snapshot' } });
  }

  switch (interaction.type) {
    case 'snapshot':
      steps.push({ type: 'capture', op: 'snapshot', params: { export_as: 'last_snapshot' } });
      break;
    case 'screenshot':
      steps.push({ type: 'capture', op: 'screenshot', params: { export_as: 'last_screenshot' } });
      break;
    case 'open_tab':
      steps.push({
        type: 'control',
        op: 'open_tab',
        params: {
          url: interaction.url,
          tab_id: input.target?.tab_id,
          select: true,
        },
      });
      break;
    case 'select_tab':
      steps.push({
        type: 'control',
        op: 'select_tab',
        params: { tab_id: input.target?.tab_id || 'tab-1' },
      });
      break;
    case 'click_ref':
      steps.push({ type: 'apply', op: 'click_ref', params: { ref: interaction.ref, timeout: interaction.timeout_ms } });
      break;
    case 'fill_ref':
      steps.push({ type: 'apply', op: 'fill_ref', params: { ref: interaction.ref, text: interaction.text || '', timeout: interaction.timeout_ms } });
      break;
    case 'press_ref':
      steps.push({ type: 'apply', op: 'press_ref', params: { ref: interaction.ref, key: interaction.key || 'Enter', timeout: interaction.timeout_ms } });
      break;
    case 'wait_for_ref':
      steps.push({ type: 'apply', op: 'wait_ref', params: { ref: interaction.ref, timeout: interaction.timeout_ms } });
      break;
    case 'extract_text_ref':
      steps.push({ type: 'capture', op: 'content', params: { selector: `{{ref_map.${interaction.ref}}}`, export_as: 'last_capture' } });
      break;
    case 'capture_console':
      steps.push({ type: 'capture', op: 'console', params: { export_as: 'console_events' } });
      break;
    case 'capture_network':
      steps.push({ type: 'capture', op: 'network', params: { export_as: 'network_events' } });
      break;
    case 'wait':
      steps.push({ type: 'apply', op: 'wait', params: { duration: interaction.timeout_ms || 1000 } });
      break;
    default:
      throw new Error(`Unsupported computer interaction action for browser-actuator: ${interaction.type}`);
  }

  const includeConsole = input.observation?.include_console === true || input.observation?.mode === 'console' || input.observation?.mode === 'mixed';
  const includeNetwork = input.observation?.include_network === true || input.observation?.mode === 'network' || input.observation?.mode === 'mixed';
  const includeScreenshot = input.observation?.include_screenshot === true;

  if (interaction.type === 'snapshot') {
    if (includeScreenshot) {
      steps.push({
        type: 'capture',
        op: 'screenshot',
        params: {
          export_as: 'last_screenshot',
          path: `active/shared/tmp/computer/${sessionId}-snapshot.png`,
        },
      });
    }
    if (includeConsole) {
      steps.push({ type: 'capture', op: 'console', params: { export_as: 'console_events' } });
    }
    if (includeNetwork) {
      steps.push({ type: 'capture', op: 'network', params: { export_as: 'network_events' } });
    }
  }

  return {
    action: 'pipeline',
    session_id: sessionId,
    options,
    context: {
      computer_interaction_kind: input.kind,
      computer_interaction_target: input.target || {},
    },
    steps,
  };
}

/**
 * Universal Browser Pipeline Engine
 */
async function executePipeline(steps: PipelineStep[], sessionId: string, options: any, initialCtx: any = {}, state: any = { stepCount: 0, startTime: Date.now() }) {
  const MAX_STEPS = options.max_steps || 1000;
  const TIMEOUT = options.timeout_ms || 300000;

  const userDataDir = pathResolver.rootResolve(options.user_data_dir || path.join(BROWSER_RUNTIME_DIR, sessionId));
  if (!safeExistsSync(userDataDir)) safeMkdir(userDataDir, { recursive: true });
  if (!safeExistsSync(BROWSER_SESSION_DIR)) safeMkdir(BROWSER_SESSION_DIR, { recursive: true });
  const sessionMetadataPath = path.join(BROWSER_SESSION_DIR, `${sessionId}.json`);

  const tracePath = path.join(EVIDENCE_DIR, `trace_${sessionId}_${Date.now()}.zip`);
  const videoDir = path.join(EVIDENCE_DIR, 'videos', sessionId);
  const resolvedVideoDir = pathResolver.rootResolve(options.video_artifact_dir || videoDir);
  if (options.record_video && !safeExistsSync(resolvedVideoDir)) safeMkdir(resolvedVideoDir, { recursive: true });

  const browserContext = await getOrCreateBrowserContext(sessionId, userDataDir, sessionMetadataPath, options, resolvedVideoDir);
  const activeLease = browserRuntimeLeases.get(sessionId);

  // Start Tracing if requested
  if (options.record_trace) {
    await browserContext.tracing.start({ screenshots: true, snapshots: true, sources: true });
  }

  const runtime = getOrCreateBrowserRuntime(sessionId, browserContext, userDataDir, sessionMetadataPath);
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

  // Structured observability via TraceContext (additive to action_trail)
  const traceCtx = new TraceContext(`browser-pipeline:${sessionId}`, {
    actuator: 'browser-actuator',
    pipelineId: sessionId,
  });

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
  let stepIndex = 0;
  try {
    for (const step of steps) {
      state.stepCount++;
      stepIndex++;
      if (state.stepCount > MAX_STEPS) throw new Error(`[SAFETY_LIMIT] Exceeded maximum pipeline steps (${MAX_STEPS})`);
      if (Date.now() - state.startTime > TIMEOUT) throw new Error(`[SAFETY_LIMIT] Pipeline execution timed out (${TIMEOUT}ms)`);

      const spanId = traceCtx.startSpan(`${step.type}:${step.op}`, {
        stepId: (step as any).id || `step-${stepIndex}`,
      });

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

        // Track screenshot artifacts in the trace
        if (step.op === 'screenshot') {
          const screenshotPath = ctx.last_screenshot || ctx[step.params?.export_as || 'last_screenshot'];
          if (screenshotPath) {
            traceCtx.addArtifact('screenshot', screenshotPath, (step as any).id || 'screenshot');
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
            const recovery = await handleStepError(err, step, stepOnError, ctx,
              async (fallbackSteps: any[], errCtx: any) => {
                const res = await executePipelineInternal(fallbackSteps, runtime, errCtx, options, state, resolve);
                return res.context;
              }, resolve as (val: any) => any);
            if (recovery.recovered) {
              ctx = recovery.ctx;
              results.push({ op: step.op, status: 'recovered' as any });
              continue;
            }
          } catch (_) { /* fallthrough to default error handling */ }
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
    }
    ctx.browser_tabs = await summarizeTabs(runtime);
    ctx.active_tab_id = runtime.activeTabId;
    const keepAlive = options.keep_alive === true || Number(options.lease_ms || 0) > 0;
    const shouldClose = ctx.__close_browser_session === true || !keepAlive;
    const leaseExpiresAt = shouldClose ? undefined : Date.now() + Number(options.lease_ms || 5 * 60 * 1000);
    saveBrowserSessionMetadata(sessionMetadataPath, {
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
      recent_actions: summarizeRecentActions(ctx.action_trail),
    });
    if (shouldClose) {
      finalizedVideoPaths = videoRecordingEnabled ? await collectRecordedVideoPaths(runtime) : undefined;
      ctx.recorded_videos = finalizedVideoPaths || [];
      ctx.video_output_dir = videoRecordingEnabled ? resolvedVideoDir : undefined;
      ctx.video_recording_pending = false;
      saveBrowserSessionMetadata(sessionMetadataPath, {
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
        recent_actions: summarizeRecentActions(ctx.action_trail),
      });
      browserRuntimeLeases.delete(sessionId);
      await browserContext.close();
    } else {
      const lease = browserRuntimeLeases.get(sessionId);
      if (lease) {
        lease.leaseExpiresAt = leaseExpiresAt;
        lease.videoDir = videoRecordingEnabled ? resolvedVideoDir : undefined;
      }
      ctx.recorded_videos = [];
      ctx.video_output_dir = videoRecordingEnabled ? resolvedVideoDir : undefined;
      ctx.video_recording_pending = videoRecordingEnabled;
    }
  }

  // Finalize structured trace and attach to result context
  const trace = traceCtx.finalize();
  ctx.trace = trace;
  ctx.trace_summary = traceCtx.summary();

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
    case 'close_session':
      return recordBrowserAction({
        ...ctx,
        __close_browser_session: true,
      }, {
        kind: 'control',
        op: 'close_session',
        tab_id: runtime.activeTabId,
      });
    case 'pause_for_operator': {
      const message = resolve(params.message || 'Operator input required. Press Enter to continue.');
      await waitForOperatorContinue({
        sessionId: ctx.session_id || 'default',
        message,
        continueFile: params.continue_file ? pathResolver.rootResolve(resolve(params.continue_file)) : undefined,
        pollMs: Number(params.poll_ms || 250),
        timeoutMs: params.timeout_ms ? Number(params.timeout_ms) : undefined,
      });
      return recordBrowserAction(ctx, {
        kind: 'control',
        op: 'pause_for_operator',
        tab_id: runtime.activeTabId,
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
    case 'setup_passkey_authenticator': {
      const page = getActivePage(runtime);
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
      return recordBrowserAction({
        ...ctx,
        [params.export_as || 'passkey_authenticator']: setup,
      }, {
        kind: 'control',
        op: 'setup_passkey_authenticator',
        tab_id: runtime.activeTabId,
      });
    }
    case 'remove_passkey_authenticator': {
      const page = getActivePage(runtime);
      await removeVirtualPasskeyAuthenticator(runtime, page);
      return recordBrowserAction(ctx, {
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
      const subResult = await executePipelineInternal(refResult.steps, runtime, { ...ctx, ...refResult.mergedCtx }, options, state, resolve);
      if (params.export_as) {
        ctx = { ...ctx, [params.export_as]: subResult.context };
      } else {
        const { _refDepth, ...subCtxClean } = subResult.context || {};
        ctx = { ...ctx, ...subCtxClean };
      }
      return recordBrowserAction(ctx, {
        kind: 'control',
        op: 'ref',
        tab_id: runtime.activeTabId,
      });
    }

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
      const stepOnError = (step as any).on_error;
      if (stepOnError) {
        try {
          const { handleStepError } = await import('@agent/core');
          const recovery = await handleStepError(err, step, stepOnError, ctx,
            async (fallbackSteps: any[], errCtx: any) => {
              const res = await executePipelineInternal(fallbackSteps, runtime, errCtx, options, state, resolve);
              return res.context;
            }, resolve as (val: any) => any);
          if (recovery.recovered) {
            ctx = recovery.ctx;
            results.push({ op: step.op, status: 'recovered' as any });
            continue;
          }
        } catch (_) { /* fallthrough to default error handling */ }
      }
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
      saveBrowserSessionSnapshot(ctx.session_id || 'default', snapshot);
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
        title: snapshot.title,
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
      const outPath = pathResolver.rootResolve(resolve(params.path || `evidence/browser/screenshot_${Date.now()}.png`));
      logger.info(`📸 [BROWSER] Taking screenshot to: ${outPath}`);
      if (!safeExistsSync(path.dirname(outPath))) safeMkdir(path.dirname(outPath), { recursive: true });
      await page.screenshot({ path: outPath, fullPage: params.fullPage });
      return recordBrowserAction({ ...ctx, [params.export_as || 'last_screenshot']: outPath }, {
        kind: 'capture',
        op: 'screenshot',
        tab_id: runtime.activeTabId,
        url: page.url(),
      });
    case 'content': {
      const selector = params.selector ? resolve(params.selector) : undefined;
      const content = selector ? await page.innerText(selector) : await page.content();
      return recordBrowserAction({ ...ctx, [params.export_as || 'last_capture']: content }, {
        kind: 'capture',
        op: 'content',
        tab_id: runtime.activeTabId,
        selector,
        content_excerpt: typeof content === 'string' ? content.trim().slice(0, 120) : undefined,
      });
    }
    case 'evaluate':
      return recordBrowserAction({ ...ctx, [params.export_as || 'last_capture']: await page.evaluate(params.script) }, {
        kind: 'capture',
        op: 'evaluate',
        tab_id: runtime.activeTabId,
      });
    case 'passkey_credentials': {
      const credentials = await getVirtualPasskeyCredentials(runtime, page);
      return recordBrowserAction({
        ...ctx,
        [params.export_as || 'passkey_credentials']: credentials,
      }, {
        kind: 'capture',
        op: 'passkey_credentials',
        tab_id: runtime.activeTabId,
      });
    }
    case 'passkey_events':
      return recordBrowserAction({
        ...ctx,
        [params.export_as || 'passkey_events']: runtime.webAuthn?.events || [],
      }, {
        kind: 'capture',
        op: 'passkey_events',
        tab_id: runtime.activeTabId,
      });
    case 'export_session_handoff': {
      const targetUrl = String(resolve(params.target_url || page.url())).trim();
      const origin = deriveOrigin(targetUrl || page.url());
      const handoff = await buildSessionHandoff(page, runtime, ctx, {
        targetUrl,
        origin,
        browserSessionId: resolve(params.browser_session_id || ctx.session_id || 'default'),
        preferPersistentContext: params.prefer_persistent_context !== false,
      });
      const outPath = params.path ? pathResolver.rootResolve(resolve(params.path)) : undefined;
      if (outPath) {
        if (!safeExistsSync(path.dirname(outPath))) safeMkdir(path.dirname(outPath), { recursive: true });
        safeWriteFile(outPath, JSON.stringify(handoff, null, 2));
      }
      return recordBrowserAction({
        ...ctx,
        [params.export_as || 'session_handoff']: handoff,
        ...(outPath ? { session_handoff_path: outPath } : {}),
      }, {
        kind: 'capture',
        op: 'export_session_handoff',
        tab_id: runtime.activeTabId,
        url: targetUrl,
      });
    }
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
      const outPath = pathResolver.rootResolve(resolve(params.path || `active/shared/tmp/browser/${ctx.session_id || 'default'}-playwright.spec.ts`));
      if (!safeExistsSync(path.dirname(outPath))) safeMkdir(path.dirname(outPath), { recursive: true });
      const content = renderPlaywrightSkeleton(trail, {
        assertions: params.assertions === 'hint' ? 'hint' : 'strict',
      });
      safeWriteFile(outPath, content);
      return { ...ctx, [params.export_as || 'playwright_spec_path']: outPath };
    }
    case 'export_adf': {
      const trail = readRecordedActions(ctx, params.from);
      const outPath = pathResolver.rootResolve(resolve(params.path || `active/shared/tmp/browser/${ctx.session_id || 'default'}-pipeline.json`));
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
      const element = findSnapshotElement(ctx, ref);
      await page.click(selector, { timeout: params.timeout || 5000 });
      return recordBrowserAction(ctx, {
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
      const selector = resolveRefSelector(ctx, ref);
      const element = findSnapshotElement(ctx, ref);
      await page.fill(selector, text, { timeout: params.timeout || 5000 });
      return recordBrowserAction(ctx, {
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
      const selector = resolveRefSelector(ctx, ref);
      const element = findSnapshotElement(ctx, ref);
      await page.press(selector, key, { timeout: params.timeout || 5000 });
      return recordBrowserAction(ctx, {
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
    case 'set_passkey_user_verified': {
      const authenticatorId = getPasskeyAuthenticatorId(runtime);
      const cdp = await getOrCreatePageCdpSession(runtime, page);
      await cdp.send('WebAuthn.setUserVerified', {
        authenticatorId,
        isUserVerified: params.is_user_verified !== false,
      });
      return recordBrowserAction(ctx, { kind: 'apply', op: 'set_passkey_user_verified', tab_id: runtime.activeTabId });
    }
    case 'set_passkey_presence': {
      const authenticatorId = getPasskeyAuthenticatorId(runtime);
      const cdp = await getOrCreatePageCdpSession(runtime, page);
      await cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
        authenticatorId,
        enabled: params.enabled !== false,
      });
      return recordBrowserAction(ctx, { kind: 'apply', op: 'set_passkey_presence', tab_id: runtime.activeTabId });
    }
    case 'clear_passkey_credentials': {
      const authenticatorId = getPasskeyAuthenticatorId(runtime);
      const cdp = await getOrCreatePageCdpSession(runtime, page);
      await cdp.send('WebAuthn.clearCredentials', { authenticatorId });
      if (runtime.webAuthn) runtime.webAuthn.credentials = [];
      return recordBrowserAction(ctx, { kind: 'apply', op: 'clear_passkey_credentials', tab_id: runtime.activeTabId });
    }
    case 'register_passkey': {
      const registration = await registerPasskey(page, runtime, ctx, params, resolve);
      return recordBrowserAction({
        ...ctx,
        [params.export_as || 'passkey_registration']: registration,
        passkey_credentials: registration.credentials,
      }, {
        kind: 'apply',
        op: 'register_passkey',
        tab_id: runtime.activeTabId,
      });
    }
    case 'authenticate_passkey': {
      const authentication = await authenticatePasskey(page, runtime, ctx, params, resolve);
      return recordBrowserAction({
        ...ctx,
        [params.export_as || 'passkey_authentication']: authentication,
        passkey_credentials: authentication.credentials,
      }, {
        kind: 'apply',
        op: 'authenticate_passkey',
        tab_id: runtime.activeTabId,
      });
    }
    case 'delete_passkey': {
      const deletion = await deletePasskey(page, runtime, ctx, params, resolve);
      return recordBrowserAction({
        ...ctx,
        [params.export_as || 'passkey_deletion']: deletion,
        passkey_credentials: deletion.credentials,
      }, {
        kind: 'apply',
        op: 'delete_passkey',
        tab_id: runtime.activeTabId,
      });
    }
    case 'import_session_handoff': {
      const handoff = await resolveSessionHandoff(params, ctx, resolve);
      if (Array.isArray(handoff.cookies) && handoff.cookies.length > 0) {
        await runtime.context.addCookies(handoff.cookies as any);
      }
      if (handoff.headers && Object.keys(handoff.headers).length > 0) {
        await runtime.context.setExtraHTTPHeaders(handoff.headers as Record<string, string>);
      }
      const targetUrl = String(handoff.target_url || resolve(params.target_url || '')).trim();
      if (!targetUrl) throw new Error('import_session_handoff requires a target_url');
      await page.goto(targetUrl, { waitUntil: params.waitUntil || 'domcontentloaded' });
      if ((handoff.local_storage && Object.keys(handoff.local_storage).length > 0) || (handoff.session_storage && Object.keys(handoff.session_storage).length > 0)) {
        await page.evaluate(({ localStorageEntries, sessionStorageEntries }) => {
          for (const [key, value] of Object.entries(localStorageEntries || {})) {
            window.localStorage.setItem(key, String(value));
          }
          for (const [key, value] of Object.entries(sessionStorageEntries || {})) {
            window.sessionStorage.setItem(key, String(value));
          }
        }, {
          localStorageEntries: handoff.local_storage || {},
          sessionStorageEntries: handoff.session_storage || {},
        });
        if (params.reload_after_import !== false) {
          await page.reload({ waitUntil: params.waitUntil || 'domcontentloaded' });
        }
      }
      return recordBrowserAction({
        ...ctx,
        [params.export_as || 'imported_session_handoff']: handoff,
        last_url: page.url(),
      }, {
        kind: 'apply',
        op: 'import_session_handoff',
        tab_id: runtime.activeTabId,
        url: targetUrl,
      });
    }
    default:
      throw new Error(`Unsupported apply operator in Browser-Actuator: ${op}`);
  }
}

async function buildSessionHandoff(
  page: Page,
  runtime: BrowserRuntime,
  ctx: any,
  options: {
    targetUrl: string;
    origin: string;
    browserSessionId: string;
    preferPersistentContext: boolean;
  },
) {
  const storage = await page.evaluate(() => ({
    local_storage: Object.fromEntries(Object.entries(window.localStorage)),
    session_storage: Object.fromEntries(Object.entries(window.sessionStorage)),
  }));
  const cookies = await runtime.context.cookies([options.targetUrl]);
  return {
    kind: 'webview-session-handoff',
    target_url: options.targetUrl,
    origin: options.origin,
    browser_session_id: options.browserSessionId,
    prefer_persistent_context: options.preferPersistentContext,
    cookies,
    local_storage: storage.local_storage,
    session_storage: storage.session_storage,
    source: {
      platform: 'browser',
      app_id: ctx?.app_profile?.app_id || ctx?.app_id || ctx?.session_id || 'browser',
    },
  };
}

async function resolveSessionHandoff(params: any, ctx: any, resolve: Function): Promise<any> {
  if (params.from) {
    const fromValue = ctx[String(params.from)];
    if (fromValue && typeof fromValue === 'object') return fromValue;
  }

  if (params.path) {
    const filePath = pathResolver.rootResolve(resolve(params.path));
    const content = safeReadFile(filePath, { encoding: 'utf8' }) as string;
    return JSON.parse(content);
  }

  if (params.handoff && typeof params.handoff === 'object') {
    return params.handoff;
  }

  throw new Error('import_session_handoff requires params.from, params.path, or params.handoff');
}

function deriveOrigin(targetUrl: string): string {
  try {
    return new URL(targetUrl).origin;
  } catch {
    return '';
  }
}

function resolveRefSelector(ctx: any, ref: string): string {
  const selector = ctx?.ref_map?.[ref];
  if (!selector) {
    throw new Error(`Unknown browser ref: ${ref}. Capture a snapshot before using *_ref actions.`);
  }
  return selector;
}

function findSnapshotElement(ctx: any, ref: string): BrowserSnapshotElement | undefined {
  const elements = ctx?.last_snapshot?.elements;
  if (!Array.isArray(elements)) return undefined;
  return elements.find((element: BrowserSnapshotElement) => element.ref === ref);
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

function renderPlaywrightSkeleton(
  trail: BrowserRecordedAction[],
  options: { assertions?: 'hint' | 'strict' } = {},
): string {
  const assertionMode = options.assertions || 'strict';
  const lines = [
    "import { test, expect } from '@playwright/test';",
    '',
    "test('browser recorded flow', async ({ page }) => {",
  ];
  const setupLines: string[] = [];
  const actionLines: string[] = [];
  const assertionLines: string[] = [];
  let stepNumber = 0;

  const addAction = (statement: string, label?: string) => {
    stepNumber += 1;
    actionLines.push(`  // step ${stepNumber}: ${label || 'browser action'}`);
    actionLines.push(`  ${statement}`);
  };
  const addAssertion = (statement: string, label?: string) => {
    const rendered = assertionMode === 'strict' ? `  ${statement}` : `  // assertion hint: ${statement}`;
    if (label) assertionLines.push(`  // ${label}`);
    assertionLines.push(rendered);
  };

  for (const action of trail) {
    switch (action.op) {
      case 'goto':
      case 'open_tab':
        if (action.url) {
          addAction(`await page.goto(${JSON.stringify(action.url)});`, `navigate to ${action.url}`);
          addAssertion(`await expect(page).toHaveURL(${JSON.stringify(action.url)});`, 'navigation assertion');
        }
        break;
      case 'snapshot':
        if (action.url) addAssertion(`await expect(page).toHaveURL(${JSON.stringify(action.url)});`, 'snapshot assertion');
        if (action.title) addAssertion(`await expect(page).toHaveTitle(${JSON.stringify(action.title)});`);
        break;
      case 'click':
      case 'click_ref':
        if (action.selector) {
          addAssertion(
            `await expect(page.locator(${JSON.stringify(action.selector)})).toBeVisible();`,
            `before click${action.element_name ? `: ${action.element_name}` : ''}`,
          );
          addAction(`await page.click(${JSON.stringify(action.selector)});`, `click ${action.ref || action.selector}`);
        }
        break;
      case 'fill':
      case 'fill_ref':
        if (action.selector) {
          addAssertion(
            `await expect(page.locator(${JSON.stringify(action.selector)})).toBeVisible();`,
            `before fill${action.element_name ? `: ${action.element_name}` : ''}`,
          );
          addAction(`await page.fill(${JSON.stringify(action.selector)}, ${JSON.stringify(action.text || '')});`, `fill ${action.ref || action.selector}`);
          addAssertion(`await expect(page.locator(${JSON.stringify(action.selector)})).toHaveValue(${JSON.stringify(action.text || '')});`, 'value assertion');
        }
        break;
      case 'press':
      case 'press_ref':
        if (action.selector) {
          addAssertion(`await expect(page.locator(${JSON.stringify(action.selector)})).toBeVisible();`, 'before keypress');
          addAction(`await page.press(${JSON.stringify(action.selector)}, ${JSON.stringify(action.key || 'Enter')});`, `press ${action.key || 'Enter'}`);
        }
        break;
      case 'wait':
      case 'wait_ref':
        if (action.selector) {
          addAction(`await page.waitForSelector(${JSON.stringify(action.selector)});`, `wait for ${action.ref || action.selector}`);
          addAssertion(`await expect(page.locator(${JSON.stringify(action.selector)})).toBeVisible();`, 'wait assertion');
        }
        break;
      case 'content':
        if (action.selector && action.content_excerpt) {
          addAssertion(`await expect(page.locator(${JSON.stringify(action.selector)})).toContainText(${JSON.stringify(action.content_excerpt)});`, 'content assertion');
        }
        break;
      default:
        break;
    }
  }

  if (setupLines.length > 0) {
    lines.push('  // setup');
    lines.push(...setupLines);
    lines.push('');
  }
  if (actionLines.length > 0) {
    lines.push('  // recorded actions');
    lines.push(...actionLines);
    lines.push('');
  }
  if (assertionLines.length > 0) {
    lines.push(`  // ${assertionMode === 'strict' ? 'assertions' : 'assertion hints'}`);
    lines.push(...assertionLines);
    lines.push('');
  }
  lines.push('});', '');
  return lines.join('\n');
}

async function closeBrowserSession(sessionId: string): Promise<boolean> {
  cleanupExpiredBrowserRuntimeLeases();
  const lease = browserRuntimeLeases.get(sessionId);
  if (!lease) return false;
  saveBrowserSessionMetadata(lease.sessionMetadataPath, {
    session_id: sessionId,
    user_data_dir: lease.userDataDir,
    active_tab_id: lease.runtime.activeTabId,
    tab_count: lease.runtime.tabs.size,
    tabs: [],
    updated_at: new Date().toISOString(),
    lease_status: 'released',
    retained: false,
    cdp_url: lease.cdpUrl,
    cdp_port: lease.cdpPort,
    lease_expires_at: undefined,
    action_trail_count: 0,
    recent_actions: [],
  });
  if (lease.externalConnection && lease.browser) {
    await lease.browser.close();
  } else {
    await lease.runtime.context.close();
  }
  browserRuntimeLeases.delete(sessionId);
  return true;
}

async function restartBrowserSession(sessionId: string): Promise<boolean> {
  const closed = await closeBrowserSession(sessionId);
  return closed;
}

async function waitForOperatorContinue(options: {
  sessionId: string;
  message: string;
  continueFile?: string;
  pollMs: number;
  timeoutMs?: number;
}): Promise<void> {
  const startedAt = Date.now();
  if (process.stdin.isTTY) {
    logger.info(`⏸️ [BROWSER] ${options.message}`);
    logger.info('⏎ [BROWSER] Press Enter in this terminal when manual browser work is complete.');
    await new Promise<void>((resolve) => {
      const onData = () => {
        process.stdin.off('data', onData);
        resolve();
      };
      process.stdin.resume();
      process.stdin.once('data', onData);
    });
    return;
  }

  const continueFile = options.continueFile || path.join(BROWSER_RUNTIME_DIR, `${options.sessionId}.continue`);
  logger.info(`⏸️ [BROWSER] ${options.message}`);
  logger.info(`📄 [BROWSER] Waiting for continue file: ${continueFile}`);
  while (true) {
    if (safeExistsSync(continueFile)) return;
    if (options.timeoutMs && Date.now() - startedAt > options.timeoutMs) {
      throw new Error(`Timed out waiting for operator continue file: ${continueFile}`);
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs));
  }
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

async function getOrCreateBrowserContext(
  sessionId: string,
  userDataDir: string,
  sessionMetadataPath: string,
  options: any,
  videoDir: string,
): Promise<BrowserContext> {
  cleanupExpiredBrowserRuntimeLeases();
  const existing = browserRuntimeLeases.get(sessionId);
  if (existing) {
    logger.info(`♻️ [BROWSER] Reusing leased session: ${sessionId}`);
    return existing.runtime.context;
  }

  const persistedMetadata = loadBrowserSessionMetadata(sessionMetadataPath);
  const persistedCdpUrl = options.cdp_url || persistedMetadata?.cdp_url;
  const persistedCdpPort = Number(options.cdp_port || persistedMetadata?.cdp_port || 0);

  if (!options.connect_over_cdp && persistedCdpUrl && persistedMetadata?.retained && persistedMetadata.lease_status === 'active') {
    try {
      logger.info(`🔁 [BROWSER] Reattaching to persisted session via CDP: ${persistedCdpUrl}`);
      const browser = await chromium.connectOverCDP(persistedCdpUrl);
      const context = browser.contexts()[0];
      if (!context) {
        await browser.close();
        throw new Error(`No browser context available via persisted CDP session at ${persistedCdpUrl}`);
      }
      browserRuntimeLeases.set(sessionId, {
        runtime: createBrowserRuntime(context),
        userDataDir,
        sessionMetadataPath,
        videoDir,
        browser,
        externalConnection: true,
        cdpUrl: persistedCdpUrl,
        cdpPort: persistedCdpPort || Number(new URL(persistedCdpUrl).port),
      });
      return context;
    } catch (error: any) {
      logger.warn(`⚠️ [BROWSER] Failed to reattach persisted session ${sessionId} via CDP: ${error?.message || String(error)}`);
    }
  }

  if (options.connect_over_cdp) {
    const cdpUrl = options.cdp_url || `http://127.0.0.1:${Number(options.cdp_port || 9222)}`;
    logger.info(`🔌 [BROWSER] Attaching to existing Chrome via CDP: ${cdpUrl}`);
    const browser = await chromium.connectOverCDP(cdpUrl);
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close();
      throw new Error(`No browser context available via CDP at ${cdpUrl}`);
    }
    browserRuntimeLeases.set(sessionId, {
      runtime: createBrowserRuntime(context),
      userDataDir,
      sessionMetadataPath,
      videoDir,
      browser,
      externalConnection: true,
      cdpUrl,
      cdpPort: Number(new URL(cdpUrl).port),
    });
    return context;
  }

  logger.info(`🚀 [BROWSER] Launching session: ${sessionId} (Headless: ${options.headless !== false})`);
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: options.browser_channel === 'chrome' ? 'chrome' : undefined,
    headless: options.headless !== false,
    viewport: options.viewport || { width: 1280, height: 720 },
    locale: options.locale || 'ja-JP',
    recordVideo: options.record_video ? { dir: videoDir } : undefined,
    args: [
      ...(Array.isArray(options.launch_args) ? options.launch_args : []),
      ...(options.profile_directory ? [`--profile-directory=${options.profile_directory}`] : []),
      '--remote-debugging-port=0',
    ],
  });

  const cdpEndpoint = await waitForCdpEndpoint(userDataDir);
  browserRuntimeLeases.set(sessionId, {
    runtime: createBrowserRuntime(context),
    userDataDir,
    sessionMetadataPath,
    videoDir,
    externalConnection: false,
    cdpUrl: cdpEndpoint?.cdpUrl,
    cdpPort: cdpEndpoint?.cdpPort,
  });
  return context;
}

function getOrCreateBrowserRuntime(
  sessionId: string,
  context: BrowserContext,
  userDataDir: string,
  sessionMetadataPath: string,
): BrowserRuntime {
  const existing = browserRuntimeLeases.get(sessionId);
  if (existing) return existing.runtime;
  const runtime = createBrowserRuntime(context);
  browserRuntimeLeases.set(sessionId, {
    runtime,
    userDataDir,
    sessionMetadataPath,
    externalConnection: false,
  });
  return runtime;
}

function cleanupExpiredBrowserRuntimeLeases(): void {
  const now = Date.now();
  for (const [sessionId, lease] of browserRuntimeLeases.entries()) {
    if (!lease.leaseExpiresAt || lease.leaseExpiresAt > now) continue;
    saveBrowserSessionMetadata(lease.sessionMetadataPath, {
      session_id: sessionId,
      user_data_dir: lease.userDataDir,
      active_tab_id: lease.runtime.activeTabId,
      tab_count: lease.runtime.tabs.size,
      tabs: [],
      updated_at: new Date().toISOString(),
      video_output_dir: lease.videoDir,
      video_recording_pending: false,
      lease_status: 'expired',
      retained: false,
      cdp_url: lease.cdpUrl,
      cdp_port: lease.cdpPort,
      lease_expires_at: new Date(lease.leaseExpiresAt).toISOString(),
      action_trail_count: 0,
      recent_actions: [],
    });
    if (lease.externalConnection && lease.browser) {
      void lease.browser.close();
    } else {
      void lease.runtime.context.close();
    }
    browserRuntimeLeases.delete(sessionId);
  }
}

function summarizeRecentActions(trail: any): BrowserSessionMetadata['recent_actions'] {
  const actions = Array.isArray(trail) ? trail as BrowserRecordedAction[] : [];
  return actions.slice(-8).map((action) => ({
    op: action.op,
    kind: action.kind,
    tab_id: action.tab_id,
    ref: action.ref,
    selector: action.selector,
    ts: action.ts,
  }));
}

function loadBrowserSessionMetadata(filePath: string): BrowserSessionMetadata | null {
  if (!safeExistsSync(filePath)) return null;
  try {
    return JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as BrowserSessionMetadata;
  } catch {
    return null;
  }
}

async function waitForCdpEndpoint(userDataDir: string, timeoutMs = 5_000): Promise<{ cdpUrl: string; cdpPort: number } | null> {
  if (process.env.VITEST) return null;
  const filePath = path.join(userDataDir, 'DevToolsActivePort');
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (safeExistsSync(filePath)) {
      try {
        const raw = String(safeReadFile(filePath, { encoding: 'utf8' }) || '').trim();
        const [portLine] = raw.split(/\r?\n/);
        const cdpPort = Number(portLine);
        if (Number.isFinite(cdpPort) && cdpPort > 0) {
          return {
            cdpPort,
            cdpUrl: `http://127.0.0.1:${cdpPort}`,
          };
        }
      } catch {
        // Retry until timeout.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

async function collectRecordedVideoPaths(runtime: BrowserRuntime): Promise<string[]> {
  const collected = new Set<string>();
  for (const page of runtime.tabs.values()) {
    const videoHandle = typeof (page as any).video === 'function' ? (page as any).video() : null;
    if (!videoHandle || typeof videoHandle.path !== 'function') continue;
    try {
      const videoPath = await videoHandle.path();
      if (videoPath) collected.add(String(videoPath));
    } catch (_) {
      // Ignore pages without finalized video artifacts.
    }
  }
  return [...collected];
}

async function resetBrowserRuntimeLeasesForTest(): Promise<void> {
  for (const [sessionId, lease] of browserRuntimeLeases.entries()) {
    if (lease.externalConnection && lease.browser) {
      await lease.browser.close();
    } else {
      await lease.runtime.context.close();
    }
    if (safeExistsSync(lease.sessionMetadataPath)) {
      safeRmSync(lease.sessionMetadataPath, { force: true });
    }
    if (safeExistsSync(lease.userDataDir)) {
      safeRmSync(lease.userDataDir, { recursive: true, force: true });
    }
    browserRuntimeLeases.delete(sessionId);
  }
  if (safeExistsSync(BROWSER_SESSION_DIR)) {
    for (const entry of safeReaddir(BROWSER_SESSION_DIR)) {
      if (entry.endsWith('.json')) safeRmSync(path.join(BROWSER_SESSION_DIR, entry), { force: true });
    }
  }
}

function createBrowserRuntime(context: BrowserContext): BrowserRuntime {
  const tabs = new Map<string, Page>();
  const pageIds = new WeakMap<Page, string>();
  const cdpSessions = new WeakMap<Page, CDPSession>();
  const runtime: BrowserRuntime = {
    context,
    tabs,
    pageIds,
    cdpSessions,
    activeTabId: 'tab-1',
    consoleEvents: [],
    networkEvents: [],
    webAuthn: {
      enabled: false,
      credentials: [],
      events: [],
    },
  };

  const pages = context.pages();
  for (const [index, page] of pages.entries()) {
    registerBrowserPage(runtime, page, `tab-${index + 1}`);
  }
  if (pages.length > 0) runtime.activeTabId = pageIds.get(pages[0]) || 'tab-1';
  return runtime;
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
    runtime.webAuthn!.credentials = upsertPasskeyCredential(runtime.webAuthn!.credentials, event.credential);
  });
  session.on('WebAuthn.credentialAsserted', (event: any) => {
    runtime.webAuthn!.events.push({
      type: 'credentialAsserted',
      credential: event.credential,
      ts: new Date().toISOString(),
    });
    runtime.webAuthn!.credentials = upsertPasskeyCredential(runtime.webAuthn!.credentials, event.credential);
  });
  session.on('WebAuthn.credentialDeleted', (event: any) => {
    runtime.webAuthn!.events.push({
      type: 'credentialDeleted',
      credentialId: event.credentialId,
      ts: new Date().toISOString(),
    });
    runtime.webAuthn!.credentials = runtime.webAuthn!.credentials.filter(
      (credential) => credential.credentialId !== event.credentialId,
    );
  });
  session.on('WebAuthn.credentialUpdated', (event: any) => {
    runtime.webAuthn!.events.push({
      type: 'credentialUpdated',
      credential: event.credential,
      ts: new Date().toISOString(),
    });
    runtime.webAuthn!.credentials = upsertPasskeyCredential(runtime.webAuthn!.credentials, event.credential);
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
  },
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

async function removeVirtualPasskeyAuthenticator(runtime: BrowserRuntime, page: Page): Promise<void> {
  const authenticatorId = getPasskeyAuthenticatorId(runtime);
  const cdp = await getOrCreatePageCdpSession(runtime, page);
  await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
  runtime.webAuthn = {
    enabled: true,
    credentials: [],
    events: [],
  };
}

async function getVirtualPasskeyCredentials(runtime: BrowserRuntime, page: Page): Promise<Array<Record<string, any>>> {
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
    throw new Error('No virtual passkey authenticator is active. Run setup_passkey_authenticator first.');
  }
  return authenticatorId;
}

function upsertPasskeyCredential(
  credentials: Array<Record<string, any>>,
  nextCredential: Record<string, any> | undefined,
): Array<Record<string, any>> {
  if (!nextCredential?.credentialId) return credentials;
  const next = credentials.filter((credential) => credential.credentialId !== nextCredential.credentialId);
  next.push(nextCredential);
  return next;
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

function loadPasskeyProviderCatalog(): { default_provider?: string; providers: Record<string, any> } {
  if (safeExistsSync(PASSKEY_PROVIDER_CATALOG_PATH)) {
    try {
      const parsed = JSON.parse(safeReadFile(PASSKEY_PROVIDER_CATALOG_PATH, { encoding: 'utf8' }) as string);
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

async function registerPasskey(page: Page, runtime: BrowserRuntime, ctx: any, params: any, resolve: Function) {
  const preset = getPasskeyPreset(resolve(params.provider));
  const username = String(resolve(params.username ?? ctx.username ?? 'kyberion_passkey_user'));
  const waitMs = Number(params.wait_ms || 1500);
  if (params.navigate !== false) {
    await page.goto(String(resolve(params.url || preset.baseUrl)), { waitUntil: params.waitUntil || 'networkidle' });
  }
  if (!runtime.webAuthn?.authenticatorId || params.setup_authenticator !== false) {
    await setupVirtualPasskeyAuthenticator(runtime, page, {
      enableUI: params.enable_ui === true,
      replaceExisting: params.replace_existing !== false,
      protocol: (resolve(params.protocol || 'ctap2') as 'ctap2' | 'u2f'),
      transport: (resolve(params.transport || 'internal') as 'usb' | 'nfc' | 'ble' | 'internal'),
      hasResidentKey: params.has_resident_key !== false,
      hasUserVerification: params.has_user_verification !== false,
      hasLargeBlob: params.has_large_blob === true,
      automaticPresenceSimulation: params.automatic_presence !== false,
      isUserVerified: params.user_verified !== false,
    });
  }
  await page.fill(resolve(params.username_selector || preset.usernameSelector), username, { timeout: params.timeout || 5000 });
  await page.click(resolve(params.register_selector || preset.registerSelector), { timeout: params.timeout || 5000 });
  await page.waitForTimeout(waitMs);
  const credentials = await getVirtualPasskeyCredentials(runtime, page);
  return {
    provider: resolve(params.provider || 'webauthn.io'),
    username,
    credentials,
    url: page.url(),
  };
}

async function authenticatePasskey(page: Page, runtime: BrowserRuntime, ctx: any, params: any, resolve: Function) {
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
    await authPage.goto(String(resolve(params.url || preset.baseUrl)), { waitUntil: params.waitUntil || 'networkidle' });
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
      await authPage.fill(resolve(params.username_selector || preset.usernameSelector), username, { timeout: params.timeout || 5000 });
    }
    await authPage.click(resolve(params.authenticate_selector || preset.authenticateSelector), { timeout: params.timeout || 5000 });
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
    authenticated: preset.postAuthUrlIncludes ? authPage.url().includes(preset.postAuthUrlIncludes) : true,
  };
}

async function deletePasskey(page: Page, runtime: BrowserRuntime, ctx: any, params: any, resolve: Function) {
  const authenticatorId = getPasskeyAuthenticatorId(runtime);
  const cdp = await getOrCreatePageCdpSession(runtime, page);
  const credentials = await getVirtualPasskeyCredentials(runtime, page);
  let credentialToDelete: Record<string, any> | undefined;

  if (params.credential_id) {
    const credentialId = String(resolve(params.credential_id));
    credentialToDelete = credentials.find((credential) => credential.credentialId === credentialId);
  } else if (params.username) {
    const username = String(resolve(params.username));
    credentialToDelete = credentials.find((credential) => credential.userName === username || credential.userDisplayName === username);
  } else if (credentials.length === 1) {
    credentialToDelete = credentials[0];
  }

  if (!credentialToDelete?.credentialId) {
    throw new Error('Unable to determine passkey credential to delete. Provide credential_id or username.');
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
  registerBrowserPage(runtime, page, tabId);
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

function saveBrowserSessionSnapshot(sessionId: string, snapshot: BrowserSnapshot): void {
  if (!safeExistsSync(BROWSER_SNAPSHOT_DIR)) safeMkdir(BROWSER_SNAPSHOT_DIR, { recursive: true });
  safeWriteFile(path.join(BROWSER_SNAPSHOT_DIR, `${sessionId}.json`), JSON.stringify(snapshot, null, 2));
}

async function buildSnapshot(page: Page, options: { sessionId: string; tabId: string; maxElements: number }): Promise<BrowserSnapshot> {
  const { sessionId, tabId, maxElements } = options;
  const raw = await page.evaluate((max) => {
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
      const segments: string[] = [];
      let current: Element | null = el;
      while (current && current.nodeType === Node.ELEMENT_NODE && current.tagName.toLowerCase() !== 'html') {
        const tag = current.tagName.toLowerCase();
        const htmlEl = current as HTMLElement;
        if (htmlEl.id) {
          segments.unshift(`${tag}#${CSS.escape(htmlEl.id)}`);
          break;
        }
        let elementIndex = 1;
        let sibling = current.previousElementSibling;
        while (sibling) {
          if (sibling.tagName === current.tagName) elementIndex += 1;
          sibling = sibling.previousElementSibling;
        }
        segments.unshift(`${tag}:nth-of-type(${elementIndex})`);
        current = current.parentElement;
      }
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
        selector: segments.length ? segments.join(' > ') : 'body',
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
  const inputContent = safeReadFile(pathResolver.rootResolve(argv.input as string), { encoding: 'utf8' }) as string;
  const result = await handleAction(JSON.parse(inputContent));
  console.log(JSON.stringify(result, null, 2));
};

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}

export {
  handleAction,
  buildSnapshot,
  resolveRefSelector,
  renderPlaywrightSkeleton,
  renderBrowserAdf,
  resetBrowserRuntimeLeasesForTest,
  closeBrowserSession,
  restartBrowserSession,
  waitForOperatorContinue,
};
