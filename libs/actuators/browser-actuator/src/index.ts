import { emitComputerSurfacePatch } from '@agent/core/computer-surface';
import {
  buildBrowserExtensionPipelineCandidate,
  preflightBrowserExtensionSession,
} from '@agent/core/browser-extension-bridge';
import { ensureDefaultOpPreflight } from '@agent/core/op-preflight-defaults';
import { runOpPreflight } from '@agent/core/op-preflight';
import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import { browserRuntimeHelpers } from './browser-runtime-helpers.js';
import {
  buildBrowserElementPresentPipeline,
  createBrowserInteractionHelpers,
} from './browser-interaction-helpers.js';
import { executePipeline as executeBrowserPipeline } from './browser-pipeline-helpers.js';
import { isDirectEntry } from '@agent/core/direct-entry';
import { Page } from '@playwright/test';
import {
  currentProcessArgv,
  runActuatorCli,
  runActuatorCliEntryPoint,
} from '@agent/core/cli-utils';
import { describeOps } from './op-catalog.js';

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

const browserInteractionHelpers = createBrowserInteractionHelpers({
  executePipeline: (...args) => executeBrowserPipeline(...args),
  emitComputerSurfacePatch,
});

/**
 * Main Entry Point
 */
async function handleAction(input: BrowserAction) {
  if ((input as any).kind === 'computer_interaction') {
    ensureDefaultOpPreflight();
    const interactionType = String((input as any).action?.type || 'unknown');
    const preflight = await runOpPreflight({
      op: `browser:computer_interaction:${interactionType}`,
      params: input as unknown as Record<string, unknown>,
      source: 'actuator',
    });
    if (preflight.decision !== 'allow') {
      throw new Error(
        `[OP_PREFLIGHT_${preflight.decision.toUpperCase()}] ${preflight.reason || `Operation browser:computer_interaction:${interactionType} was not admitted.`}`
      );
    }
    const admitted = {
      ...(input as unknown as Record<string, unknown>),
      ...preflight.input,
      kind: 'computer_interaction',
    };
    return await browserInteractionHelpers.handleComputerInteraction(admitted as any);
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

export const actuator = defineCatalogBackedActuator({
  id: 'browser-actuator',
  describeOps,
  handleAction,
});

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
    args: currentProcessArgv(),
    handleAction,
  });
};

if (isDirectEntry(import.meta.url, 'libs/actuators/browser-actuator/src/index.ts')) {
  void runActuatorCliEntryPoint(main, 'browser-actuator');
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

export { describeOps };
