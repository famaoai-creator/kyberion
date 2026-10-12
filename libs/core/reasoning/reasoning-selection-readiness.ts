import { getRegisteredEnvText } from '../foundation/env.js';
import { peekProviderDiscovery } from '../provider/provider-discovery.js';
import { peekProviderCapabilityRegistry } from '../provider/provider-capability-registry.js';
import type { ReasoningRoutePolicy } from './reasoning-route-resolver.js';

export interface ReasoningSelectionReadiness {
  available: boolean;
  reason: string;
}

/** Read-only evidence: never refresh discovery, spawn a CLI, or call a provider. */
export function peekReasoningSelectionReadiness(
  policy: ReasoningRoutePolicy,
  env: NodeJS.ProcessEnv = process.env
): Record<string, ReasoningSelectionReadiness> {
  const discovery = peekProviderDiscovery();
  const capabilities = peekProviderCapabilityRegistry() || [];
  return Object.fromEntries(
    Object.entries(policy.runtime_adapters).map(([mode, adapter]) => {
      const selection = adapter.selection;
      const availability = selection?.availability;
      let result: ReasoningSelectionReadiness;
      if (availability?.kind === 'always') {
        result = { available: true, reason: 'Runtime declares unconditional availability' };
      } else if (availability?.kind === 'env_any') {
        const present =
          availability.names?.some((name) =>
            Boolean(getRegisteredEnvText(name, { env })?.trim())
          ) ?? false;
        result = {
          available: present,
          reason: present
            ? 'Configuration present; connectivity and credentials have not been probed'
            : 'Required configuration is absent from the read-only environment snapshot',
        };
      } else if (availability?.kind === 'provider_discovery') {
        const provider = selection?.discovery_provider;
        const found = discovery.providers.find((entry) => entry.provider === provider);
        const cached = capabilities.find((entry) => entry.provider_id === provider);
        const denied = cached && (!cached.binary_found || cached.authenticated === false);
        result = {
          available: Boolean(found?.installed && found.healthy && !denied),
          reason: denied
            ? 'Cached provider capability evidence reports unavailable or unauthenticated'
            : found?.installed && found.healthy
              ? 'Cached provider discovery reports healthy; no live probe performed'
              : 'No fresh healthy provider discovery evidence; run explicit provider discovery',
        };
      } else {
        result = {
          available: false,
          reason: 'Runtime has no governed cached-readiness declaration',
        };
      }
      return [mode, result];
    })
  );
}
