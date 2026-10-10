/**
 * Public ingress provider seam (named): one adapter implementation per
 * provider id declared in public-ingress-providers.json. The registry loads
 * provider modules on demand and registers them here; callers never import a
 * provider module directly.
 */
import { coreSeamCatalog, createSeam, type SeamProviderMetadata } from '../seam.js';
import type { PublicIngressProvider } from './public-ingress-contract.js';

const publicIngressProviderSeam = createSeam<PublicIngressProvider>({
  key: 'public-ingress-provider',
  multiplicity: 'named',
  catalog: coreSeamCatalog,
  owner: 'libs/core/ingress/public-ingress-seam.ts',
});

const disposers = new Map<string, () => void>();

export function registerPublicIngressProvider(
  provider: PublicIngressProvider,
  metadata: SeamProviderMetadata = { provenance: 'plugin', source: 'public-ingress-extension' }
): () => void {
  const id = String(provider.id || '').trim();
  if (!id) throw new Error('PublicIngressProvider.id is required');
  const dispose = publicIngressProviderSeam.register(id, provider, metadata);
  const wrapped = () => {
    dispose();
    if (disposers.get(id) === wrapped) disposers.delete(id);
  };
  disposers.set(id, wrapped);
  return wrapped;
}

export function getRegisteredPublicIngressProvider(id: string): PublicIngressProvider | undefined {
  return publicIngressProviderSeam.getOptional(id);
}

export function listRegisteredPublicIngressProviderIds(): string[] {
  return publicIngressProviderSeam.list().map((entry) => entry.id);
}

/** Test helper: drop every registered provider. */
export function resetPublicIngressProviders(): void {
  for (const dispose of [...disposers.values()]) dispose();
  disposers.clear();
}
