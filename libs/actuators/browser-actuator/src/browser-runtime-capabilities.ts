/**
 * Preflight a browser pipeline against the selected
 * browser-automation-runtime provider's capabilities so unsupported ops fail
 * before a browser is launched instead of mid-run.
 */

import type { BrowserAutomationRuntimeCapabilities } from '@agent/core/browser-automation-runtime-bridge';
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
