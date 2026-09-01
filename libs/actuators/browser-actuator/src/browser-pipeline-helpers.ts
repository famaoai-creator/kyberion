import { logger } from '@agent/core/core';
import {
  assertSafeRepositoryPath,
  safeWriteFile,
  safeMkdir,
  safeExistsSync,
  safeReaddir,
} from '@agent/core/secure-io';
import { runAdfActuatorPipeline } from '@agent/core/actuator-sdk';
import { DEFAULT_MAX_PIPELINE_STEPS } from '@agent/core/execution-bounds';
import { TraceContext, persistTrace } from '@agent/core/src/trace';
import { pathResolver } from '@agent/core/path-resolver';
import { getPathValue } from '@agent/core/src/logic-utils';
import { retry } from '@agent/core/async-utils';
import { createGovernedRetryOptionsBuilder } from '@agent/core/recovery-policy';
import { processUntrustedContent } from '@agent/core/untrusted-content';
import { decideFromObservation, executeLlmDecideOp } from '@agent/core/semantic-decide';
import { getSecret } from '@agent/core/secret-guard';
import { browserRuntimeHelpers } from './browser-runtime-helpers.js';
import { resolveRefOrRecordedTarget } from './recorded-ref-resolver.js';
import { opControl } from './browser-control-helpers.js';
import { type CDPSession, type Page } from '@playwright/test';
import * as path from 'node:path';
import {
  registerPasskey,
  authenticatePasskey,
  deletePasskey,
  getVirtualPasskeyCredentials,
  getPasskeyAuthenticatorId,
  getOrCreatePageCdpSession,
} from './browser-passkey-helpers.js';

interface PipelineStep {
  type: 'capture' | 'transform' | 'apply' | 'control';
  op: string;
  params: any;
}

