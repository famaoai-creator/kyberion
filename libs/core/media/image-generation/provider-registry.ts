import {
  coreSeamCatalog,
  createSeam,
  createSeamLifecycle,
  type SeamProviderMetadata,
} from '../../seam.js';
import type { ImageGenerationProvider } from '../image-generation-types.js';
import { governImageProvider } from './admission.js';
export const IMAGE_GENERATION_PROVIDER_SEAM = 'image-generation-provider';
const imageGenerationProviderSeam = createSeam<ImageGenerationProvider>({
  key: 'image-generation-provider',
  multiplicity: 'named',
  catalog: coreSeamCatalog,
  owner: 'libs/core/media/image-generation/provider-registry.ts',
});
let revision = 0;
const lifecycle = createSeamLifecycle(imageGenerationProviderSeam, {
  onChange: () => {
    revision++;
  },
});
export function imageGenerationProviderRevision(): number {
  return revision;
}
export function registerImageGenerationProvider(
  provider: ImageGenerationProvider,
  metadata: SeamProviderMetadata = { provenance: 'plugin', source: 'image-generation-extension' }
): () => void {
  const id = String(provider.id || '').trim();
  if (!id) throw new Error('ImageGenerationProvider.id is required');
  return lifecycle.register(id, governImageProvider(provider), metadata);
}
export function listImageGenerationProviders(): ImageGenerationProvider[] {
  return imageGenerationProviderSeam.list().map((record) => record.implementation);
}
export function resetImageGenerationProviders(): void {
  lifecycle.reset();
}
