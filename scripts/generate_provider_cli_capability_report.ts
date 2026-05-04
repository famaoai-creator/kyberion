import { safeMkdir, safeWriteFile, pathResolver, loadCapabilityRegistry, probeProviderAvailability } from '@agent/core';
import { readJsonFile } from './refactor/cli-input.js';
import * as path from 'node:path';
import type { CapabilityRegistryEntry } from '@agent/core';

type AdapterEntry = {
  adapter_id: string;
  provider: string;
  surface_kind: string;
  capability_id: string;
  contract_kind: string;
  observation_kind: string;
  result_kind: string;
  approval_behavior: string;
  replayability: string;
  fallback_contract: string;
  enabled: boolean;
  owner: string;
  notes?: string;
};

type AdapterRegistry = {
  version: string;
  profiles: AdapterEntry[];
};

function readJson<T>(relativePath: string): T {
  return readJsonFile(pathResolver.rootResolve(relativePath));
}

function parseArg(name: string, fallback?: string): string {
  const prefixed = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required argument: ${name}`);
}

function formatTableRow(cols: string[]): string {
  return `| ${cols.map((col) => col.replace(/\|/g, '\\|')).join(' | ')} |`;
}

function buildReport(
  capabilities: CapabilityRegistryEntry[],
  adapters: AdapterEntry[],
  providerAvailability: Map<string, { ok: boolean; evidence: string }>,
): string {
  const adapterByCapability = new Map(adapters.map((adapter) => [adapter.capability_id, adapter]));
  const byProvider = new Map<string, CapabilityRegistryEntry[]>();
  for (const capability of capabilities) {
    const provider = capability.source.provider;
    const list = byProvider.get(provider) || [];
    list.push(capability);
    byProvider.set(provider, list);
  }

  const activeCount = capabilities.filter((c) => c.status === 'active').length;
  const experimentalCount = capabilities.filter((c) => c.status === 'experimental').length;
  const matchedCount = capabilities.filter((c) => adapterByCapability.has(c.capability_id)).length;
  const missingAdapter = capabilities.filter((c) => !adapterByCapability.has(c.capability_id));
  const availableProviders = [...providerAvailability.values()].filter((r) => r.ok).length;
  const availableProviderNames = [...providerAvailability.entries()]
    .filter(([, result]) => result.ok)
    .map(([provider]) => provider)
    .sort();

  let md = '# Provider CLI Capability Report\n\n';
  md += '## Summary\n\n';
  md += `- Capabilities registered: ${capabilities.length}\n`;
  md += `- Active capabilities: ${activeCount}\n`;
  md += `- Experimental capabilities: ${experimentalCount}\n`;
  md += `- Capabilities with adapters: ${matchedCount}\n`;
  md += `- Capabilities missing adapters: ${missingAdapter.length}\n\n`;
  md += `- Providers available: ${availableProviders}/${providerAvailability.size}\n`;
  md += `- Available providers: ${availableProviderNames.join(', ') || 'none'}\n\n`;

  md += '## Capability Inventory\n\n';
  md += '| Provider | Capability | Kind | Risk | Replayability | Status | Provider Probe | Adapter |\n';
  md += '|---|---|---|---|---|---|---|---|\n';

  for (const capability of [...capabilities].sort((a, b) => {
    const providerCmp = a.source.provider.localeCompare(b.source.provider);
    if (providerCmp !== 0) return providerCmp;
    return a.capability_id.localeCompare(b.capability_id);
  })) {
    const adapter = adapterByCapability.get(capability.capability_id);
    const probe = providerAvailability.get(capability.source.provider);
    md += formatTableRow([
      capability.source.provider,
      capability.capability_id,
      capability.kind,
      capability.risk_class,
      capability.replayability,
      capability.status,
      probe?.ok ? 'available' : 'missing',
      adapter ? adapter.adapter_id : 'missing',
    ]) + '\n';
  }

  md += '\n## By Provider\n\n';
  for (const [provider, providerCapabilities] of [...byProvider.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    md += `### ${provider}\n\n`;
    md += `Provider probe: ${providerAvailability.get(provider)?.ok ? 'available' : 'missing'}\n\n`;
    md += '| Capability | Source | Intent Shapes | Fallback |\n';
    md += '|---|---|---|---|\n';
    for (const capability of providerCapabilities.sort((a, b) => a.capability_id.localeCompare(b.capability_id))) {
      md += formatTableRow([
        capability.capability_id,
        capability.source.name,
        capability.preferred_usage.workflow_shapes.join(', '),
        capability.fallback_path.target,
      ]) + '\n';
    }
    md += '\n';
  }

  if (missingAdapter.length > 0) {
    md += '## Missing Adapter Coverage\n\n';
    md += 'The following capabilities are registered but do not yet have a matching adapter profile:\n\n';
    for (const capability of missingAdapter.sort((a, b) => a.capability_id.localeCompare(b.capability_id))) {
      md += `- ${capability.capability_id} (${capability.source.provider})\n`;
    }
    md += '\n';
  }

  md += '## Governance Note\n\n';
  md += 'The report is generated from the governed capability and adapter registries. ';
  md += 'It should be regenerated whenever provider help output or registry entries change.\n';

  return md;
}

function main(): void {
  const outPath = parseArg('--out', pathResolver.knowledge('public/architecture/provider-cli-capability-report.md'));
  const capabilityRegistry = loadCapabilityRegistry();
  const adapterRegistry = readJson<AdapterRegistry>('knowledge/public/governance/harness-adapter-registry.json');
  const capabilities = capabilityRegistry.capabilities;
  const adapters = adapterRegistry.profiles;
  const providerAvailability = probeProviderAvailability();

  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    throw new Error('Capability registry is empty.');
  }
  if (!Array.isArray(adapters) || adapters.length === 0) {
    throw new Error('Adapter registry is empty.');
  }

  const report = buildReport(capabilities, adapters, providerAvailability);
  const resolvedOutPath = pathResolver.resolve(outPath);
  safeMkdir(path.dirname(resolvedOutPath), { recursive: true });
  safeWriteFile(resolvedOutPath, report);
  console.log(`[generate:provider-cli-capability-report] wrote report to ${outPath}`);
}

main();
