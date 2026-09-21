/**
 * Preflight a browser pipeline against the selected
 * browser-automation-runtime provider's capabilities so unsupported ops fail
 * before a browser is launched instead of mid-run.
 */

import {
  getBrowserAutomationRuntimeCapabilities,
  listBrowserAutomationRuntimeBridges,
  resolveBrowserAutomationRuntime,
  type BrowserAutomationRuntimeCapabilities,
} from '@agent/core/browser-automation-runtime-bridge';
import { logger } from '@agent/core/core';
import { resolveSeamProviderDecision } from '@agent/core/seam-provider-selection';
import { matchSeamSelectionRule } from '@agent/core/seam-selection-rules';
import { isRecord } from '@agent/core/foundation';

type Capability = keyof BrowserAutomationRuntimeCapabilities;

const OPS_REQUIRING_CAPABILITY: Readonly<Record<string, Capability>> = {
  open_tab: 'multi_tab',
  select_tab: 'multi_tab',
  select_tab_matching: 'multi_tab',
  screenshot: 'pixel_screenshots',
  setup_passkey_authenticator: 'webauthn',
  remove_passkey_authenticator: 'webauthn',
  register_passkey: 'webauthn',
  authenticate_passkey: 'webauthn',
  delete_passkey: 'webauthn',
  clear_passkey_credentials: 'webauthn',
  set_passkey_presence: 'webauthn',
  set_passkey_user_verified: 'webauthn',
  passkey_credentials: 'webauthn',
  passkey_events: 'webauthn',
  list_profiles: 'persistent_profile',
  extension_session: 'attach_existing_browser',
};

export interface BrowserRuntimePreflightIssue {
  op?: string;
  option?: string;
  capability: Capability;
}

export interface BrowserRuntimePreflightResult {
  /** Explicit requests the provider cannot honour — the pipeline must not run. */
  blocking: BrowserRuntimePreflightIssue[];
  /** Host-default options the provider drops (e.g. record_video); run continues. */
  degraded: BrowserRuntimePreflightIssue[];
}

function collectOps(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectOps(entry, out);
    return;
  }
  if (!isRecord(value)) return;
  if (typeof value.op === 'string') out.add(value.op.replace(/^browser:/, ''));
  for (const nested of Object.values(value)) {
    if (typeof nested === 'object' && nested !== null) collectOps(nested, out);
  }
}

export function preflightBrowserRuntimePipeline(
  steps: unknown,
  options: Record<string, unknown> | undefined,
  capabilities: Readonly<BrowserAutomationRuntimeCapabilities>
): BrowserRuntimePreflightResult {
  const blocking: BrowserRuntimePreflightIssue[] = [];
  const degraded: BrowserRuntimePreflightIssue[] = [];

  const ops = new Set<string>();
  collectOps(steps, ops);
  for (const op of [...ops].sort()) {
    const capability = OPS_REQUIRING_CAPABILITY[op];
    if (capability && !capabilities[capability]) blocking.push({ op, capability });
  }

  const opts = options ?? {};
  if (!capabilities.attach_existing_browser) {
    for (const option of ['connect_over_cdp', 'cdp_url', 'cdp_port']) {
      if (opts[option]) blocking.push({ option, capability: 'attach_existing_browser' });
    }
  }
  if (!capabilities.persistent_profile) {
    if (opts.browser_channel === 'chrome') {
      blocking.push({ option: 'browser_channel', capability: 'persistent_profile' });
    }
    if (opts.profile_directory) {
      blocking.push({ option: 'profile_directory', capability: 'persistent_profile' });
    }
  }
  if (!capabilities.video_recording && opts.record_video) {
    degraded.push({ option: 'record_video', capability: 'video_recording' });
  }
  return { blocking, degraded };
}

export function formatBrowserRuntimePreflightError(
  runtimeId: string,
  issues: BrowserRuntimePreflightIssue[]
): string {
  const parts = issues.map((issue) =>
    issue.op
      ? `op '${issue.op}' (${issue.capability})`
      : `option '${issue.option}' (${issue.capability})`
  );
  return (
    `[BROWSER_RUNTIME_UNSUPPORTED] browser_runtime '${runtimeId}' cannot run this pipeline: ` +
    `${parts.join(', ')}. Use the default Chromium runtime for these steps.`
  );
}