export interface BrowserRuntime {
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
  navigationPolicy?: {
    allowed_origins?: string[];
    allow_private_network?: boolean;
    allow_data_url?: boolean;
  };
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

const buildBrowserRetryOptions = createGovernedRetryOptionsBuilder({
  manifestPath: BROWSER_MANIFEST_PATH,
  defaults: DEFAULT_BROWSER_RETRY,
  fallbackCategories: ['network', 'timeout', 'resource_unavailable'],
  additionalShouldRetry: (error) =>
    /selector|not visible|strict mode violation|detached/i.test(error.message),
});

function resolveBrowserRepositoryPath(ref: unknown, allowMissingLeaf = true): string {
  return assertSafeRepositoryPath(pathResolver.rootResolve(String(ref || '').trim()), {
    allowMissingLeaf,
  });
}

function buildRetryOptions(stepParams: Record<string, any>) {
  const explicitRetry =
    stepParams && typeof stepParams.retry === 'object' && !Array.isArray(stepParams.retry)
      ? { ...(stepParams.retry as Record<string, any>) }
      : {};
  if (stepParams?.max_retries !== undefined)
    explicitRetry.maxRetries = Number(stepParams.max_retries);
  if (stepParams?.retry_delay_ms !== undefined)
    explicitRetry.initialDelayMs = Number(stepParams.retry_delay_ms);
  return buildBrowserRetryOptions(explicitRetry);
}

export async function executePipeline(
  steps: PipelineStep[],
  sessionId: string,
  options: any,
  initialCtx: any = {}
) {
  const MAX_STEPS = options.max_steps || DEFAULT_MAX_PIPELINE_STEPS;
  const TIMEOUT = options.timeout_ms || 300000;

  const userDataDir = resolveBrowserRepositoryPath(
    options.user_data_dir || path.join(BROWSER_RUNTIME_DIR, sessionId)
  );
  if (!safeExistsSync(userDataDir)) safeMkdir(userDataDir, { recursive: true });
  if (!safeExistsSync(BROWSER_SESSION_DIR)) safeMkdir(BROWSER_SESSION_DIR, { recursive: true });
  const sessionMetadataPath = assertSafeRepositoryPath(
    path.join(BROWSER_SESSION_DIR, `${sessionId}.json`),
    { allowMissingLeaf: true }
  );

  const tracePath = assertSafeRepositoryPath(
    path.join(EVIDENCE_DIR, `trace_${sessionId}_${Date.now()}.zip`),
    { allowMissingLeaf: true }
  );
  const videoDir = assertSafeRepositoryPath(path.join(EVIDENCE_DIR, 'videos', sessionId), {
    allowMissingLeaf: true,
  });
  const resolvedVideoDir = resolveBrowserRepositoryPath(options.video_artifact_dir || videoDir);
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
  runtime.navigationPolicy = options.navigation_policy;
  const activeLease = browserRuntimeHelpers.findBrowserRuntimeLease(runtime) as
    BrowserRuntimeLeaseLike | undefined;
  if (runtime.tabs.size === 0) {
    const page = await browserContext.newPage();
    browserRuntimeHelpers.registerBrowserPage(runtime, page, 'tab-1');
  }

  let ctx = {
    ...initialCtx,
    session_id: sessionId,
    active_tab_id: runtime.activeTabId,
    browser_tabs: await browserRuntimeHelpers.summarizeTabs(runtime),
    action_trail: Array.isArray(initialCtx?.action_trail)
      ? initialCtx.action_trail
      : browserRuntimeHelpers.loadBrowserActionTrail(sessionId),
    action_trail_max: Math.max(1, Math.min(2000, Number(options.action_trail_max || 200))),
    timestamp: new Date().toISOString(),
  };

  const traceCtx = new TraceContext(`browser-pipeline:${sessionId}`, {
    actuator: 'browser-actuator',
    pipelineId: sessionId,
  });

  // AR-01 Task 2: hand-rolled loop replaced by the canonical engine
  // (runAdfActuatorPipeline). on_error recovery is now the engine's native
  // handleStepError path; spans / screenshot artifacts / action-trail events
  // are injected via engine step hooks. Two deliberate semantic changes:
  // nested control failures propagate (AR-06 no-silent-failure), and nested
  // steps (control sub-pipelines, on_error fallbacks) now emit trace spans.
  const trailDepths: number[] = [];
  const hooks = {
    beforeStep: (step: any, stepNumber: number, stepCtx: any) => {
      trailDepths.push(Array.isArray(stepCtx.action_trail) ? stepCtx.action_trail.length : 0);
      traceCtx.startSpan(`${step.type}:${step.op}`, {
        stepId: step.id || `step-${stepNumber}`,
      });
    },
    afterStep: (step: any, _stepNumber: number, stepCtx: any, outcome: any) => {
      const trailBefore = trailDepths.pop() ?? 0;
      if (outcome.status === 'failed' || outcome.status === 'recovered') {
        traceCtx.endSpan('error', outcome.error);
        return;
      }

      if (step.op === 'screenshot') {
        const screenshotPath =
          stepCtx.last_screenshot || stepCtx[step.params?.export_as || 'last_screenshot'];
        if (screenshotPath) {
          traceCtx.addArtifact('screenshot', screenshotPath, step.id || 'screenshot');
        }
      }

      // Emit each new browser action as a trace event so the trail is queryable in Chronos
      if (Array.isArray(stepCtx.action_trail) && stepCtx.action_trail.length > trailBefore) {
        for (const act of (stepCtx.action_trail as any[]).slice(trailBefore)) {
          const attrs: Record<string, string | number | boolean> = {
            kind: String(act.kind || ''),
            op: String(act.op || ''),
          };
          if (act.tab_id) attrs.tab_id = String(act.tab_id);
          if (act.url) attrs.url = String(act.url).slice(0, 200);
          if (act.title) attrs.title = String(act.title).slice(0, 120);
          if (act.selector) attrs.selector = String(act.selector).slice(0, 200);
          if (act.ref) attrs.ref = String(act.ref).slice(0, 80);
          if (act.redacted) attrs.redacted = true;
          if (act.approval_request_id) attrs.approval_request_id = String(act.approval_request_id);
          if (act.resume_status) attrs.resume_status = String(act.resume_status);
          traceCtx.addEvent('browser.action', attrs);
        }
      }

      traceCtx.endSpan('ok');
    },
  };

  let engineResult!: Awaited<ReturnType<typeof runAdfActuatorPipeline>>;
  try {
    engineResult = await runAdfActuatorPipeline({
      actuatorId: 'browser',
      steps,
      context: ctx,
      options: { maxSteps: MAX_STEPS, timeoutMs: TIMEOUT },
      handlers: {
        capture: (op, params, stepCtx, resolveFn) =>
          opCapture(op, params, runtime, stepCtx, resolveFn),
        transform: (op, params, stepCtx, resolveFn) => opTransform(op, params, stepCtx, resolveFn),
        apply: (op, params, stepCtx, resolveFn) => opApply(op, params, runtime, stepCtx, resolveFn),
        control: (op, params, stepCtx, runSteps, resolveFn) =>
          opControl(op, params, runtime, stepCtx, runSteps, resolveFn),
      },
      hooks,
    });
    ctx = engineResult.context;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    ctx = {
      ...ctx,
      error: message,
      console_events: runtime.consoleEvents.slice(-50),
      network_events: runtime.networkEvents.slice(-50),
    };
    ctx.failure_bundle_path = browserRuntimeHelpers.saveFailureBundle(sessionId, {
      schema_version: 'browser-failure-bundle.v1',
      session_id: sessionId,
      created_at: new Date().toISOString(),
      error: ctx.error,
      url: ctx.last_url || null,
      title: ctx.last_snapshot?.title || null,
      snapshot: ctx.last_snapshot || null,
      screenshot: ctx.last_screenshot || null,
      trace_path: ctx.last_trace_path || null,
      console_events: ctx.console_events,
      network_events: ctx.network_events,
      action_trail: browserRuntimeHelpers.readRecordedActions(ctx).slice(-200),
    });
    throw error;
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
    // A failed pipeline enters this finally block before the trace is
    // finalized. Refresh the failure bundle after tracing stops so the
    // automatic evidence artifact contains the trace path as promised.
    if (ctx.error) {
      ctx.failure_bundle_path = browserRuntimeHelpers.saveFailureBundle(sessionId, {
        schema_version: 'browser-failure-bundle.v1',
        session_id: sessionId,
        created_at: new Date().toISOString(),
        error: ctx.error,
        url: ctx.last_url || null,
        title: ctx.last_snapshot?.title || null,
        snapshot: ctx.last_snapshot || null,
        screenshot: ctx.last_screenshot || null,
        trace_path: ctx.last_trace_path || (options.record_trace ? tracePath : null),
        console_events: runtime.consoleEvents.slice(-50),
        network_events: runtime.networkEvents.slice(-50),
        action_trail: browserRuntimeHelpers.readRecordedActions(ctx).slice(-200),
      });
    }
    ctx.browser_tabs = await browserRuntimeHelpers.summarizeTabs(runtime);
    ctx.active_tab_id = runtime.activeTabId;
    // A single-op sub-pipeline dispatched by the actuator SDK carries the
    // outer pipeline's options on ctx.__pipeline_options; honour its
    // keep_alive/lease so leased sessions survive between outer steps.
    const outerOptions =
      ctx.__pipeline_options && typeof ctx.__pipeline_options === 'object'
        ? (ctx.__pipeline_options as { keep_alive?: unknown; lease_ms?: unknown })
        : undefined;
    const keepAlive =
      options.keep_alive === true ||
      Number(options.lease_ms || 0) > 0 ||
      outerOptions?.keep_alive === true ||
      Number(outerOptions?.lease_ms || 0) > 0;
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
      action_trail_path: browserRuntimeHelpers.saveBrowserActionTrail(sessionId, ctx.action_trail),
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
        action_trail_path: browserRuntimeHelpers.saveBrowserActionTrail(
          sessionId,
          ctx.action_trail
        ),
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
    status: engineResult.status,
    results: engineResult.results,
    context: ctx,
    total_steps: engineResult.total_steps,
  };
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
      browserRuntimeHelpers.assertNavigationAllowed(url, runtime.navigationPolicy);
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
    case 'extract_text_ref': {
      const ref = resolve(params.ref);
      const { selector, ctx: resolvedCtx } = await resolveRefOrRecordedTarget(
        ctx,
        ref,
        page,
        recordedRefTargetFromParams(params, { requireDomPathMatch: Boolean(params.high_risk) })
      );
      const rawContent = await page.innerText(selector);
      const content = processUntrustedContent(rawContent, `web:${page.url()}`).wrapped;
      return browserRuntimeHelpers.recordBrowserAction(
        {
          ...resolvedCtx,
          last_capture: content,
          [params.export_as || 'last_capture']: content,
        },
        {
          kind: 'capture',
          op: 'extract_text_ref',
          tab_id: runtime.activeTabId,
          ref,
          selector,
          content_excerpt: rawContent.trim().slice(0, 120),
        }
      );
    }
    case 'session_health': {
      const health = await browserRuntimeHelpers.getSessionHealth(
        ctx.session_id || 'default',
        runtime,
        ctx.action_trail
      );
      return browserRuntimeHelpers.recordBrowserAction(
        { ...ctx, last_capture: health, [params.export_as || 'browser_health']: health },
        { kind: 'capture', op: 'session_health', tab_id: runtime.activeTabId }
      );
    }
    case 'action_trail': {
      const source = browserRuntimeHelpers.readRecordedActions(ctx, params.from);
      const trail = source.slice(-Math.max(1, Math.min(2000, Number(params.limit || 50))));
      return browserRuntimeHelpers.recordBrowserAction(
        { ...ctx, last_capture: trail, [params.export_as || 'action_trail']: trail },
        { kind: 'capture', op: 'action_trail', tab_id: runtime.activeTabId }
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
      const outPath = resolveBrowserRepositoryPath(
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
      const rawContent = selector ? await page.innerText(selector) : await page.content();
      const content =
        typeof rawContent === 'string'
          ? processUntrustedContent(rawContent, `web:${page.url()}`).wrapped
          : rawContent;
      return browserRuntimeHelpers.recordBrowserAction(
        { ...ctx, [params.export_as || 'last_capture']: content },
        {
          kind: 'capture',
          op: 'content',
          tab_id: runtime.activeTabId,
          selector,
          content_excerpt:
            typeof rawContent === 'string' ? rawContent.trim().slice(0, 120) : undefined,
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
    case 'distill_dom': {
      // AR-07: deterministic interactive-element inventory for in-loop
      // decisions (same DOM -> same output; capped).
      const inventory = await distillDomInventory(page, {
        maxElements: typeof params.max_elements === 'number' ? params.max_elements : undefined,
      });
      return browserRuntimeHelpers.recordBrowserAction(
        { ...ctx, [params.export_as || 'dom_distillate']: inventory },
        { kind: 'capture', op: 'distill_dom', tab_id: runtime.activeTabId }
      );
    }
    case 'llm_decide': {
      // AR-07: one in-loop decision about a distilled observation. With
      // params.options the reply must be a member (selection mode); a null
      // decision exports null and downstream `if` conditions handle it —
      // the op itself never throws on model failure.
      const decided = await executeLlmDecideOp({
        params,
        ctx,
        resolve: resolve as (value: any) => any,
        defaultFromKey: 'dom_distillate',
      });
      return browserRuntimeHelpers.recordBrowserAction(decided, {
        kind: 'capture',
        op: 'llm_decide',
        tab_id: runtime.activeTabId,
      });
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
      const outPath = params.path ? resolveBrowserRepositoryPath(resolve(params.path)) : undefined;
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
      const outPath = resolveBrowserRepositoryPath(
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
      const outPath = resolveBrowserRepositoryPath(
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
    case 'export_failure_bundle': {
      const trail = browserRuntimeHelpers.readRecordedActions(ctx, params.from).slice(-200);
      const bundle = {
        schema_version: 'browser-failure-bundle.v1',
        session_id: ctx.session_id || 'default',
        created_at: new Date().toISOString(),
        error: ctx.error || ctx.last_error || null,
        url: ctx.last_url || ctx.last_snapshot?.url || null,
        title: ctx.last_snapshot?.title || null,
        snapshot: ctx.last_snapshot || null,
        screenshot: ctx.last_screenshot || null,
        trace_path: ctx.last_trace_path || ctx.trace_persisted_path || null,
        console_events: Array.isArray(ctx.console_events) ? ctx.console_events.slice(-50) : [],
        network_events: Array.isArray(ctx.network_events) ? ctx.network_events.slice(-50) : [],
        action_trail: trail,
      };
      const outPath = browserRuntimeHelpers.saveFailureBundle(
        ctx.session_id || 'default',
        bundle,
        params.path ? resolve(params.path) : undefined
      );
      return {
        ...ctx,
        failure_bundle: bundle,
        [params.export_as || 'failure_bundle_path']: outPath,
      };
    }
    default:
      throw new Error(`Unsupported transform operator in Browser-Actuator: ${op}`);
  }
}

/**
 * AC-02: page.fill timeouts were opaque ("locator not found" after 5s with
 * no clue what WAS on the page). Resolution ladder: the literal selector,
 * then label text, placeholder, and name attribute (using the optional
 * params.field hint or the selector itself when it looks like plain text).
 * Total failure throws an error that lists the visible input candidates so
 * the operator/repair agent can correct the step without reopening the page.
 */
// AR-07: deterministic DOM distillation — an interactive-element inventory
// small enough for in-loop LLM decisions. Same DOM, same output; capped.
export async function distillDomInventory(
  page: Page,
  options: { maxElements?: number } = {}
): Promise<Array<{ selector: string; tag: string; role: string; text: string; visible: boolean }>> {
  const maxElements = Math.min(options.maxElements ?? 120, 300);
  return page.evaluate((cap: number) => {
    const nodes = Array.from(
      document.querySelectorAll(
        'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [contenteditable="true"], [onclick]'
      )
    ) as HTMLElement[];
    const cssPath = (el: HTMLElement): string => {
      if (el.id) return `#${CSS.escape(el.id)}`;
      const name = (el as HTMLInputElement).name;
      if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
      const parts: string[] = [];
      let node: HTMLElement | null = el;
      let depth = 0;
      while (node && node.tagName !== 'BODY' && depth < 5) {
        const parent: HTMLElement | null = node.parentElement;
        const siblings = parent
          ? (Array.from(parent.children) as HTMLElement[]).filter(
              (c) => c.tagName === node!.tagName
            )
          : [];
        const index = siblings.indexOf(node) + 1;
        parts.unshift(
          siblings.length > 1
            ? `${node.tagName.toLowerCase()}:nth-of-type(${index})`
            : node.tagName.toLowerCase()
        );
        node = parent;
        depth += 1;
      }
      return parts.join(' > ');
    };
    return nodes.slice(0, cap).map((el) => ({
      selector: cssPath(el),
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || (el as HTMLInputElement).type || el.tagName.toLowerCase(),
      text: (
        el.textContent ||
        (el as HTMLInputElement).value ||
        (el as HTMLInputElement).placeholder ||
        el.getAttribute('aria-label') ||
        ''
      )
        .trim()
        .slice(0, 80),
      visible: el.offsetParent !== null,
    }));
  }, maxElements);
}

export async function fillWithFallback(
  page: Page,
  input: { selector: string; text: string; timeoutMs: number; fieldHint?: string }
): Promise<{ strategy: string }> {
  const attempts: string[] = [];
  const hint =
    input.fieldHint ||
    (/^[\w\s@.\-぀-ヿ一-鿿]+$/u.test(input.selector) && !input.selector.includes('=')
      ? input.selector
      : undefined);

  const tryStrategy = async (
    strategy: string,
    run: () => Promise<void>
  ): Promise<{ strategy: string } | null> => {
    try {
      await run();
      return { strategy };
    } catch (err: any) {
      attempts.push(`${strategy}: ${String(err?.message || err).split('\n')[0]}`);
      return null;
    }
  };

  const direct = await tryStrategy('selector', () =>
    page.fill(input.selector, input.text, { timeout: input.timeoutMs })
  );
  if (direct) return direct;

  if (hint) {
    const byLabel = await tryStrategy('label', () =>
      page.getByLabel(hint, { exact: false }).first().fill(input.text, { timeout: input.timeoutMs })
    );
    if (byLabel) return byLabel;

    const byPlaceholder = await tryStrategy('placeholder', () =>
      page.getByPlaceholder(hint).first().fill(input.text, { timeout: input.timeoutMs })
    );
    if (byPlaceholder) return byPlaceholder;

    const byName = await tryStrategy('name', () =>
      page.locator(`[name="${hint}"]`).first().fill(input.text, { timeout: input.timeoutMs })
    );
    if (byName) return byName;
  }

  let candidates = '';
  try {
    const found = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input, textarea, select, [contenteditable="true"]'))
        .slice(0, 10)
        .map((el) => {
          const node = el as HTMLInputElement;
          return [
            node.tagName.toLowerCase(),
            node.type ? `type=${node.type}` : '',
            node.name ? `name=${node.name}` : '',
            node.id ? `id=${node.id}` : '',
            node.placeholder ? `placeholder=${node.placeholder}` : '',
          ]
            .filter(Boolean)
            .join(' ');
        })
    );
    candidates = found.length > 0 ? ` Visible input candidates: ${found.join(' | ')}` : '';
  } catch {
    /* candidate enumeration is best-effort context for the error */
  }

  // AR-07 final rung: let the reasoning backend PICK among real candidate
  // selectors (selection, not generation). Any failure falls through to the
  // legacy error so LLM unavailability never changes the failure contract.
  try {
    const inventory = (await distillDomInventory(page, { maxElements: 60 })).filter(
      (entry) => entry.visible && ['input', 'textarea', 'select'].includes(entry.tag)
    );
    if (inventory.length > 0) {
      const decision = await decideFromObservation({
        goal: `Pick the selector of the form field to fill${hint ? ` for "${hint}"` : ''} with the provided text.`,
        observation: inventory
          .map((entry) => `${entry.selector} [${entry.role}] ${entry.text}`)
          .join('\n'),
        options: inventory.map((entry) => entry.selector),
      });
      if (decision) {
        const llmPick = await tryStrategy('llm_pick', () =>
          page.fill(decision.decision, input.text, { timeout: input.timeoutMs })
        );
        if (llmPick) return llmPick;
      }
    }
  } catch (err: any) {
    attempts.push(`llm_pick: ${String(err?.message || err).split('\n')[0]}`);
  }

  throw new Error(
    `fill failed for selector "${input.selector}" after ${attempts.length} strategies (${attempts.join('; ')}).${candidates}`
  );
}

function recordedRefTargetFromParams(
  params: Record<string, unknown>,
  overrides: { requireDomPathMatch?: boolean } = {}
): { role?: string; name?: string; dom_path?: string; requireDomPathMatch?: boolean } {
  return {
    ...(typeof params.role === 'string' ? { role: params.role } : {}),
    ...(typeof params.name === 'string' ? { name: params.name } : {}),
    ...(typeof params.dom_path === 'string' ? { dom_path: params.dom_path } : {}),
    ...overrides,
  };
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
      browserRuntimeHelpers.assertNavigationAllowed(url, runtime.navigationPolicy);
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
    case 'fill': {
      const fillResult = await retry(
        async () =>
          fillWithFallback(page, {
            selector: resolve(params.selector),
            text: resolve(params.text),
            timeoutMs: params.timeout || 5000,
            fieldHint: params.field ? resolve(params.field) : undefined,
          }),
        buildRetryOptions(params)
      );
      return browserRuntimeHelpers.recordBrowserAction(ctx, {
        kind: 'apply',
        op: 'fill',
        tab_id: runtime.activeTabId,
        selector: resolve(params.selector),
        text: resolve(params.text),
        ...(fillResult.strategy !== 'selector' ? { fallback_strategy: fillResult.strategy } : {}),
      });
    }
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
      const { selector, ctx: resolvedCtx } = await resolveRefOrRecordedTarget(
        ctx,
        ref,
        page,
        recordedRefTargetFromParams(params, { requireDomPathMatch: Boolean(params.high_risk) })
      );
      const element = browserRuntimeHelpers.findSnapshotElement(resolvedCtx, ref);
      await retry(async () => {
        await page.click(selector, { timeout: params.timeout || 5000 });
      }, buildRetryOptions(params));
      return browserRuntimeHelpers.recordBrowserAction(resolvedCtx, {
        kind: 'apply',
        op: 'click_ref',
        tab_id: runtime.activeTabId,
        ref,
        selector,
        element_name: element?.name ?? params.name,
        element_role: element?.role ?? params.role,
      });
    }
    case 'fill_ref': {
      const ref = resolve(params.ref);
      const secretKey = params.secret_ref
        ? String(resolve(params.secret_ref))
        : params.classification === 'secret_ref' && params.variable?.name
          ? String(resolve(params.variable.name))
          : undefined;
      // Secret-bearing fills must corroborate the role/name match against
      // dom_path (or fail closed if no dom_path was recorded) — a relabeled
      // live element must never receive a secret value. See
      // RecordedRefSpoofSuspectedError in recorded-ref-resolver.ts.
      const { selector, ctx: resolvedCtx } = await resolveRefOrRecordedTarget(
        ctx,
        ref,
        page,
        recordedRefTargetFromParams(params, {
          requireDomPathMatch: Boolean(secretKey) || Boolean(params.high_risk),
        })
      );
      const element = browserRuntimeHelpers.findSnapshotElement(resolvedCtx, ref);
      const text = secretKey
        ? getSecret(secretKey, undefined, 'browser.fill_ref')
        : resolve(params.text);
      if (secretKey && text == null)
        throw new Error(`[BROWSER_SECRET_MISSING] SecretResolver could not resolve ${secretKey}`);
      await retry(async () => {
        await page.fill(selector, String(text ?? ''), { timeout: params.timeout || 5000 });
      }, buildRetryOptions(params));
      return browserRuntimeHelpers.recordBrowserAction(resolvedCtx, {
        kind: 'apply',
        op: 'fill_ref',
        tab_id: runtime.activeTabId,
        ref,
        selector,
        ...(secretKey
          ? { classification: 'secret_ref' as const, secret_ref: secretKey }
          : { text }),
        element_name: element?.name ?? params.name,
        element_role: element?.role ?? params.role,
      });
    }
    case 'fill_secret_ref': {
      const ref = resolve(params.ref);
      const secretKey = String(resolve(params.secret_ref));
      const secret = getSecret(secretKey, undefined, 'browser.fill_secret_ref');
      if (secret == null)
        throw new Error(`[BROWSER_SECRET_MISSING] SecretResolver could not resolve ${secretKey}`);
      const { selector, ctx: resolvedCtx } = await resolveRefOrRecordedTarget(
        ctx,
        ref,
        page,
        recordedRefTargetFromParams(params, { requireDomPathMatch: true })
      );
      const element = browserRuntimeHelpers.findSnapshotElement(resolvedCtx, ref);
      await retry(
        async () => page.fill(selector, secret, { timeout: params.timeout || 5000 }),
        buildRetryOptions(params)
      );
      return browserRuntimeHelpers.recordBrowserAction(resolvedCtx, {
        kind: 'apply',
        op: 'fill_secret_ref',
        tab_id: runtime.activeTabId,
        ref,
        selector,
        secret_ref: secretKey,
        classification: 'secret_ref',
        element_name: element?.name ?? params.name,
        element_role: element?.role ?? params.role,
      });
    }
    case 'press_ref': {
      const ref = resolve(params.ref);
      const key = resolve(params.key);
      const { selector, ctx: resolvedCtx } = await resolveRefOrRecordedTarget(
        ctx,
        ref,
        page,
        recordedRefTargetFromParams(params, { requireDomPathMatch: Boolean(params.high_risk) })
      );
      const element = browserRuntimeHelpers.findSnapshotElement(resolvedCtx, ref);
      await retry(async () => {
        await page.press(selector, key, { timeout: params.timeout || 5000 });
      }, buildRetryOptions(params));
      return browserRuntimeHelpers.recordBrowserAction(resolvedCtx, {
        kind: 'apply',
        op: 'press_ref',
        tab_id: runtime.activeTabId,
        ref,
        selector,
        key,
        element_name: element?.name ?? params.name,
        element_role: element?.role ?? params.role,
      });
    }
    case 'scroll_ref': {
      const ref = resolve(params.ref);
      const { selector, ctx: resolvedCtx } = await resolveRefOrRecordedTarget(
        ctx,
        ref,
        page,
        recordedRefTargetFromParams(params, { requireDomPathMatch: Boolean(params.high_risk) })
      );
      const element = browserRuntimeHelpers.findSnapshotElement(resolvedCtx, ref);
      await retry(
        async () =>
          page.locator(selector).scrollIntoViewIfNeeded({ timeout: params.timeout || 5000 }),
        buildRetryOptions(params)
      );
      return browserRuntimeHelpers.recordBrowserAction(resolvedCtx, {
        kind: 'apply',
        op: 'scroll_ref',
        tab_id: runtime.activeTabId,
        ref,
        selector,
        element_name: element?.name ?? params.name,
        element_role: element?.role ?? params.role,
      });
    }
    case 'scroll': {
      const delta = params.delta || {};
      const x = Math.max(-5000, Math.min(5000, Number(params.x ?? delta.x ?? 0)));
      const y = Math.max(-5000, Math.min(5000, Number(params.y ?? delta.y ?? 0)));
      await page.mouse.wheel(x, y);
      return browserRuntimeHelpers.recordBrowserAction(ctx, {
        kind: 'apply',
        op: 'scroll',
        tab_id: runtime.activeTabId,
        content_excerpt: `delta(${x},${y})`,
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
      const { selector, ctx: resolvedCtx } = await resolveRefOrRecordedTarget(
        ctx,
        ref,
        page,
        recordedRefTargetFromParams(params, { requireDomPathMatch: Boolean(params.high_risk) })
      );
      await retry(async () => {
        await page.waitForSelector(selector, {
          state: params.state || 'visible',
          timeout: params.timeout || 10000,
        });
      }, buildRetryOptions(params));
      return browserRuntimeHelpers.recordBrowserAction(resolvedCtx, {
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
        BrowserRuntimeLeaseLike | undefined;
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
      browserRuntimeHelpers.assertNavigationAllowed(targetUrl, runtime.navigationPolicy);
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
