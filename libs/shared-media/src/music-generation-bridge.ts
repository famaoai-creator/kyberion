/** Stable music facade: builtin composition is explicit and routing only depends on contracts/registry. */
import type {
  MusicGenerationProvider,
  MusicGenerationRequest,
  MusicGenerationResult,
} from './music-generation-types.js';
import type { SeamProviderCandidate } from '@agent/core/seam-provider-selection';
import { ensureBuiltinMusicGenerationProviders } from './music-generation/builtin-providers.js';
import {
  listMusicGenerationProviders as listRegistered,
  getMusicGenerationProvider as getRegistered,
} from './music-generation/provider-registry.js';
import {
  listMusicGenerationCandidates as candidates,
  generateMusic as generate,
} from './music-generation/router.js';
export {
  registerMusicGenerationProvider,
  resetMusicGenerationProviders,
} from './music-generation/provider-registry.js';
export function listMusicGenerationProviders(): MusicGenerationProvider[] {
  ensureBuiltinMusicGenerationProviders();
  return listRegistered();
}
export function getMusicGenerationProvider(id: string): MusicGenerationProvider | undefined {
  ensureBuiltinMusicGenerationProviders();
  return getRegistered(id);
}
export async function listMusicGenerationCandidates(
  request: Pick<MusicGenerationRequest, 'durationSec' | 'format' | 'vocals'>
): Promise<SeamProviderCandidate[]> {
  ensureBuiltinMusicGenerationProviders();
  return candidates(request);
}
export async function generateMusic(
  request: MusicGenerationRequest
): Promise<MusicGenerationResult> {
  ensureBuiltinMusicGenerationProviders();
  return generate(request);
}
export { extractAbcNotation } from './music-generation/providers/chatmusician.js';
export { LocalMusicGenMlxGenerationProvider } from './music-generation/providers/musicgen-mlx.js';
export { LocalStableAudioGenerationProvider } from './music-generation/providers/stable-audio.js';
export { MlAudioGenGenerationProvider } from './music-generation/providers/ml-audiogen.js';
export { ChatMusicianGenerationProvider } from './music-generation/providers/chatmusician.js';
