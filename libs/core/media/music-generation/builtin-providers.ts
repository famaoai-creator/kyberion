import { listMusicGenerationProviders } from './provider-registry.js';
import { LocalMusicGenMlxGenerationProvider } from './providers/musicgen-mlx.js';
import { LocalStableAudioGenerationProvider } from './providers/stable-audio.js';
import { MlAudioGenGenerationProvider } from './providers/ml-audiogen.js';
import { ChatMusicianGenerationProvider } from './providers/chatmusician.js';
import { registerMusicGenerationProvider } from './provider-registry.js';
import type { MusicGenerationProvider } from '../music-generation-types.js';

const builtinFactories: Readonly<Record<string, () => MusicGenerationProvider>> = {
  musicgen_mlx: () => new LocalMusicGenMlxGenerationProvider(),
  musicgen_audiogen: () => new MlAudioGenGenerationProvider(),
  stable_audio_3: () => new LocalStableAudioGenerationProvider(),
  chatmusician_mlx: () => new ChatMusicianGenerationProvider(),
};

export function ensureBuiltinMusicGenerationProviders(): void {
  const existing = new Set(listMusicGenerationProviders().map((provider) => provider.id));
  for (const [id, factory] of Object.entries(builtinFactories)) {
    if (!existing.has(id))
      registerMusicGenerationProvider(factory(), {
        provenance: 'builtin',
        source: 'music-generation-bridge',
      });
  }
}
