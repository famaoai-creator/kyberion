import {
  loadCapabilityRegistry,
  probeProviderAvailability,
} from '@agent/core/provider-capability-scanner';
import { resolveProviderCliCapabilityReportPolicy } from '@agent/core/provider-cli-capability-report-policy';
import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath } from '@agent/core/secure-io';
import { defineCatalog } from '@agent/core/foundation';
import type { CapabilityRegistryEntry } from '@agent/core/provider-capability-scanner';
import { defineGenerator, isDirectScript, type GeneratedFile } from './lib/harness.js';

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

const ADAPTER_REGISTRY_PATH = pathResolver.knowledge(
  'product/governance/harness-adapter-registry.json'
);
const ADAPTER_REGISTRY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/harness-adapter-registry.schema.json'
);
const DEFAULT_REPORT_PATH = pathResolver.knowledge(
  'product/architecture/provider-cli-capability-report.md'
);

const adapterRegistryCatalog = defineCatalog<AdapterRegistry>({
  id: 'harness-adapter-registry',
  path: ADAPTER_REGISTRY_PATH,
  schema: ADAPTER_REGISTRY_SCHEMA_PATH,
});

function parseArg(args: string[], name: string, fallback?: string): string {
  const prefixed = args.find((arg) => arg.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  const idx = args.indexOf(name);
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required argument: ${name}`);
}

function formatTableRow(cols: string[]): string {
  return `| ${cols.map((col) => col.replace(/\|/g, '\\|')).join(' | ')} |`;
}

function buildReport(
  capabilities: CapabilityRegistryEntry[],
  adapters: AdapterEntry[],
  providerAvailability: Map<string, { ok: boolean; evidence: string }>
): string {
  const policy = resolveProviderCliCapabilityReportPolicy();
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

  let md = `# ${policy.title}\n\n`;
  md += `## ${policy.summary_title}\n\n`;
  md += `- Capabilities registered: ${capabilities.length}\n`;
  md += `- Active capabilities: ${activeCount}\n`;
  md += `- Experimental capabilities: ${experimentalCount}\n`;
  md += `- Capabilities with adapters: ${matchedCount}\n`;
  md += `- Capabilities missing adapters: ${missingAdapter.length}\n\n`;
  md += `- Providers available: ${availableProviders}/${providerAvailability.size}\n`;
  md += `- Available providers: ${availableProviderNames.join(', ') || 'none'}\n\n`;

  md += `## ${policy.capability_inventory_title}\n\n`;
  md +=
    '| Provider | Capability | Kind | Risk | Replayability | Status | Provider Probe | Adapter |\n';
  md += '|---|---|---|---|---|---|---|---|\n';

  for (const capability of [...capabilities].sort((a, b) => {
    const providerCmp = a.source.provider.localeCompare(b.source.provider);
    if (providerCmp !== 0) return providerCmp;
    return a.capability_id.localeCompare(b.capability_id);
  })) {
    const adapter = adapterByCapability.get(capability.capability_id);
    const probe = providerAvailability.get(capability.source.provider);
    md +=
      formatTableRow([
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

  md += `\n## ${policy.provider_title_prefix}\n\n`;
  for (const [provider, providerCapabilities] of [...byProvider.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    md += `### ${provider}\n\n`;
    md += `Provider probe: ${providerAvailability.get(provider)?.ok ? 'available' : 'missing'}\n\n`;
    md += '| Capability | Source | Intent Shapes | Fallback |\n';
    md += '|---|---|---|---|\n';
    for (const capability of providerCapabilities.sort((a, b) =>
      a.capability_id.localeCompare(b.capability_id)
    )) {
      md +=
        formatTableRow([
          capability.capability_id,
          capability.source.name,
          capability.preferred_usage.workflow_shapes.join(', '),
          capability.fallback_path.target,
        ]) + '\n';
    }
    md += '\n';
  }

  if (missingAdapter.length > 0) {
    md += `## ${policy.missing_adapter_title}\n\n`;
    md += `${policy.missing_adapter_message}\n\n`;
    for (const capability of missingAdapter.sort((a, b) =>
      a.capability_id.localeCompare(b.capability_id)
    )) {
      md += `- ${capability.capability_id} (${capability.source.provider})\n`;
    }
    md += '\n';
  }

  md += '## Governance Note\n\n';
  md += 'The report is generated from the governed capability and adapter registries. ';
  md += 'It should be regenerated whenever provider help output or registry entries change.\n';

  return md;
}

function render(args: string[]): GeneratedFile[] {
  const outPath = parseArg(args, '--out', DEFAULT_REPORT_PATH);
  const capabilityRegistry = loadCapabilityRegistry();
  const adapterRegistry = adapterRegistryCatalog.load();
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
  const resolvedOutPath = assertSafeRepositoryPath(pathResolver.resolve(outPath), {
    allowMissingLeaf: true,
  });
  return [{ path: resolvedOutPath, content: report }];
}

export const runGenerateProviderCliCapabilityReport = defineGenerator({
  id: 'provider-cli-capability-report',
  outputs: (context) => [
    assertSafeRepositoryPath(
      pathResolver.resolve(parseArg(context.argv, '--out', DEFAULT_REPORT_PATH)),
      { allowMissingLeaf: true }
    ),
  ],
  render: ({ argv }) => render(argv),
});
if (
  isDirectScript(import.meta.url, 'generate_provider_cli_capability_report.ts') ||
  isDirectScript(import.meta.url, 'generate_provider_cli_capability_report.js')
) {
  void runGenerateProviderCliCapabilityReport();
}
