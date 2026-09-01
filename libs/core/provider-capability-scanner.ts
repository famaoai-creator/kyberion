import { assertSafeRepositoryPath, safeExec } from './secure-io.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';

type CapabilitySource = {
  type: string;
  provider: string;
  name: string;
  version: string;
};

export type CapabilityRegistryEntry = {
  capability_id: string;
  source: CapabilitySource;
  kind: string;
  interaction_mode: string;
  risk_class: string;
  replayability: string;
  approval_hooks: {
    requires_pre_approval: boolean;
    approval_scope: string;
  };
  preferred_usage: {
    workflow_shapes: string[];
    intents: string[];
  };
  fallback_path: {
    mode: string;
    target: string;
  };
  status: string;
  notes?: string;
};

export type CapabilityRegistry = {
  version: string;
  capabilities: CapabilityRegistryEntry[];
};

type ProbeDefinition = {
  command: string;
  args?: string[];
  timeout_ms?: number;
  max_output_mb?: number;
  evidence?: string;
};

type ProviderEvidenceProbe = {
  capability_ids: string[];
  probe: ProbeDefinition;
};

type ProviderScanPolicyEntry = {
  provider: string;
  primary_probe: ProbeDefinition;
  evidence_probes?: ProviderEvidenceProbe[];
};

export type ProviderScanPolicy = {
  version: string;
  providers: ProviderScanPolicyEntry[];
};

const CAPABILITY_REGISTRY_PATH = 'knowledge/product/governance/harness-capability-registry.json';
const CAPABILITY_REGISTRY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/harness-capability-registry.schema.json'
);
const PROVIDER_SCAN_POLICY_PATH =
  'knowledge/product/governance/provider-capability-scan-policy.json';
const PROVIDER_SCAN_POLICY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/provider-capability-scan-policy.schema.json'
);

const capabilityRegistryCatalog = defineCatalog<CapabilityRegistry>({
  id: 'harness-capability-registry',
  path: () => pathResolver.rootResolve(CAPABILITY_REGISTRY_PATH),
  schema: CAPABILITY_REGISTRY_SCHEMA_PATH,
});

const providerCapabilityScanPolicyCatalog = defineCatalog<ProviderScanPolicy>({
  id: 'provider-capability-scan-policy',
  path: () => pathResolver.rootResolve(PROVIDER_SCAN_POLICY_PATH),
  schema: PROVIDER_SCAN_POLICY_SCHEMA_PATH,
});

export type ProbeResult = {
  provider: string;
  ok: boolean;
  evidence: string;
  command: string;
  args: string[];
  stdout?: string;
  error?: string;
};

export type CapabilityProbeExecutor = (
  command: string,
  args: string[],
  options: { timeoutMs?: number; maxOutputMB?: number }
) => string;

export type DiscoveredCapability = CapabilityRegistryEntry & {
  discovery_status: 'available' | 'missing';
  provider_probe: ProbeResult;
  evidence_probe?: ProbeResult;
  evidence?: string;
};

export function loadCapabilityRegistry(
  relativePath = CAPABILITY_REGISTRY_PATH
): CapabilityRegistry {
  if (relativePath === CAPABILITY_REGISTRY_PATH) return capabilityRegistryCatalog.load();
  return defineCatalog<CapabilityRegistry>({
    id: 'harness-capability-registry',
    path: assertSafeRepositoryPath(pathResolver.rootResolve(relativePath)),
    schema: CAPABILITY_REGISTRY_SCHEMA_PATH,
  }).load();
}

export function loadProviderCapabilityScanPolicy(
  relativePath = PROVIDER_SCAN_POLICY_PATH
): ProviderScanPolicy {
  if (relativePath === PROVIDER_SCAN_POLICY_PATH) return providerCapabilityScanPolicyCatalog.load();
  return defineCatalog<ProviderScanPolicy>({
    id: 'provider-capability-scan-policy',
    path: assertSafeRepositoryPath(pathResolver.rootResolve(relativePath)),
    schema: PROVIDER_SCAN_POLICY_SCHEMA_PATH,
  }).load();
}

