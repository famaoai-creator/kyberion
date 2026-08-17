import { loadReasoningRoutePolicy, type ReasoningRoutePolicy } from './reasoning-route-resolver.js';

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
