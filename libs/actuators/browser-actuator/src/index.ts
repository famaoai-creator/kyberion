import {
  logger,
  safeReadFile,
  safeWriteFile,
  safeMkdir,
  safeExec,
  safeExistsSync,
  safeReaddir,
  safeRmSync,
  derivePipelineStatus,
  emitComputerSurfacePatch,
  TraceContext,
  persistTrace,
  pathResolver,
  resolveVars,
  evaluateCondition,
  getPathValue,
  buildGovernedRetryOptions,
  classifyError,
  buildBrowserExtensionPipelineCandidate,
  preflightBrowserExtensionSession,
} from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { browserRuntimeHelpers } from './browser-runtime-helpers.js';
import {
  buildBrowserElementPresentPipeline,
  createBrowserInteractionHelpers,
} from './browser-interaction-helpers.js';
import { executePipeline as executeBrowserPipeline } from './browser-pipeline-helpers.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, Browser, BrowserContext, CDPSession, Page } from '@playwright/test';
import { runActuatorCli } from '@agent/core';

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
    action_trail_max?: number;
    navigation_policy?: {
      allowed_origins?: string[];
      allow_private_network?: boolean;
      allow_data_url?: boolean;
    };
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
      | 'click_if_present'
      | 'capture_console'
      | 'capture_network';
    coordinate?: { x: number; y: number };
    to_coordinate?: { x: number; y: number };
    button?: 'left' | 'right' | 'middle';
    text?: string;
    selector?: string;
    exact?: boolean;
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
  focused?: boolean;
  value_redacted?: boolean;
  selector: string;
}

interface BrowserSnapshot {
  session_id: string;
  tab_id: string;
  url: string;
  title: string;
  captured_at: string;
  element_count: number;
  viewport?: { width: number; height: number; scale: number };
  focused_ref?: string | null;
  ready_state?: string;
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

interface ChromeCdpEndpoint {
  cdpUrl: string;
  cdpPort: number;
  source: 'process' | 'probe';
}

interface BrowserRuntime {
  context: BrowserContext;
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
const PASSKEY_PROVIDER_CATALOG_PATH = pathResolver.knowledge(
  'product/orchestration/browser-passkey-providers.json'
);
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
const browserInteractionHelpers = createBrowserInteractionHelpers({
  executePipeline: (...args) => executeBrowserPipeline(...args),
  emitComputerSurfacePatch,
});

function buildRetryOptions(stepParams: Record<string, any>) {
  const explicitRetry =
    stepParams && typeof stepParams.retry === 'object' && !Array.isArray(stepParams.retry)
      ? { ...(stepParams.retry as Record<string, any>) }
      : {};
  if (stepParams?.max_retries !== undefined)
    explicitRetry.maxRetries = Number(stepParams.max_retries);
  if (stepParams?.retry_delay_ms !== undefined)
    explicitRetry.initialDelayMs = Number(stepParams.retry_delay_ms);
  return buildGovernedRetryOptions({
    manifestPath: BROWSER_MANIFEST_PATH,
    defaults: DEFAULT_BROWSER_RETRY,
    override: explicitRetry,
    fallbackCategories: ['network', 'timeout', 'resource_unavailable'],
    additionalShouldRetry: (error) =>
      /selector|not visible|strict mode violation|detached/i.test(error.message),
  });
}

/**
 * Main Entry Point
 */
async function handleAction(input: BrowserAction) {
  if ((input as any).kind === 'computer_interaction') {
    return await browserInteractionHelpers.handleComputerInteraction(input as any);
  }
  if (input.action !== 'pipeline') {
    throw new Error(
      `Unsupported action: ${(input as any).action}. Browser-Actuator accepts pipeline and computer_interaction contracts.`
    );
  }
  if (input.steps?.length === 1 && input.steps[0]?.op === 'extension_session') {
    return handleExtensionSessionPreflight(input.steps[0].params || {}, input.context || {});
  }
  return await executeBrowserPipeline(
    input.steps || [],
    input.session_id || 'default',
    input.options || {},
    input.context || {}
  );
}

function handleExtensionSessionPreflight(
  params: Record<string, unknown>,
  context: Record<string, unknown>
) {
  const preflight = preflightBrowserExtensionSession({
    recording: params.recording,
    session: params.session,
  });
  if (preflight.status === 'blocked') {
    throw new Error(`[BROWSER_EXTENSION_BLOCKED] ${preflight.errors.join('; ')}`);
  }
  const candidate = buildBrowserExtensionPipelineCandidate(params.recording as any);
  return {
    status: 'success',
    results: [{ op: 'extension_session', status: preflight.status }],
    context: {
      ...context,
      browser_extension_session: preflight,
      browser_extension_pipeline_candidate: candidate,
    },
    total_steps: 1,
  };
}

function resolveRefSelector(ctx: any, ref: string): string {
  return browserRuntimeHelpers.resolveRefSelector(ctx, ref);
}

function renderPlaywrightSkeleton(
  trail: any[],
  options: { assertions?: 'hint' | 'strict' } = {}
): string {
  return browserRuntimeHelpers.renderPlaywrightSkeleton(trail as any, options);
}

function renderBrowserAdf(trail: any[], sessionId: string): BrowserAction {
  return browserRuntimeHelpers.renderBrowserAdf(trail as any, sessionId);
}

function discoverChromeCdpEndpoint(): Promise<{ cdpUrl: string; cdpPort: number } | null> {
  return browserRuntimeHelpers.discoverChromeCdpEndpoint();
}

function resetBrowserRuntimeLeasesForTest(): Promise<void> {
  return browserRuntimeHelpers.resetBrowserRuntimeLeasesForTest();
}

function closeBrowserSession(sessionId: string): Promise<boolean> {
  return browserRuntimeHelpers.closeBrowserSession(sessionId);
}

function restartBrowserSession(sessionId: string): Promise<boolean> {
  return browserRuntimeHelpers.restartBrowserSession(sessionId);
}

function waitForOperatorContinue(options: {
  sessionId: string;
  message: string;
  continueFile?: string;
  pollMs: number;
  timeoutMs?: number;
}): Promise<void> {
  return browserRuntimeHelpers.waitForOperatorContinue(options);
}

async function buildSnapshot(
  page: Page,
  options: { sessionId: string; tabId: string; maxElements: number }
): Promise<any> {
  return browserRuntimeHelpers.buildSnapshot(page, options);
}

/**
 * CLI Runner
 */
const main = async () => {
  await runActuatorCli({
    name: 'browser-actuator',
    handleAction,
  });
};

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (entrypoint && modulePath === entrypoint) {
  main().catch((err) => {
    logger.error(err.message);
    process.exit(1);
  });
}

export {
  handleAction,
  buildBrowserElementPresentPipeline,
  buildSnapshot,
  resolveRefSelector,
  renderPlaywrightSkeleton,
  renderBrowserAdf,
  discoverChromeCdpEndpoint,
  resetBrowserRuntimeLeasesForTest,
  closeBrowserSession,
  restartBrowserSession,
  waitForOperatorContinue,
};

export type {
  BrowserElementPresentCondition,
  PipelineStep as BrowserPipelineStep,
} from './browser-interaction-helpers.js';

export { describeOps } from './op-catalog.js';
