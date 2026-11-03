import { createProviderRegistry } from '../../provider-registry.js';
import type { SeamProviderMetadata } from '../../seam.js';
import type { MusicGenerationProvider } from '../music-generation-types.js';
export const MUSIC_GENERATION_PROVIDER_SEAM = 'music-generation-provider';
const registry = createProviderRegistry<MusicGenerationProvider>({
  seam: MUSIC_GENERATION_PROVIDER_SEAM,
  owner: 'libs/core/media/music-generation/provider-registry.ts',
  source: 'music-generation-extension',
  missingIdError: 'MusicGenerationProvider.id is required',
});
export function registerMusicGenerationProvider(
  provider: MusicGenerationProvider,
  metadata?: SeamProviderMetadata
): () => void {
  return registry.register(provider, metadata);
}
export function listMusicGenerationProviders(): MusicGenerationProvider[] {
  return registry.list();
}
export function getMusicGenerationProvider(id: string): MusicGenerationProvider | undefined {
  return registry.get(id);
}
export function resetMusicGenerationProviders(): void {
  registry.reset();
}
