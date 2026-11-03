import { createProviderRegistry } from '../../provider-registry.js';
import type { SeamProviderMetadata } from '../../seam.js';
import type { ImageGenerationProvider } from '../image-generation-types.js';
import { governImageProvider } from './admission.js';
export const IMAGE_GENERATION_PROVIDER_SEAM = 'image-generation-provider';
const registry = createProviderRegistry<ImageGenerationProvider>({
  seam: IMAGE_GENERATION_PROVIDER_SEAM,
  owner: 'libs/core/media/image-generation/provider-registry.ts',
  source: 'image-generation-extension',
  govern: governImageProvider,
  missingIdError: 'ImageGenerationProvider.id is required',
});
export function imageGenerationProviderRevision(): number {
  return registry.revision();
}
export function registerImageGenerationProvider(
  provider: ImageGenerationProvider,
  metadata?: SeamProviderMetadata
): () => void {
  return registry.register(provider, metadata);
}
export function listImageGenerationProviders(): ImageGenerationProvider[] {
  return registry.list();
}
export function getImageGenerationProvider(id: string): ImageGenerationProvider | undefined {
  return registry.get(id);
}
export function resetImageGenerationProviders(): void {
  registry.reset();
}
