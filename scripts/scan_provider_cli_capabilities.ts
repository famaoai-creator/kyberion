import * as path from 'node:path';
import {
  buildProviderCapabilitySnapshot,
  discoverProviders,
  loadCapabilityRegistry,
  mergeProbedCapabilitiesIntoCatalog,
  pathResolver,
  probeProviderAvailability,
  safeMkdir,
  safeWriteFile,
  scanProviderCapabilities,
  type ProbedProviderCapabilities,
} from '@agent/core';

function main(): void {
  const outPathArgIndex = process.argv.indexOf('--out');
  const outPath = outPathArgIndex >= 0 && process.argv[outPathArgIndex + 1]
    ? process.argv[outPathArgIndex + 1]
    : pathResolver.rootResolve('active/shared/runtime/provider-capabilities.json');

  const registry = loadCapabilityRegistry();
  const providerAvailability = probeProviderAvailability();
  const discovered = scanProviderCapabilities(registry);
  const discoveredProviders = new Map(discoverProviders(true).map((provider) => [provider.provider, provider]));
  const providers = [...new Set([
    ...providerAvailability.keys(),
    ...discoveredProviders.keys(),
  ])]
    .sort()
    .map((provider) => {
      const installedProvider = discoveredProviders.get(provider);
      const probe = providerAvailability.get(provider);
      return {
        provider,
        installed: installedProvider?.installed ?? Boolean(probe?.ok),
        version: installedProvider?.version ?? null,
        protocol: installedProvider?.protocol ?? 'json-rpc',
        models: installedProvider?.models ?? [],
        healthy: installedProvider?.healthy ?? Boolean(probe?.ok),
      };
    });

  const summary = buildProviderCapabilitySnapshot({
    registry,
    discovered,
    providerAvailability,
    providers,
  });

  const resolvedOutPath = pathResolver.resolve(outPath);
  safeMkdir(path.dirname(resolvedOutPath), { recursive: true });
  safeWriteFile(resolvedOutPath, JSON.stringify(summary, null, 2), { encoding: 'utf8' });

  // probe -> knowledge loop: optionally merge what was discovered into the knowledge catalog
  // (knowledge/product/orchestration/provider-capabilities.json), preserving manual edits.
  if (process.argv.includes('--write-knowledge')) {
    const probed: Record<string, ProbedProviderCapabilities> = {};
    for (const provider of discoveredProviders.values()) {
      if (!provider.installed) continue;
      probed[provider.provider] = {
        models: provider.models,
        capabilities: provider.capabilities,
        modelCapabilities: provider.modelCapabilities,
      };
    }
    mergeProbedCapabilitiesIntoCatalog(probed, {
      updatedBy: 'scan_provider_cli_capabilities',
      note: 'Refreshed from CLI discovery; union-merged so manual entries are preserved.',
    });
    console.error(`[scan] merged ${Object.keys(probed).length} provider(s) into the knowledge capability catalog`);
  }

  console.log(JSON.stringify(summary, null, 2));
}

main();