/**
 * Namespace a session id for a non-default runtime: `lightpanda--checkout`.
 * The default runtime keeps bare ids (existing sessions stay addressable) and
 * an already-scoped id is returned unchanged, so callers may echo back the
 * `session_id` a previous run reported.
 */
export function scopeBrowserSessionId(
  sessionId: string,
  runtimeId: string,
  defaultRuntimeId: string
): string {
  const base = String(sessionId || 'default');
  if (runtimeId === defaultRuntimeId) return base;
  const prefix = `${runtimeId}--`;
  return base.startsWith(prefix) ? base : `${prefix}${base}`;
}

/**
 * Reject pipelines the selected browser runtime cannot run before anything is
 * launched; host-default extras it cannot provide (video) are dropped.
 * Non-default runtimes get their own session namespace
 * (`<runtime>--<session_id>`) so leases, profiles, metadata and evidence never
 * collide with a Chromium session of the same name.
 */
export function preflightAutomationRuntime(
  steps: unknown,
  sessionId: string,
  requestedOptions: Record<string, any>
): { sessionId: string; options: Record<string, any> } {
  const selected = selectBrowserAutomationRuntime(steps, requestedOptions);
  const options = selected ? { ...requestedOptions, browser_runtime: selected } : requestedOptions;
  const runtime = resolveBrowserAutomationRuntime(options.browser_runtime);
  const scopedSessionId = scopeBrowserSessionId(
    sessionId,
    runtime.bridge_id,
    resolveBrowserAutomationRuntime().bridge_id
  );
  const { blocking, degraded } = preflightBrowserRuntimePipeline(
    steps,
    options,
    getBrowserAutomationRuntimeCapabilities(runtime)
  );
  if (blocking.length > 0) {
    throw new Error(formatBrowserRuntimePreflightError(runtime.bridge_id, blocking));
  }
  if (degraded.length === 0) return { sessionId: scopedSessionId, options };
  const adjusted = { ...options };
  for (const issue of degraded) {
    if (!issue.option) continue;
    logger.warn(
      `[BROWSER] browser_runtime '${runtime.bridge_id}' lacks ${issue.capability}; ignoring option '${issue.option}'.`
    );
    adjusted[issue.option] = false;
  }
  return { sessionId: scopedSessionId, options: adjusted };
}

const BROWSER_RUNTIME_SEAM = 'browser-automation-runtime';

/**
 * Purpose-driven runtime choice: only when the caller named no runtime (or
 * `auto`) and either stated `runtime_purpose` or an operator rule matches
 * (so a rule can still apply to an otherwise-default choice). Every registered runtime is filtered by what this pipeline needs,
 * the rest are ranked by the governed selection policy, and the decision is
 * audited and pinned per mission. The chosen id is written back as
 * `browser_runtime`, so nested calls do not re-select.
 */
export function selectBrowserAutomationRuntime(
  steps: unknown,
  options: Record<string, any>
): string | undefined {
  const explicit = String(options.browser_runtime ?? '').trim();
  if (explicit && explicit !== 'auto') return undefined;
  const purpose = String(options.runtime_purpose ?? '').trim();
  if (!purpose && !matchSeamSelectionRule(BROWSER_RUNTIME_SEAM, {})) return undefined;
  const candidates = listBrowserAutomationRuntimeBridges().map((bridge) => {
    const { blocking } = preflightBrowserRuntimePipeline(
      steps,
      options,
      getBrowserAutomationRuntimeCapabilities(bridge)
    );
    return {
      id: bridge.bridge_id,
      eligible: blocking.length === 0,
      unmet: blocking.map((issue) => `${issue.op ?? issue.option} (${issue.capability})`),
    };
  });
  const decision = resolveSeamProviderDecision({
    seam: BROWSER_RUNTIME_SEAM,
    candidates,
    ...(purpose ? { purpose } : {}),
    decisionKey: purpose || 'default',
  });
  if (!decision.provider_id) {
    throw new Error(`[BROWSER_RUNTIME_SELECTION] ${decision.rationale}`);
  }
  logger.info(
    `🧭 [BROWSER] runtime '${decision.provider_id}' selected (${decision.strategy}): ${decision.rationale}`
  );
  return decision.provider_id;
}
