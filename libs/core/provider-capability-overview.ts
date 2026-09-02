import type {
  CapabilityRegistry,
  DiscoveredCapability,
  ProbeResult,
} from './provider-capability-scanner.js';
import type { ProviderInfo } from './provider-discovery.js';
import { parseSafeJsonObjectValue } from './foundation/safe-json.js';
import { nowIso } from './foundation/time.js';

export type ProviderCapabilitySnapshotProvider = Pick<
  ProviderInfo,
  'provider' | 'installed' | 'version' | 'protocol' | 'healthy'
>;

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

function assertExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
  const expectedKeys = new Set(expected);
  const unknown = Object.keys(record).filter((key) => !expectedKeys.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unknown field(s): ${unknown.join(', ')}`);
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => nonEmptyString(entry, `${label}[${index}]`));
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function parseSnapshotProvider(value: unknown, index: number): ProviderCapabilitySnapshotProvider {
  const label = `provider capability snapshot.providers[${index}]`;
  const record = parseSafeJsonObjectValue(value, label);
  assertExactKeys(record, ['provider', 'installed', 'version', 'protocol', 'healthy'], label);
  const versionValue = record.version;
  if (versionValue !== null && typeof versionValue !== 'string') {
    throw new Error(`${label}.version must be a string or null`);
  }
  if (typeof record.installed !== 'boolean' || typeof record.healthy !== 'boolean') {
    throw new Error(`${label}.installed and healthy must be booleans`);
  }
  const protocol = nonEmptyString(record.protocol, `${label}.protocol`);
  if (!['acp', 'print-json', 'exec', 'json-rpc'].includes(protocol)) {
    throw new Error(`${label}.protocol is invalid`);
  }
  return {
    provider: nonEmptyString(record.provider, `${label}.provider`),
    installed: record.installed as boolean,
    version: versionValue as string | null,
    protocol: protocol as ProviderCapabilitySnapshotProvider['protocol'],
    healthy: record.healthy as boolean,
  };
}

function parseSnapshotCapability(
  value: unknown,
  index: number
): ProviderCapabilitySnapshotCapability {
  const label = `provider capability snapshot.capabilities[${index}]`;
  const record = parseSafeJsonObjectValue(value, label);
  assertExactKeys(
    record,
    ['capability_id', 'provider', 'status', 'discovery_status', 'evidence'],
    label
  );
  const evidence = record.evidence;
  if (evidence !== undefined && typeof evidence !== 'string') {
    throw new Error(`${label}.evidence must be a string when present`);
  }
  return {
    capability_id: nonEmptyString(record.capability_id, `${label}.capability_id`),
    provider: nonEmptyString(record.provider, `${label}.provider`),
    status: nonEmptyString(record.status, `${label}.status`),
    discovery_status: nonEmptyString(record.discovery_status, `${label}.discovery_status`),
    ...(evidence !== undefined ? { evidence: evidence as string } : {}),
  };
}

/** Parse the persisted provider capability overview before a dashboard renders it. */
export function parseProviderCapabilitySnapshot(value: unknown): ProviderCapabilitySnapshot {
  const root = parseSafeJsonObjectValue(value, 'provider capability snapshot');
  assertExactKeys(
    root,
    [
      'generated_at',
      'registered_capabilities',
      'available_capabilities',
      'available_providers',
      'missing_providers',
      'providers',
      'capabilities',
    ],
    'provider capability snapshot'
  );
  const generatedAt = nonEmptyString(
    root.generated_at,
    'provider capability snapshot.generated_at'
  );
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw new Error('provider capability snapshot.generated_at must be a valid timestamp');
  }
  const providers = root.providers;
  const capabilities = root.capabilities;
  if (!Array.isArray(providers)) {
    throw new Error('provider capability snapshot.providers must be an array');
  }
  if (!Array.isArray(capabilities)) {
    throw new Error('provider capability snapshot.capabilities must be an array');
  }
  return {
    generated_at: generatedAt,
    registered_capabilities: nonNegativeInteger(
      root.registered_capabilities,
      'provider capability snapshot.registered_capabilities'
    ),
    available_capabilities: nonNegativeInteger(
      root.available_capabilities,
      'provider capability snapshot.available_capabilities'
    ),
    available_providers: stringArray(
      root.available_providers,
      'provider capability snapshot.available_providers'
    ),
    missing_providers: stringArray(
      root.missing_providers,
      'provider capability snapshot.missing_providers'
    ),
    providers: providers.map(parseSnapshotProvider),
    capabilities: capabilities.map(parseSnapshotCapability),
  };
}

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
    generated_at: params.generatedAt ?? nowIso(),
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
