import { safeExec, safeReadFile } from './secure-io.js';
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

type ProviderScanPolicy = {
  version: string;
  providers: ProviderScanPolicyEntry[];
};

export type ProbeResult = {
  provider: string;
  ok: boolean;
  evidence: string;
  command: string;
  args: string[];
  stdout?: string;
  error?: string;
};

export type DiscoveredCapability = CapabilityRegistryEntry & {
  discovery_status: 'available' | 'missing';
  provider_probe: ProbeResult;
  evidence?: string;
};

function readJson<T>(relativePath: string): T {
  return JSON.parse(safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }) as string) as T;
}

export function loadCapabilityRegistry(
  relativePath = 'knowledge/public/governance/harness-capability-registry.json',
): CapabilityRegistry {
  return readJson<CapabilityRegistry>(relativePath);
}

export function loadProviderCapabilityScanPolicy(
  relativePath = 'knowledge/public/governance/provider-capability-scan-policy.json',
): ProviderScanPolicy {
  return readJson<ProviderScanPolicy>(relativePath);
}

function runProbe(provider: string, probe: ProbeDefinition): ProbeResult {
  const args = probe.args || [];
  try {
    const stdout = safeExec(probe.command, args, {
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
): Map<string, ProbeResult> {
  const results = new Map<string, ProbeResult>();
  for (const providerPolicy of policy.providers) {
    results.set(providerPolicy.provider, runProbe(providerPolicy.provider, providerPolicy.primary_probe));
  }
  return results;
}

export function scanProviderCapabilities(
  registry: CapabilityRegistry = loadCapabilityRegistry(),
  policy: ProviderScanPolicy = loadProviderCapabilityScanPolicy(),
  options: { includeUnavailable?: boolean } = {},
): DiscoveredCapability[] {
  const includeUnavailable = options.includeUnavailable ?? false;
  const providerPolicies = new Map(policy.providers.map((providerPolicy) => [providerPolicy.provider, providerPolicy]));
  const providerProbes = probeProviderAvailability(policy);
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
        const specificProbe = runProbe(providerPolicy.provider, matchedProbe.probe);
        if (specificProbe.ok) {
          evidence = specificProbe.evidence;
        }
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
