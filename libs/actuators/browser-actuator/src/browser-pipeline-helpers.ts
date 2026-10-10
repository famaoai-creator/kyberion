import { logger } from '@agent/core/core';
import { assertSafeRepositoryPath, safeMkdir, safeExistsSync } from '@agent/core/secure-io';
import {
  runAdfActuatorPipeline,
  defineActuatorPipelineBase,
} from '@agent/core/actuator/actuator-sdk';
import type { AdfStepHooks, AdfStepOutcome } from '@agent/core/pipeline/adf-engine';
import { DEFAULT_MAX_PIPELINE_STEPS } from '@agent/core/execution-bounds';
import { TraceContext, persistTrace } from '@agent/core/trace';
import { pathResolver } from '@agent/core/path-resolver';

import { decideFromObservation } from '@agent/core/semantic-decide';
import { getRetryDefaults } from '@agent/core/async-utils';
import { clamp, isRecord, nowIso } from '@agent/core/foundation';
import { browserRuntimeHelpers } from './browser-runtime-helpers.js';
import { judgedFailureKindFields, saveBrowserFailureBundle } from './browser-failure-bundle.js';
import { preflightAutomationRuntime } from './browser-runtime-capabilities.js';
import { buildBrowserPipelineSummary, refMapFromSnapshot } from './browser-pipeline-summary.js';
import { opControl } from './browser-control-helpers.js';
import { type CDPSession, type Page } from '@playwright/test';
import * as path from 'node:path';
import { resolveRegisteredBrowserProfile } from './browser-profile-provider-registry.js';
import {
  BROWSER_APPLY_OP_HANDLERS,
  BROWSER_CAPTURE_OP_HANDLERS,
  BROWSER_TRANSFORM_OP_HANDLERS,
  type BrowserOpSupport,
} from './browser-pipeline-op-handlers.js';

interface PipelineStep {
  type: 'capture' | 'transform' | 'apply' | 'control';
  op: string;
  params: Record<string, unknown>;
}

