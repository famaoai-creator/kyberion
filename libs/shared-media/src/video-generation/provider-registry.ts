import { createSeam, coreSeamCatalog, type SeamProviderMetadata } from '@agent/core/seam';
import type { DirectVideoProviderAdapter } from './types.js';
import { isJsonRecord } from './provider-support.js';

const directVideoProviderAdapters = createSeam<DirectVideoProviderAdapter>({
  // Literal key: the AST seam checker resolves declarations per file.
  key: 'video-generation-provider-adapter',
  multiplicity: 'named',
  catalog: coreSeamCatalog,
  owner: 'libs/shared-media/src/video-generation/provider-registry.ts',
});
export function assertDirectVideoProviderAdapter(
  provider: string,
  candidate: unknown
): asserts candidate is DirectVideoProviderAdapter {
  if (!/^[a-z][a-z0-9._-]*$/.test(provider)) {
    throw new Error('Invalid direct video provider id: ' + provider);
  }
  if (
    !isJsonRecord(candidate) ||
    typeof candidate.create !== 'function' ||
    !isJsonRecord(candidate.features)
  ) {
    throw new Error(
      'Direct video provider ' + provider + ' requires a factory and feature contract'
    );
  }
  const features = candidate.features;
  for (const feature of ['first_frame_image', 'last_frame_image'] as const) {
    const mode = features[feature];
    if (mode !== 'any' && mode !== 'data_uri' && mode !== false) {
      throw new Error(
        'Direct video provider ' + provider + ' has invalid ' + feature + ' capability'
      );
    }
  }
  const ratios = features.aspect_ratios;
  if (
    ratios !== false &&
    (!Array.isArray(ratios) || ratios.some((ratio) => typeof ratio !== 'string' || !ratio.trim()))
  ) {
    throw new Error('Direct video provider ' + provider + ' has invalid aspect_ratios capability');
  }
  if (
    features.requires_first_frame !== undefined &&
    (typeof features.requires_first_frame !== 'string' ||
      !features.requires_first_frame.trim() ||
      features.first_frame_image === false)
  ) {
    throw new Error(
      'Direct video provider ' + provider + ' has an inconsistent first-frame requirement'
    );
  }
}
/** Register one direct API adapter and its request-capability contract. */
export function registerDirectVideoProviderAdapter(
  provider: string,
  adapter: DirectVideoProviderAdapter,
  metadata: SeamProviderMetadata = { provenance: 'plugin', source: 'video-generation-extension' }
): () => void {
  const id = provider.trim();
  assertDirectVideoProviderAdapter(id, adapter);
  return directVideoProviderAdapters.register(id, adapter, metadata);
}

export function videoProviderAdapterEntry(provider: string): unknown {
  return directVideoProviderAdapters.getOptional(provider);
}
