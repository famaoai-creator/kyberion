import * as path from 'node:path';
import {
  buildProviderCapabilitySnapshot,
  validateProviderCapabilitySnapshot,
} from '@agent/core/provider-capability-overview';
import {
  discoverProviders,
  mergeProbedCapabilitiesIntoCatalog,
  type ProbedProviderCapabilities,
} from '@agent/core/provider-discovery';
import {
  loadCapabilityRegistry,
  probeProviderAvailability,
  scanProviderCapabilities,
} from '@agent/core/provider-capability-scanner';
import { probeProviderCapabilities } from '@agent/core/provider-capability-registry';
import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath, safeMkdir, safeWriteFile } from '@agent/core/secure-io';
import { defineScript, isDirectScript } from './lib/harness.js';

export const PROVIDER_CAPABILITY_SCAN_USAGE =
  'Usage: pnpm scan:provider-cli-capabilities [--out <path>] [--write-knowledge]';

export function main(args: string[]): unknown {
  if (args.includes('--help') || args.includes('-h')) {
    return { status: 'help', usage: PROVIDER_CAPABILITY_SCAN_USAGE };
  }

  const outPathArgIndex = args.indexOf('--out');
  const outPath =
    outPathArgIndex >= 0 && args[outPathArgIndex + 1]
      ? args[outPathArgIndex + 1]
      : pathResolver.rootResolve('active/shared/runtime/provider-capabilities.json');

  const registry = loadCapabilityRegistry();
  const providerAvailability = probeProviderAvailability();
  const runtimeProbes = probeProviderCapabilities();
  const discovered = scanProviderCapabilities(registry);
  const discoveredProviders = new Map(
    discoverProviders(true).map((provider) => [provider.provider, provider])
  );
  const providers = [...new Set([...providerAvailability.keys(), ...discoveredProviders.keys()])]
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
    runtimeProbes,
  });

  const resolvedOutPath = assertSafeRepositoryPath(pathResolver.resolve(outPath), {
    allowMissingLeaf: true,
  });
  const validatedSummary = validateProviderCapabilitySnapshot(summary, resolvedOutPath);
  safeMkdir(path.dirname(resolvedOutPath), { recursive: true });
  safeWriteFile(resolvedOutPath, JSON.stringify(validatedSummary, null, 2), {
    encoding: 'utf8',
  });

  // probe -> knowledge loop: optionally merge what was discovered into the knowledge catalog
  // (knowledge/product/orchestration/provider-capabilities.json), preserving manual edits.
  if (args.includes('--write-knowledge')) {
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
  }

  return summary;
}

const script = defineScript({
  name: 'scan:provider-cli-capabilities',
  flags: ['json'],
  run: ({ argv, print }) => {
    const result = main(argv);
    print(result);
    return result;
  },
});
if (
  isDirectScript(import.meta.url, 'scan_provider_cli_capabilities.ts') ||
  isDirectScript(import.meta.url, 'scan_provider_cli_capabilities.js')
) {
  void script();
}