export interface BrowserRuntime {
  context: any;
  tabs: Map<string, Page>;
  pageIds: WeakMap<Page, string>;
  cdpSessions: WeakMap<Page, CDPSession>;
  activeTabId: string;
  consoleEvents: Array<{
    tab_id: string;
    type: string;
    text: string;
    ts: string;
  }>;
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

export interface BrowserRuntimeLeaseLike {
  userDataDir: string;
  cdpUrl?: string;
  cdpPort?: number;
  scopeFingerprint?: string;
}

const BROWSER_RUNTIME_DIR = pathResolver.shared('runtime/browser');
const BROWSER_SESSION_DIR = path.join(BROWSER_RUNTIME_DIR, 'sessions');
const EVIDENCE_DIR = pathResolver.rootResolve('evidence/browser');

const DEFAULT_BROWSER_RETRY = getRetryDefaults('browser');

const { buildStepRetryOptions: buildRetryOptions } = defineActuatorPipelineBase({
  manifestPath: pathResolver.rootResolve('libs/actuators/browser-actuator/manifest.json'),
  retryDefaults: DEFAULT_BROWSER_RETRY,
  retryFallbackCategories: ['network', 'timeout', 'resource_unavailable'],
  additionalShouldRetry: (error) =>
    /selector|not visible|strict mode violation|detached/i.test(error.message),
});

export function resolveBrowserRepositoryPath(ref: unknown, allowMissingLeaf = true): string {
  return assertSafeRepositoryPath(pathResolver.rootResolve(String(ref || '').trim()), {
    allowMissingLeaf,
  });
}

export async function executePipeline(
  inputSteps: PipelineStep[],
  inputSessionId: string,
  inputOptions: any,
  initialCtx: any = {}
) {
  const steps = inputSteps.map((step) => {
    if (!step || typeof step.op !== 'string') return step;
    const op = step.op.startsWith('browser:') ? step.op.slice('browser:'.length) : step.op;
    return { ...step, op: op === 'navigate' ? 'goto' : op };
  });
  const { sessionId, options } = preflightAutomationRuntime(
    steps,
    inputSessionId,
    inputOptions ?? {}
  );
  const MAX_STEPS = options.max_steps || DEFAULT_MAX_PIPELINE_STEPS;
  const TIMEOUT = options.timeout_ms || 300000;

  if (options.profile || options.profile_name || options.profile_email) {
    const resolved = await resolveRegisteredBrowserProfile({
      provider: options.browser_channel === 'chrome' ? 'chrome' : undefined,
      profile: String(options.profile || options.profile_name || options.profile_email),
    });
    if (resolved) {
      options.user_data_dir = options.user_data_dir || resolved.userDataDir;
      options.profile_directory = options.profile_directory || resolved.profileDirectory;
    }
  }

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
    await browserContext.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
    });
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
  // Keep the ownership captured when the lease was acquired. The ambient
  // scope may be changed by an outer caller before finalization; persisted
  // metadata must remain bound to the lease owner for close/expiry checks.
  const sessionScopeFingerprint =
    activeLease?.scopeFingerprint || browserRuntimeHelpers.getBrowserScopeFingerprint();
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
    action_trail_max: clamp(Number(options.action_trail_max || 200), 1, 2000),
    timestamp: nowIso(),
  };

  // keep_alive reuse: restore the last snapshot/ref_map so *_ref ops work across
  // separate pipeline invocations without requiring the caller to re-snapshot.
  if (!ctx.last_snapshot || !ctx.ref_map || Object.keys(ctx.ref_map as object).length === 0) {
    const priorSnapshot = browserRuntimeHelpers.loadBrowserSessionSnapshot(sessionId);
    if (priorSnapshot) {
      ctx = {
        ...ctx,
        last_snapshot: ctx.last_snapshot || priorSnapshot,
        last_capture: ctx.last_capture || priorSnapshot,
        last_url: ctx.last_url || priorSnapshot.url,
        ref_map: {
          ...refMapFromSnapshot(priorSnapshot),
          ...(isRecord(ctx.ref_map) ? ctx.ref_map : {}),
        },
      };
    }
  }

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
  const hooks: AdfStepHooks = {
    beforeStep: (step, stepNumber, stepCtx) => {
      trailDepths.push(Array.isArray(stepCtx.action_trail) ? stepCtx.action_trail.length : 0);
      const stepId = isRecord(step) && typeof step.id === 'string' ? step.id : undefined;
      traceCtx.startSpan(`${step.type}:${step.op}`, {
        stepId: stepId || `step-${stepNumber}`,
      });
    },
    afterStep: (step, _stepNumber, stepCtx, outcome: AdfStepOutcome) => {
      const trailBefore = trailDepths.pop() ?? 0;
      if (outcome.status === 'failed' || outcome.status === 'recovered') {
        traceCtx.endSpan('error', outcome.error);
        return;
      }

      if (step.op === 'screenshot') {
        const stepParams = isRecord(step.params) ? step.params : {};
        const stepId = isRecord(step) && typeof step.id === 'string' ? step.id : 'screenshot';
        const screenshotPath =
          stepCtx.last_screenshot ||
          (typeof stepParams.export_as === 'string'
            ? stepCtx[stepParams.export_as]
            : stepCtx.last_screenshot);
        if (typeof screenshotPath === 'string' && screenshotPath) {
          traceCtx.addArtifact('screenshot', screenshotPath, stepId);
        }
      }

      // Emit each new browser action as a trace event so the trail is queryable in Chronos
      const actionTrail = Array.isArray(stepCtx.action_trail) ? stepCtx.action_trail : [];
      if (actionTrail.length > trailBefore) {
        for (const act of actionTrail.slice(trailBefore)) {
          if (!isRecord(act)) continue;
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
    if (!ctx.last_screenshot) {
      try {
        const page = browserRuntimeHelpers.getActivePage(runtime);
        const failShot = resolveBrowserRepositoryPath(
          `evidence/browser/failure_${sessionId}_${Date.now()}.png`
        );
        if (!safeExistsSync(path.dirname(failShot)))
          safeMkdir(path.dirname(failShot), { recursive: true });
        await page.screenshot({ path: failShot });
        ctx.last_screenshot = failShot;
        ctx.last_url = ctx.last_url || page.url();
      } catch {
        // Best-effort evidence only; keep the original failure.
      }
    }
    ctx = {
      ...ctx,
      error: message,
      console_events: runtime.consoleEvents.slice(-50),
      network_events: runtime.networkEvents.slice(-50),
      ...(await judgedFailureKindFields(message, ctx.last_snapshot?.title)),
    };
    ctx.failure_bundle_path = saveBrowserFailureBundle(
      sessionId,
      ctx,
      runtime,
      ctx.last_trace_path || null
    );
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
      const traceRef = ctx.last_trace_path || (options.record_trace ? tracePath : null);
      ctx.failure_bundle_path = saveBrowserFailureBundle(sessionId, ctx, runtime, traceRef);
    }
    ctx.browser_tabs = await browserRuntimeHelpers.summarizeTabs(runtime);
    ctx.active_tab_id = runtime.activeTabId;
    // A single-op sub-pipeline dispatched by the actuator SDK carries the
    // outer pipeline's options on ctx.__pipeline_options; honour its
    // keep_alive/lease so leased sessions survive between outer steps.
    const outerOptions =
      ctx.__pipeline_options && typeof ctx.__pipeline_options === 'object'
        ? (ctx.__pipeline_options as {
            keep_alive?: unknown;
            lease_ms?: unknown;
          })
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
      updated_at: nowIso(),
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
      scope_fingerprint: sessionScopeFingerprint,
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
        updated_at: nowIso(),
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
        scope_fingerprint: sessionScopeFingerprint,
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
  } catch (err: unknown) {
    logger.warn(`[BROWSER_PIPELINE] Failed to persist trace: ${errorMessage(err)}`);
  }

  return {
    status: engineResult.status,
    results: engineResult.results,
    context: ctx,
    total_steps: engineResult.total_steps,
    summary: buildBrowserPipelineSummary(ctx),
    ...buildBrowserPipelineSummary(ctx),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function opCapture(
  op: string,
  params: any,
  runtime: BrowserRuntime,
  ctx: any,
  resolve: Function
) {
  const page = browserRuntimeHelpers.getActivePage(runtime);
  const handler = Object.prototype.hasOwnProperty.call(BROWSER_CAPTURE_OP_HANDLERS, op)
    ? BROWSER_CAPTURE_OP_HANDLERS[op]
    : undefined;
  if (!handler) {
    throw new Error(`Unsupported capture operator in Browser-Actuator: ${op}`);
  }
  return handler({
    op,
    params,
    runtime,
    ctx,
    resolve,
    page,
    ...browserOpSupport(),
  });
}

export async function opTransform(op: string, params: any, ctx: any, resolve: Function) {
  const handler = Object.prototype.hasOwnProperty.call(BROWSER_TRANSFORM_OP_HANDLERS, op)
    ? BROWSER_TRANSFORM_OP_HANDLERS[op]
    : undefined;
  if (!handler) {
    throw new Error(`Unsupported transform operator in Browser-Actuator: ${op}`);
  }
  return handler({ op, params, ctx, resolve, ...browserOpSupport() });
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
): Promise<
  Array<{
    selector: string;
    tag: string;
    role: string;
    text: string;
    visible: boolean;
  }>
> {
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
  input: {
    selector: string;
    text: string;
    timeoutMs: number;
    fieldHint?: string;
  }
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
          page.fill(decision.decision, input.text, {
            timeout: input.timeoutMs,
          })
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

export function recordedRefTargetFromParams(
  params: Record<string, unknown>,
  overrides: { requireDomPathMatch?: boolean } = {}
): {
  role?: string;
  name?: string;
  dom_path?: string;
  requireDomPathMatch?: boolean;
} {
  return {
    ...(typeof params.role === 'string' ? { role: params.role } : {}),
    ...(typeof params.name === 'string' ? { name: params.name } : {}),
    ...(typeof params.dom_path === 'string' ? { dom_path: params.dom_path } : {}),
    ...overrides,
  };
}

export function recordedSecretDomPath(params: Record<string, unknown>, selector: string): string {
  return typeof params.dom_path === 'string' && params.dom_path.trim()
    ? params.dom_path.trim()
    : selector;
}

export async function opApply(
  op: string,
  params: any,
  runtime: BrowserRuntime,
  ctx: any,
  resolve: Function
) {
  const page = browserRuntimeHelpers.getActivePage(runtime);
  const handler = Object.prototype.hasOwnProperty.call(BROWSER_APPLY_OP_HANDLERS, op)
    ? BROWSER_APPLY_OP_HANDLERS[op]
    : undefined;
  if (!handler) {
    throw new Error(`Unsupported apply operator in Browser-Actuator: ${op}`);
  }
  return handler({
    op,
    params,
    runtime,
    ctx,
    resolve,
    page,
    ...browserOpSupport(),
  });
}

export { buildRetryOptions };

/** Helpers injected into the op handler maps (see BrowserOpSupport). */
function browserOpSupport(): BrowserOpSupport {
  return {
    buildRetryOptions,
    distillDomInventory,
    fillWithFallback,
    opApply,
    recordedRefTargetFromParams,
    recordedSecretDomPath,
    resolveBrowserRepositoryPath,
  };
}

export {
  BROWSER_APPLY_OP_HANDLERS,
  BROWSER_CAPTURE_OP_HANDLERS,
  BROWSER_TRANSFORM_OP_HANDLERS,
} from './browser-pipeline-op-handlers.js';
