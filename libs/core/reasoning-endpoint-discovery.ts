import {
  loadReasoningRoutePolicy,
  type ReasoningRoutePolicy,
  type RuntimeAdapterConfig,
} from './reasoning-route-resolver.js';

/**
 * Discovery for reasoning runtimes that are configured through an API
 * endpoint or environment variable rather than an installed CLI.
 *
 * Runtime metadata is read from reasoning-route-policy.json. This intentionally
 * does not return ProviderInfo: ProviderInfo is the CLI-agent contract consumed
 * by agent-provider resolution and capability scanning.
 */

export type ReasoningEndpointPolicy = 'local' | 'public';

export interface ReasoningEndpointInfo {
  runtime: string;
  display_name: string;
  adapter: string;
  endpoint_policy: ReasoningEndpointPolicy;
  configuration_env: string[];
  configured: boolean;
  status: 'configured' | 'not_configured';
}

function endpointPolicyFor(adapter: RuntimeAdapterConfig): ReasoningEndpointPolicy {
  return adapter.endpoint_policy ?? 'public';
}

/**
 * Discover endpoint-backed reasoning runtimes without exposing secret values.
 * This is configuration discovery; reachability is checked by the reasoning
 * route doctor before a runtime is reported as ready.
 */
export function discoverReasoningEndpoints(
  env: NodeJS.ProcessEnv = process.env,
  policy: Pick<ReasoningRoutePolicy, 'runtime_adapters'> = loadReasoningRoutePolicy()
): ReasoningEndpointInfo[] {
  return Object.entries(policy.runtime_adapters)
    .filter(([, adapter]) => adapter.selection?.availability.kind === 'env_any')
    .map(([runtime, adapter]) => {
      const selection = adapter.selection!;
      const configurationEnv = selection.availability.names ?? [];
      const configured = configurationEnv.some((name) => Boolean(env[name]?.trim()));
      return {
        runtime,
        display_name: selection.display_name,
        adapter: adapter.adapter,
        endpoint_policy: endpointPolicyFor(adapter),
        configuration_env: [...configurationEnv],
        configured,
        status: configured ? 'configured' : 'not_configured',
      };
    });
}
