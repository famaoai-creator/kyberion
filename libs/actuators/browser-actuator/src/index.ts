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
  type ComputerInteractionAction,
} from './browser-interaction-helpers.js';
import { executePipeline as executeBrowserPipeline } from './browser-pipeline-helpers.js';
import { isDirectEntry } from '@agent/core/direct-entry';
import { isRecord } from '@agent/core/foundation';
import { Page } from '@playwright/test';
import {
  currentProcessArgv,
  runActuatorCli,
  runActuatorCliEntryPoint,
} from '@agent/core/cli-utils';
import { describeOps } from './op-catalog.js';
import { preflightAutomationRuntime } from './browser-runtime-capabilities.js';

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
    /** browser-automation-runtime provider id (`playwright-chromium` default, `lightpanda`). */
    browser_runtime?: string;
    /** With no explicit browser_runtime: choose one by purpose (see seam-provider-selection-policy). */
    runtime_purpose?: string;
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
function isComputerInteraction(input: unknown): input is ComputerInteractionAction {
  return isRecord(input) && input.kind === 'computer_interaction';
}

function isPipelineAction(input: unknown): input is BrowserAction {
  return isRecord(input) && input.action === 'pipeline';
}

function describeUnsupportedAction(input: unknown): string {
  if (!isRecord(input)) return 'unknown';
  return String(input.action);
}

async function handleAction(input: unknown) {
  if (isComputerInteraction(input)) {
    ensureDefaultOpPreflight();
    const interactionType = String(input.action?.type || 'unknown');
    const preflight = await runOpPreflight({
      op: `browser:computer_interaction:${interactionType}`,
      params: { ...input },
      source: 'actuator',
    });
    if (preflight.decision !== 'allow') {
      throw new Error(
        `[OP_PREFLIGHT_${preflight.decision.toUpperCase()}] ${preflight.reason || `Operation browser:computer_interaction:${interactionType} was not admitted.`}`
      );
    }
    const admitted: ComputerInteractionAction = {
      ...input,
      action: {
        ...input.action,
        ...(preflight.input as ComputerInteractionAction['action']),
      },
      kind: 'computer_interaction',
    };
    return await browserInteractionHelpers.handleComputerInteraction(admitted);
  }
  if (!isPipelineAction(input)) {
    throw new Error(
      `Unsupported action: ${describeUnsupportedAction(input)}. Browser-Actuator accepts pipeline and computer_interaction contracts.`
    );
  }
  if (input.steps?.length === 1 && input.steps[0]?.op === 'extension_session') {
    // This import/preflight path intentionally does not launch a browser, but
    // an explicitly selected runtime still owns the capability contract. In
    // particular, Lightpanda cannot attach to the live extension tab.
    if (input.options?.browser_runtime) {
      preflightAutomationRuntime(input.steps, input.session_id || 'default', input.options);
    }
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
export type { ComputerInteractionAction };

export type {
  BrowserElementPresentCondition,
  PipelineStep as BrowserPipelineStep,
} from './browser-interaction-helpers.js';

export { describeOps };
