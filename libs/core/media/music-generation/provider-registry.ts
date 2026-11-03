import {
  coreSeamCatalog,
  createSeam,
  createSeamLifecycle,
  type SeamProviderMetadata,
} from '../../seam.js';
import type { MusicGenerationProvider } from '../music-generation-types.js';
export const MUSIC_GENERATION_PROVIDER_SEAM = 'music-generation-provider';
const musicGenerationProviderSeam = createSeam<MusicGenerationProvider>({
  key: 'music-generation-provider',
  multiplicity: 'named',
  catalog: coreSeamCatalog,
  owner: 'libs/core/media/music-generation/provider-registry.ts',
});
const lifecycle = createSeamLifecycle(musicGenerationProviderSeam);
export function registerMusicGenerationProvider(
  provider: MusicGenerationProvider,
  metadata: SeamProviderMetadata = { provenance: 'plugin', source: 'music-generation-extension' }
): () => void {
  const id = String(provider.id || '').trim();
  if (!id) throw new Error('MusicGenerationProvider.id is required');
  return lifecycle.register(id, provider, metadata);
}
export function listMusicGenerationProviders(): MusicGenerationProvider[] {
  return musicGenerationProviderSeam.list().map((record) => record.implementation);
}
export function getMusicGenerationProvider(id: string): MusicGenerationProvider | undefined {
  return musicGenerationProviderSeam.getOptional(id);
}
export function resetMusicGenerationProviders(): void {
  lifecycle.reset();
}
