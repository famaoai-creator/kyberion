import type { CapabilityRegistry, DiscoveredCapability, ProbeResult } from './provider-capability-scanner.js';
import type { ProviderInfo } from './provider-discovery.js';

export type ProviderCapabilitySnapshotProvider = Pick<ProviderInfo, 'provider' | 'installed' | 'version' | 'protocol' | 'healthy'>;

export type ProviderCapabilitySnapshotCapability = {
  capability_id: string;
  provider: string;
  status: string;
  discovery_status: string;
  evidence?: string;
};

export type ProviderCapabilitySnapshot = {
  generated_at: string;
  registered_capabilities: number;
  available_capabilities: number;
  available_providers: string[];
  missing_providers: string[];
  providers: ProviderCapabilitySnapshotProvider[];
  capabilities: ProviderCapabilitySnapshotCapability[];
};

export function buildProviderCapabilitySnapshot(params: {
  registry: CapabilityRegistry;
  discovered: DiscoveredCapability[];
  providerAvailability: Map<string, ProbeResult>;
  providers: ProviderInfo[];
  generatedAt?: string;
}): ProviderCapabilitySnapshot {
  const availableProviders = [...params.providerAvailability.entries()]
    .filter(([, result]) => result.ok)
    .map(([provider]) => provider)
    .sort();
  const missingProviders = [...params.providerAvailability.entries()]
    .filter(([, result]) => !result.ok)
    .map(([provider]) => provider)
    .sort();

  return {
    generated_at: params.generatedAt ?? new Date().toISOString(),
    registered_capabilities: params.registry.capabilities.length,
    available_capabilities: params.discovered.length,
    available_providers: availableProviders,
    missing_providers: missingProviders,
    providers: [...params.providers]
      .map((provider) => ({
        provider: provider.provider,
        installed: provider.installed,
        version: provider.version,
        protocol: provider.protocol,
        healthy: provider.healthy,
      }))
      .sort((a, b) => a.provider.localeCompare(b.provider)),
    capabilities: [...params.discovered]
      .map((capability) => ({
        capability_id: capability.capability_id,
        provider: capability.source.provider,
        status: capability.status,
        discovery_status: capability.discovery_status,
        evidence: capability.evidence,
      }))
      .sort((a, b) => a.capability_id.localeCompare(b.capability_id)),
  };
}
