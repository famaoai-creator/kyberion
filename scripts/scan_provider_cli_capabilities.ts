import { loadCapabilityRegistry, probeProviderAvailability, scanProviderCapabilities } from '@agent/core';

type ScanSummary = {
  registered_capabilities: number;
  available_capabilities: number;
  available_providers: string[];
  missing_providers: string[];
  capabilities: Array<{
    capability_id: string;
    provider: string;
    status: string;
    discovery_status: string;
    evidence?: string;
  }>;
};

function main(): void {
  const registry = loadCapabilityRegistry();
  const providerAvailability = probeProviderAvailability();
  const discovered = scanProviderCapabilities(registry);
  const availableProviders = [...providerAvailability.entries()]
    .filter(([, result]) => result.ok)
    .map(([provider]) => provider)
    .sort();
  const missingProviders = [...providerAvailability.entries()]
    .filter(([, result]) => !result.ok)
    .map(([provider]) => provider)
    .sort();

  const summary: ScanSummary = {
    registered_capabilities: registry.capabilities.length,
    available_capabilities: discovered.length,
    available_providers: availableProviders,
    missing_providers: missingProviders,
    capabilities: discovered
      .map((capability) => ({
        capability_id: capability.capability_id,
        provider: capability.source.provider,
        status: capability.status,
        discovery_status: capability.discovery_status,
        evidence: capability.evidence,
      }))
      .sort((a, b) => a.capability_id.localeCompare(b.capability_id)),
  };

  console.log(JSON.stringify(summary, null, 2));
}

main();
