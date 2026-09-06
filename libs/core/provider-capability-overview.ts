import type {
  CapabilityRegistry,
  DiscoveredCapability,
  ProbeResult,
} from './provider-capability-scanner.js';
import type { ProviderCapability } from './provider-capability-registry.js';
import type { ProviderInfo } from './provider-discovery.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { parseSafeJsonObjectValue } from './foundation/safe-json.js';
import { nowIso } from './foundation/time.js';
import { pathResolver } from './path-resolver.js';

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

export type ProviderCapabilityRuntimeProbe = {
  provider_id: string;
  binary_found: boolean;
  authenticated: boolean | 'unknown';
  sandbox_status?: 'supported' | 'unsupported' | 'unknown';
};

export type ProviderCapabilitySnapshot = {
  generated_at: string;
  registered_capabilities: number;
  available_capabilities: number;
  available_providers: string[];
  missing_providers: string[];
  providers: ProviderCapabilitySnapshotProvider[];
  capabilities: ProviderCapabilitySnapshotCapability[];
  runtime_probes?: ProviderCapabilityRuntimeProbe[];
};

const PROVIDER_CAPABILITY_SNAPSHOT_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/provider-capability-snapshot.schema.json'
);

function providerCapabilitySnapshotCatalog(filePath: string) {
  return defineCatalog<ProviderCapabilitySnapshot>({
    id: 'provider-capability-snapshot',
    path: filePath,
    schema: PROVIDER_CAPABILITY_SNAPSHOT_SCHEMA_PATH,
  });
}

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

function parseRuntimeProbe(value: unknown, index: number): ProviderCapabilityRuntimeProbe {
  const label = `provider capability snapshot.runtime_probes[${index}]`;
  const record = parseSafeJsonObjectValue(value, label);
  assertExactKeys(
    record,
    ['provider_id', 'binary_found', 'authenticated', 'sandbox_status'],
    label
  );
  if (typeof record.binary_found !== 'boolean') {
    throw new Error(`${label}.binary_found must be a boolean`);
  }
  if (
    record.authenticated !== true &&
    record.authenticated !== false &&
    record.authenticated !== 'unknown'
  ) {
    throw new Error(`${label}.authenticated must be a boolean or unknown`);
  }
  const sandboxStatusValue = record.sandbox_status;
  if (
    sandboxStatusValue !== undefined &&
    sandboxStatusValue !== 'supported' &&
    sandboxStatusValue !== 'unsupported' &&
    sandboxStatusValue !== 'unknown'
  ) {
    throw new Error(`${label}.sandbox_status is invalid`);
  }
  const sandboxStatus = sandboxStatusValue as ProviderCapabilityRuntimeProbe['sandbox_status'];
  return {
    provider_id: nonEmptyString(record.provider_id, `${label}.provider_id`),
    binary_found: record.binary_found,
    authenticated: record.authenticated,
    ...(sandboxStatus !== undefined ? { sandbox_status: sandboxStatus } : {}),
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
      'runtime_probes',
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
  const runtimeProbesValue = root.runtime_probes;
  if (runtimeProbesValue !== undefined && !Array.isArray(runtimeProbesValue)) {
    throw new Error('provider capability snapshot.runtime_probes must be an array');
  }
  const runtimeProbes = runtimeProbesValue as unknown[] | undefined;
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
    ...(runtimeProbes !== undefined
      ? { runtime_probes: runtimeProbes.map(parseRuntimeProbe) }
      : {}),
  };
}

/** Validate an in-memory or persisted provider snapshot through the catalog boundary. */
export function validateProviderCapabilitySnapshot(
  value: unknown,
  sourcePath = 'provider capability snapshot'
): ProviderCapabilitySnapshot {
  const validated = providerCapabilitySnapshotCatalog(sourcePath).validate(value, sourcePath);
  return parseProviderCapabilitySnapshot(validated);
}

/** Load the persisted provider snapshot through repository, file, and schema boundaries. */
export function loadProviderCapabilitySnapshotAtPath(filePath: string): ProviderCapabilitySnapshot {
  const loaded = providerCapabilitySnapshotCatalog(filePath).load();
  return parseProviderCapabilitySnapshot(loaded);
}

export function buildProviderCapabilitySnapshot(params: {
  registry: CapabilityRegistry;
  discovered: DiscoveredCapability[];
  providerAvailability: Map<string, ProbeResult>;
  providers: ProviderInfo[];
  runtimeProbes?: readonly ProviderCapability[];
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
    ...(params.runtimeProbes
      ? {
          runtime_probes: [...params.runtimeProbes]
            .map((probe) => ({
              provider_id: probe.provider_id,
              binary_found: probe.binary_found,
              authenticated: probe.authenticated,
              ...(probe.sandbox_probe ? { sandbox_status: probe.sandbox_probe.status } : {}),
            }))
            .sort((a, b) => a.provider_id.localeCompare(b.provider_id)),
        }
      : {}),
  };
}