function runProbe(
  provider: string,
  probe: ProbeDefinition,
  exec: CapabilityProbeExecutor = safeExec
): ProbeResult {
  const args = probe.args || [];
  try {
    const stdout = exec(probe.command, args, {
      timeoutMs: probe.timeout_ms || 10000,
      maxOutputMB: probe.max_output_mb || 1,
    }).trim();
    return {
      provider,
      ok: true,
      evidence: probe.evidence || `${probe.command} ${args.join(' ')}`.trim(),
      command: probe.command,
      args,
      stdout,
    };
  } catch (err: any) {
    return {
      provider,
      ok: false,
      evidence: probe.evidence || `${probe.command} ${args.join(' ')}`.trim(),
      command: probe.command,
      args,
      error: err?.message || 'probe failed',
    };
  }
}

function matchesCapabilityIds(targetCapabilityId: string, candidateIds: string[]): boolean {
  return candidateIds.includes(targetCapabilityId);
}

export function probeProviderAvailability(
  policy: ProviderScanPolicy = loadProviderCapabilityScanPolicy(),
  options: { exec?: CapabilityProbeExecutor } = {}
): Map<string, ProbeResult> {
  const results = new Map<string, ProbeResult>();
  for (const providerPolicy of policy.providers) {
    results.set(
      providerPolicy.provider,
      runProbe(providerPolicy.provider, providerPolicy.primary_probe, options.exec)
    );
  }
  return results;
}

export function scanProviderCapabilities(
  registry: CapabilityRegistry = loadCapabilityRegistry(),
  policy: ProviderScanPolicy = loadProviderCapabilityScanPolicy(),
  options: { includeUnavailable?: boolean; exec?: CapabilityProbeExecutor } = {}
): DiscoveredCapability[] {
  const includeUnavailable = options.includeUnavailable ?? false;
  const providerPolicies = new Map(
    policy.providers.map((providerPolicy) => [providerPolicy.provider, providerPolicy])
  );
  const providerProbes = probeProviderAvailability(policy, { exec: options.exec });
  const discovered: DiscoveredCapability[] = [];

  for (const capability of registry.capabilities) {
    const providerPolicy = providerPolicies.get(capability.source.provider);
    const providerProbe = providerProbes.get(capability.source.provider);
    if (!providerPolicy || !providerProbe) {
      if (includeUnavailable) {
        discovered.push({
          ...capability,
          discovery_status: 'missing',
          provider_probe: {
            provider: capability.source.provider,
            ok: false,
            evidence: 'provider policy missing',
            command: '',
            args: [],
            error: 'provider policy missing',
          },
        });
      }
      continue;
    }

    if (!providerProbe.ok) {
      if (includeUnavailable) {
        discovered.push({
          ...capability,
          discovery_status: 'missing',
          provider_probe: providerProbe,
        });
      }
      continue;
    }

    let evidence = providerProbe.evidence;
    if (providerPolicy.evidence_probes && providerPolicy.evidence_probes.length > 0) {
      const matchedProbe = providerPolicy.evidence_probes.find((entry) =>
        matchesCapabilityIds(capability.capability_id, entry.capability_ids)
      );
      if (matchedProbe) {
        const specificProbe = runProbe(providerPolicy.provider, matchedProbe.probe, options.exec);
        if (!specificProbe.ok) {
          if (includeUnavailable) {
            discovered.push({
              ...capability,
              discovery_status: 'missing',
              provider_probe: providerProbe,
              evidence_probe: specificProbe,
            });
          }
          continue;
        }
        evidence = specificProbe.evidence;
        discovered.push({
          ...capability,
          discovery_status: 'available',
          provider_probe: providerProbe,
          evidence_probe: specificProbe,
          evidence,
        });
        continue;
      }
    }

    discovered.push({
      ...capability,
      discovery_status: 'available',
      provider_probe: providerProbe,
      evidence,
    });
  }

  return discovered;
}
