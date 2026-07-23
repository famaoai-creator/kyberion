import { listVoiceSttAdapters, resolveVoiceSttAdapter } from './voice-provider-adapters.js';

export type VoiceSttBackend =
  | 'auto'
  | 'server'
  | 'fluid_audio'
  | 'mlx_whisper'
  | 'whisper_cpp'
  | 'native_speech';

export interface VoiceSttAvailability {
  server: boolean;
  fluidAudio?: boolean;
  mlxWhisper?: boolean;
  whisperCpp: boolean;
  nativeSpeech: boolean;
}

export interface VoiceSttServerConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  provider: 'whisperkit_server' | 'mlx_audio_server' | 'openai_compatible_server';
}

function normalizeBaseUrl(value: string): string | null {
  const normalized = value.trim().replace(/\/+$/, '');
  if (!normalized || normalized.length > 2048) return null;
  try {
    const parsed = new URL(normalized);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return null;
    return normalized;
  } catch {
    return null;
  }
}

export function parseVoiceSttBackend(value: unknown): VoiceSttBackend {
  if (typeof value !== 'string') return 'auto';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'server') return 'server';
  if (normalized === 'fluid_audio' || normalized === 'fluid-audio' || normalized === 'parakeet')
    return 'fluid_audio';
  if (normalized === 'mlx_whisper' || normalized === 'mlx-whisper') return 'mlx_whisper';
  if (normalized === 'whisper_cpp' || normalized === 'whisper.cpp') return 'whisper_cpp';
  if (normalized === 'native_speech' || normalized === 'native' || normalized === 'apple_speech')
    return 'native_speech';
  return 'auto';
}

export function resolveVoiceSttServerConfig(
  env: NodeJS.ProcessEnv = process.env
): VoiceSttServerConfig | null {
  const explicitBaseUrl = env.VOICE_HUB_STT_BASE_URL?.trim();
  const whisperKitBaseUrl = env.WHISPERKIT_BASE_URL?.trim();
  const mlxAudioBaseUrl = env.MLX_AUDIO_BASE_URL?.trim();
  const baseUrl = explicitBaseUrl || whisperKitBaseUrl || mlxAudioBaseUrl;
  if (!baseUrl) return null;

  let provider: VoiceSttServerConfig['provider'] = 'openai_compatible_server';
  if (!explicitBaseUrl && whisperKitBaseUrl) provider = 'whisperkit_server';
  if (!explicitBaseUrl && !whisperKitBaseUrl && mlxAudioBaseUrl) provider = 'mlx_audio_server';

  const model =
    env.VOICE_HUB_STT_MODEL?.trim() ||
    env.WHISPERKIT_MODEL?.trim() ||
    env.MLX_AUDIO_STT_MODEL?.trim() ||
    'openai_whisper-large-v3';
  const apiKey =
    env.VOICE_HUB_STT_API_KEY?.trim() ||
    env.WHISPERKIT_API_KEY?.trim() ||
    env.MLX_AUDIO_API_KEY?.trim() ||
    undefined;

  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) return null;

  return {
    baseUrl: normalizedBaseUrl,
    model,
    apiKey,
    provider,
  };
}

export function resolveVoiceSttBackendOrder(
  requested: VoiceSttBackend,
  availability: VoiceSttAvailability,
  env: NodeJS.ProcessEnv = process.env
): Array<Exclude<VoiceSttBackend, 'auto'>> {
  if (requested !== 'auto') return [requested];

  const preference = (
    env.VOICE_HUB_STT_PREFERENCE || 'server,fluid_audio,mlx_whisper,whisper_cpp,native_speech'
  )
    .split(',')
    .map((item) => parseVoiceSttBackend(item))
    .filter((item): item is Exclude<VoiceSttBackend, 'auto'> => item !== 'auto');

  const deduped = Array.from(new Set(preference));
  const available = deduped.filter((backend) => {
    const adapter = resolveVoiceSttAdapter(backend);
    if (adapter.adapter_id === 'openai_compatible_server') return availability.server;
    if (adapter.adapter_id === 'fluid_audio_native') return availability.fluidAudio === true;
    if (adapter.adapter_id === 'managed_python_bridge') return availability.mlxWhisper === true;
    if (adapter.adapter_id === 'whisper_cpp_cli') return availability.whisperCpp;
    if (adapter.adapter_id === 'native_speech') return availability.nativeSpeech;
    return false;
  });

  if (available.length > 0) return available;

  const fallback: Array<Exclude<VoiceSttBackend, 'auto'>> = [];
  const fallbackCandidates = Array.from(
    new Set([...deduped, ...listVoiceSttAdapters().map((adapter) => adapter.backend)])
  ).filter((backend): backend is Exclude<VoiceSttBackend, 'auto'> => backend !== 'auto');
  for (const backend of fallbackCandidates) {
    const adapter = resolveVoiceSttAdapter(backend);
    const isAvailable =
      adapter.adapter_id === 'openai_compatible_server'
        ? availability.server
        : adapter.adapter_id === 'fluid_audio_native'
          ? availability.fluidAudio === true
          : adapter.adapter_id === 'managed_python_bridge'
            ? availability.mlxWhisper === true
            : adapter.adapter_id === 'whisper_cpp_cli'
              ? availability.whisperCpp
              : adapter.adapter_id === 'native_speech'
                ? availability.nativeSpeech
                : false;
    if (isAvailable && !fallback.includes(backend)) fallback.push(backend);
  }
  return fallback;
}
