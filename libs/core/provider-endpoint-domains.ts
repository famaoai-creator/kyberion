/**
 * Hosts each provider sends payloads to, read from its declaration in
 * `provider-egress-policy.json`.
 *
 * A leaf on purpose: the network gate (egress-policy.ts) sits under
 * secure-io and fetch, and the provider gate (provider-egress-gate.ts)
 * reaches tenants, authority and ops alerts. Resolving a provider's hosts
 * needs none of that, so it lives here rather than joining the two graphs.
 */
import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { getRegisteredEnvText } from './foundation/env.js';

interface ProviderEndpointCatalog {
  providers: Record<string, { endpoint_domains?: string[] }>;
}

const catalog = defineCatalog<ProviderEndpointCatalog>({
  id: 'provider-egress-policy.endpoints',
  path: () =>
    getRegisteredEnvText('KYBERION_PROVIDER_EGRESS_POLICY_PATH')?.trim() ||
    pathResolver.knowledge('product/governance/provider-egress-policy.json'),
  schema: pathResolver.knowledge('product/schemas/provider-egress-policy.schema.json'),
});

/**
 * An unknown provider, or a policy that cannot be read, resolves to no
 * hosts — which the network gate treats as nothing approved.
 */
export function providerEndpointDomains(provider: string): string[] {
  let loaded: ProviderEndpointCatalog;
  try {
    loaded = catalog.load();
  } catch {
    return [];
  }
  const declaration = loaded.providers?.[String(provider || '').trim()];
  return Array.isArray(declaration?.endpoint_domains) ? [...declaration.endpoint_domains] : [];
}

/** Test-only. */
export function _resetProviderEndpointDomainsForTests(): void {
  catalog.reset();
}
