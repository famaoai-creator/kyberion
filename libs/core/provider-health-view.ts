import type { ProviderInfo } from './provider-discovery.js';

export type HealthyInstancesResolver = (provider: string, now: number) => readonly string[];

// Agent-provider resolution can be used as a leaf module in tests and small
// tools without importing the persistence registry. The bootstrap view is
// therefore conservative: no provider is demoted until the real registry
// installs its resolver.
let resolveHealthyInstances: HealthyInstancesResolver = () => ['default'];

export function registerHealthyInstancesResolver(resolver: HealthyInstancesResolver): void {
  resolveHealthyInstances = resolver;
}

/** Providers whose every configured instance is currently demoted. */
export function listDemotedProviders(
  providers: ProviderInfo[] = [],
  now: number = Date.now()
): string[] {
  return providers
    .filter((entry) => entry.installed)
    .filter((entry) => resolveHealthyInstances(entry.provider, now).length === 0)
    .map((entry) => entry.provider);
}
