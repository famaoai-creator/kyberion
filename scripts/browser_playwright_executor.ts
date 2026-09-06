/**
 * Host-boundary Playwright executor for browser procedures.
 *
 * `libs/core` must never statically import `libs/actuators/*`. This module is
 * the script/host seam that dynamically loads `@agent/browser-actuator`
 * `handleAction` from `dist/` and returns the `executeBrowserPipeline`
 * function `dispatchProcedure` injects for `execution_substrate: 'playwright'`.
 */

import { pathToFileURL } from 'node:url';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync } from '@agent/core/secure-io';

export const BROWSER_ACTUATOR_DIST_RELATIVE = 'dist/libs/actuators/browser-actuator/src/index.js';
export const REQUIRED_NODE_ENGINE = '>=24.0.0';

export interface BrowserActuatorResult {
  status?: string;
  results?: unknown[];
  errors?: string[];
  context?: unknown;
}

export interface BrowserActuatorHandle {
  handleAction: (input: Record<string, unknown>) => Promise<BrowserActuatorResult>;
}

export interface BrowserPipelineRunOptions {
  sessionId?: string;
  headless?: boolean;
  connectOverCdp?: boolean;
  cdpUrl?: string;
  cdpPort?: number;
  recordTrace?: boolean;
  recordVideo?: boolean;
  context?: Record<string, unknown>;
}

export interface ExecuteBrowserPipelineInput {
  steps: Array<{ id: string; type: string; op: string; params: Record<string, unknown> }>;
  sessionId?: string;
  options?: Record<string, unknown>;
}

export interface ExecuteBrowserPipelineResult {
  status: 'succeeded' | 'failed';
  results?: unknown[];
  errors?: string[];
  context?: unknown;
}

export type ExecuteBrowserPipeline = (
  input: ExecuteBrowserPipelineInput
) => Promise<ExecuteBrowserPipelineResult>;

export function resolveBrowserActuatorDistPath(): string {
  return pathResolver.rootResolve(BROWSER_ACTUATOR_DIST_RELATIVE);
}

export function formatBrowserActuatorUnavailableError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return (
    `browser-actuator is unavailable. Need Node ${REQUIRED_NODE_ENGINE} and a built dist/ ` +
    `(run \`pnpm build\` or \`pnpm build:actuators\`): ${detail}`
  );
}

export function assertSupportedNodeEngine(version = process.version, minimumMajor = 24): void {
  const major = Number(/^v(\d+)/.exec(version)?.[1] ?? 0);
  if (!Number.isFinite(major) || major < minimumMajor) {
    throw new Error(
      `Kyberion browser execution requires Node ${REQUIRED_NODE_ENGINE} ` +
        `(this process is ${version}). Upgrade Node, then run \`pnpm build\`.`
    );
  }
}

export async function loadBrowserActuator(
  importer?: (url: string) => Promise<unknown>
): Promise<BrowserActuatorHandle> {
  const actuatorPath = resolveBrowserActuatorDistPath();
  // Custom importers are the test/host seam; only the default loader requires dist/.
  if (!importer && !safeExistsSync(actuatorPath)) {
    throw new Error(
      formatBrowserActuatorUnavailableError(`missing ${BROWSER_ACTUATOR_DIST_RELATIVE}`)
    );
  }
  try {
    const load = importer ?? ((url: string) => import(url));
    const mod = (await load(pathToFileURL(actuatorPath).href)) as {
      handleAction?: BrowserActuatorHandle['handleAction'];
    };
    if (typeof mod.handleAction !== 'function') {
      throw new Error('handleAction export missing from browser-actuator');
    }
    return { handleAction: mod.handleAction };
  } catch (error) {
    if (error instanceof Error && error.message.includes('browser-actuator is unavailable')) {
      throw error;
    }
    throw new Error(formatBrowserActuatorUnavailableError(error));
  }
}

function isSuccessfulStatus(status: string | undefined): boolean {
  return status === 'succeeded' || status === 'success';
}

export function createExecuteBrowserPipeline(
  handleAction: BrowserActuatorHandle['handleAction'],
  defaults: BrowserPipelineRunOptions = {}
): ExecuteBrowserPipeline {
  const connectOverCdp = Boolean(defaults.connectOverCdp || defaults.cdpUrl || defaults.cdpPort);
  return async (input: ExecuteBrowserPipelineInput): Promise<ExecuteBrowserPipelineResult> => {
    const actuatorResult = await handleAction({
      action: 'pipeline',
      steps: input.steps,
      session_id: input.sessionId || defaults.sessionId,
      options: {
        headless: defaults.headless ?? true,
        connect_over_cdp: connectOverCdp,
        record_trace: defaults.recordTrace !== false,
        record_video: defaults.recordVideo !== false,
        ...(defaults.cdpUrl ? { cdp_url: defaults.cdpUrl } : {}),
        ...(defaults.cdpPort ? { cdp_port: defaults.cdpPort } : {}),
        ...(input.options || {}),
      },
      context: defaults.context ?? {},
    });
    return {
      status: isSuccessfulStatus(actuatorResult?.status) ? 'succeeded' : 'failed',
      results: Array.isArray(actuatorResult?.results) ? actuatorResult.results : undefined,
      errors: actuatorResult?.errors,
      context: actuatorResult?.context,
    };
  };
}
