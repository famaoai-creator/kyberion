import type { ProviderInfo } from './provider-discovery.js';
import { coreSeamCatalog, createSeam, type SeamProviderMetadata } from './seam.js';

export type HealthyInstancesResolver = (provider: string, now: number) => readonly string[];

const healthyInstancesResolverSeam = createSeam<HealthyInstancesResolver>({
  key: 'provider-health-resolver',
  multiplicity: 'sole',
  catalog: coreSeamCatalog,
});

const DEFAULT_METADATA: SeamProviderMetadata = {
  provenance: 'builtin',
  source: 'libs/core/provider-health-view.ts',
  reason: 'provider health registry registration',
};

export function registerHealthyInstancesResolver(
  resolver: HealthyInstancesResolver,
  metadata: SeamProviderMetadata = DEFAULT_METADATA
): () => void {
  return healthyInstancesResolverSeam.register('provider-health-registry', resolver, metadata);
}

/** Providers whose every configured instance is currently demoted. */
export function listDemotedProviders(
  providers: ProviderInfo[] = [],
  now: number = Date.now()
): string[] {
  // A leaf import remains conservative until the real provider health registry
  // installs its resolver.
  const resolveHealthyInstances =
    healthyInstancesResolverSeam.getOptional() ?? (() => ['default'] as readonly string[]);
  return providers
    .filter((entry) => entry.installed)
    .filter((entry) => resolveHealthyInstances(entry.provider, now).length === 0)
    .map((entry) => entry.provider);
}
