import { GoogleVeoProvider } from './providers/google-veo.js';
import { RunwayProvider } from './providers/runway.js';
import { OpenAiSoraProvider } from './providers/openai-sora.js';
import { MiniMaxHailuoProvider } from './providers/minimax-hailuo.js';
import type { DirectVideoProviderAdapter } from './types.js';
import {
  assertDirectVideoProviderAdapter,
  registerDirectVideoProviderAdapter,
  videoProviderAdapterEntry,
} from './provider-registry.js';

let directVideoBuiltinsRegistered = false;

export function ensureDirectVideoProviderAdapters(): void {
  if (directVideoBuiltinsRegistered) return;
  for (const [id, create, features] of [
    [
      'google_veo',
      () => new GoogleVeoProvider(),
      {
        first_frame_image: 'data_uri',
        last_frame_image: 'data_uri',
        aspect_ratios: ['16:9', '9:16'],
      },
    ],
    [
      'runway',
      () => new RunwayProvider(),
      {
        first_frame_image: 'any',
        last_frame_image: 'any',
        aspect_ratios: ['16:9', '9:16', '1:1'],
        requires_first_frame: 'first_frame_image (the Runway adapter uses image_to_video)',
      },
    ],
    [
      'openai_sora',
      () => new OpenAiSoraProvider(),
      { first_frame_image: 'data_uri', last_frame_image: false, aspect_ratios: false },
    ],
    [
      'minimax_hailuo',
      () => new MiniMaxHailuoProvider(),
      { first_frame_image: 'any', last_frame_image: 'any', aspect_ratios: false },
    ],
  ] as const) {
    registerDirectVideoProviderAdapter(
      id,
      { create, features },
      { provenance: 'builtin', source: 'video-generation-provider' }
    );
  }
  directVideoBuiltinsRegistered = true;
}

export function getDirectVideoProviderAdapter(
  provider: string
): DirectVideoProviderAdapter | undefined {
  ensureDirectVideoProviderAdapters();
  const adapter: unknown = videoProviderAdapterEntry(provider);
  if (!adapter) return undefined;
  assertDirectVideoProviderAdapter(provider, adapter);
  return adapter;
}
