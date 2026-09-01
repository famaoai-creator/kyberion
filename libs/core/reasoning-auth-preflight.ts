import { loadReasoningRoutePolicy, type ReasoningRoutePolicy } from './reasoning-route-resolver.js';
import { probeExplicitReasoningBackend } from './environment-capability-probes.js';

export type ReasoningAuthPreflightStatus =
  'configured' | 'missing' | 'cli-managed' | 'not-required';

export interface ReasoningAuthPreflightResult {
  mode: string;
  status: ReasoningAuthPreflightStatus;
  configured: boolean;
  credential_source: 'environment' | 'cli' | 'none';
  required_environment: string[];
  missing_environment: string[];
  note: string;
}

export interface ReasoningAuthProbe {
  status: 'verified' | 'failed' | 'not_required';
  checked_at: string;
  note: string;
}

export interface ReasoningAuthProbeResult extends ReasoningAuthPreflightResult {
  probe: ReasoningAuthProbe;
}

/** Check credential configuration shape without reading or refreshing secrets. */
export function checkReasoningBackendAuth(
  mode: string,
  env: NodeJS.ProcessEnv = process.env,
  policy: Pick<ReasoningRoutePolicy, 'runtime_adapters'> = loadReasoningRoutePolicy()
): ReasoningAuthPreflightResult {
  const adapter = policy.runtime_adapters[mode];
  if (!adapter) {
    return {
      mode,
      status: 'missing',
      configured: false,
      credential_source: 'none',
      required_environment: [],
      missing_environment: [],
      note: 'mode is not registered in the reasoning route policy',
    };
  }

  const availability = adapter.selection?.availability;
  if (!availability || availability.kind === 'always') {
    return {
      mode,
      status: 'not-required',
      configured: true,
      credential_source: 'none',
      required_environment: [],
      missing_environment: [],
      note: 'the selected runtime declares no external credential requirement',
    };
  }

  const requiredEnvironment = availability.names ? [...availability.names] : [];
  if (availability.kind === 'provider_discovery') {
    return {
      mode,
      status: 'cli-managed',
      configured: true,
      credential_source: 'cli',
      required_environment: requiredEnvironment,
      missing_environment: [],
      note: 'authentication is managed by the provider CLI; credential values were not inspected',
    };
  }

  const missingEnvironment = requiredEnvironment.filter((name) => !env[name]?.trim());
  const configured = missingEnvironment.length < requiredEnvironment.length;
  return {
    mode,
    status: configured ? 'configured' : 'missing',
    configured,
    credential_source: 'environment',
    required_environment: requiredEnvironment,
    missing_environment: missingEnvironment,
    note: configured
      ? 'at least one declared environment credential is configured; validity was not probed'
      : 'configure at least one declared environment credential before using this runtime',
  };
}

export function checkAllReasoningBackendAuth(
  env: NodeJS.ProcessEnv = process.env,
  policy: Pick<ReasoningRoutePolicy, 'runtime_adapters'> = loadReasoningRoutePolicy()
): ReasoningAuthPreflightResult[] {
  return Object.keys(policy.runtime_adapters).map((mode) =>
    checkReasoningBackendAuth(mode, env, policy)
  );
}

/**
 * Verify the configured credential or provider-managed CLI session.
 *
 * This is intentionally separate from `checkReasoningBackendAuth`: the latter
 * is a pure, network-free configuration check, while this function performs a
 * bounded provider probe and never includes credential material in its result.
 */
export async function probeReasoningBackendAuth(
  mode: string,
  env: NodeJS.ProcessEnv = process.env,
  policy: Pick<ReasoningRoutePolicy, 'runtime_adapters'> = loadReasoningRoutePolicy(),
  deps: {
    probe?: (
      mode: string,
      env: NodeJS.ProcessEnv
    ) => Promise<{ available: boolean; reason?: string }>;
  } = {}
): Promise<ReasoningAuthProbeResult> {
  const base = checkReasoningBackendAuth(mode, env, policy);
  const checkedAt = new Date().toISOString();
  if (base.status === 'not-required') {
    return {
      ...base,
      probe: { status: 'not_required', checked_at: checkedAt, note: base.note },
    };
  }
  if (base.status === 'missing') {
    return {
      ...base,
      probe: { status: 'failed', checked_at: checkedAt, note: base.note },
    };
  }

  try {
    const result = await (
      deps.probe ||
      ((selectedMode, selectedEnv) => probeExplicitReasoningBackend(selectedMode, selectedEnv))
    )(mode, env);
    return {
      ...base,
      probe: {
        status: result.available ? 'verified' : 'failed',
        checked_at: checkedAt,
        note: result.available
          ? 'provider credential or managed CLI session verified without a model completion'
          : result.reason || 'provider probe failed',
      },
    };
  } catch (error) {
    return {
      ...base,
      probe: {
        status: 'failed',
        checked_at: checkedAt,
        note: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function probeAllReasoningBackendAuth(
  env: NodeJS.ProcessEnv = process.env,
  policy: Pick<ReasoningRoutePolicy, 'runtime_adapters'> = loadReasoningRoutePolicy(),
  deps: {
    probe?: (
      mode: string,
      env: NodeJS.ProcessEnv
    ) => Promise<{ available: boolean; reason?: string }>;
  } = {}
): Promise<ReasoningAuthProbeResult[]> {
  return Promise.all(
    Object.keys(policy.runtime_adapters).map((mode) =>
      probeReasoningBackendAuth(mode, env, policy, deps)
    )
  );
}
