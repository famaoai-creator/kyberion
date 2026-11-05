import { listImageGenerationProviders } from './provider-registry.js';
import { registerImageGenerationProvider } from './provider-registry.js';
import { ComfyUiImageGenerationProvider } from './providers/comfyui.js';
import {
  GeminiFastImageGenerationProvider,
  GeminiServiceImageGenerationProvider,
  GeminiImageModelGenerationProvider,
} from './providers/gemini.js';
import { LlmApiImageGenerationProvider } from './providers/llm-api.js';
import {
  LocalDiffusionImageGenerationProvider,
  LocalFluxImageGenerationProvider,
} from './providers/local-flux.js';
import {
  WindowsNativeImageGenerationProvider,
  ApplePlaygroundImageGenerationProvider,
} from './providers/native.js';
import {
  HostAgentImageGenerationProvider,
  CodexHostBridgeImageGenerationProvider,
  AgyHostBridgeImageGenerationProvider,
  CursorHostBridgeImageGenerationProvider,
} from './providers/host-bridge.js';
import type { ImageGenerationProvider } from '../image-generation-types.js';

const builtinFactories: Readonly<Record<string, () => ImageGenerationProvider>> = {
  comfyui: () => new ComfyUiImageGenerationProvider(),
  gemini_fast: () => new GeminiFastImageGenerationProvider(),
  gemini_service: () => new GeminiServiceImageGenerationProvider(),
  gemini_image: () => new GeminiImageModelGenerationProvider(),
  llm_api: () => new LlmApiImageGenerationProvider(),
  local_flux: () => new LocalFluxImageGenerationProvider(),
  windows_native: () => new WindowsNativeImageGenerationProvider(),
  local_diffusion: () => new LocalDiffusionImageGenerationProvider(),
  apple_playground: () => new ApplePlaygroundImageGenerationProvider(),
  cursor_host_bridge: () => new CursorHostBridgeImageGenerationProvider(),
  codex_host_bridge: () => new CodexHostBridgeImageGenerationProvider(),
  agy_host_bridge: () => new AgyHostBridgeImageGenerationProvider(),
  host_agent: () => new HostAgentImageGenerationProvider(),
};

export function ensureBuiltinImageGenerationProviders(): void {
  const existing = new Set(listImageGenerationProviders().map((provider) => provider.id));
  for (const [id, factory] of Object.entries(builtinFactories)) {
    if (!existing.has(id))
      registerImageGenerationProvider(factory(), {
        provenance: 'builtin',
        source: 'image-generation-bridge',
      });
  }
}
