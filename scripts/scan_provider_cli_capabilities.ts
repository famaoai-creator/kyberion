import * as path from 'node:path';
import {
  buildProviderCapabilitySnapshot,
  discoverProviders,
  loadCapabilityRegistry,
  pathResolver,
  probeProviderAvailability,
  safeMkdir,
  safeWriteFile,
  scanProviderCapabilities,
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

  console.log(JSON.stringify(summary, null, 2));
}

main();
