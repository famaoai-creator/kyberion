import { createProviderRegistry } from '@agent/core/provider-registry';
import type { SeamProviderMetadata } from '@agent/core/seam';
import type { MusicGenerationProvider } from '../music-generation-types.js';
export const MUSIC_GENERATION_PROVIDER_SEAM = 'music-generation-provider';
const registry = createProviderRegistry<MusicGenerationProvider>({
  seam: MUSIC_GENERATION_PROVIDER_SEAM,
  owner: 'libs/shared-media/src/music-generation/provider-registry.ts',
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
