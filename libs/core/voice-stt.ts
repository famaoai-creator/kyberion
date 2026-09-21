import { listVoiceSttAdapters, resolveVoiceSttAdapter } from './voice-provider-adapters.js';
import { getRegisteredEnvText } from './foundation/env.js';
import {
  explainSeamProviderDecision,
  listSeamSelectionPurposes,
  resolveSeamProviderDecision,
} from './seam-provider-selection.js';
import { matchSeamSelectionRule } from './seam-selection-rules.js';

export type VoiceSttBackend =
  | 'auto'
  | 'server'
  | 'fluid_audio'
  | 'faster_whisper'
  | 'mlx_whisper'
  | 'whisper_cpp'
  | 'native_speech';

export interface VoiceSttAvailability {
  server: boolean;
  fluidAudio?: boolean;
  fasterWhisper?: boolean;
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
  if (normalized === 'faster_whisper' || normalized === 'faster-whisper') return 'faster_whisper';
  if (normalized === 'mlx_whisper' || normalized === 'mlx-whisper') return 'mlx_whisper';
  if (normalized === 'whisper_cpp' || normalized === 'whisper.cpp') return 'whisper_cpp';
  if (normalized === 'native_speech' || normalized === 'native' || normalized === 'apple_speech')
    return 'native_speech';
  return 'auto';
}

export function resolveVoiceSttServerConfig(
  env: NodeJS.ProcessEnv = process.env
): VoiceSttServerConfig | null {
  const explicitBaseUrl = getRegisteredEnvText('VOICE_HUB_STT_BASE_URL', { env })?.trim();
  const whisperKitBaseUrl = getRegisteredEnvText('WHISPERKIT_BASE_URL', { env })?.trim();
  const mlxAudioBaseUrl = getRegisteredEnvText('MLX_AUDIO_BASE_URL', { env })?.trim();
  const baseUrl = explicitBaseUrl || whisperKitBaseUrl || mlxAudioBaseUrl;
  if (!baseUrl) return null;

  let provider: VoiceSttServerConfig['provider'] = 'openai_compatible_server';
  if (!explicitBaseUrl && whisperKitBaseUrl) provider = 'whisperkit_server';
  if (!explicitBaseUrl && !whisperKitBaseUrl && mlxAudioBaseUrl) provider = 'mlx_audio_server';

  const model =
    getRegisteredEnvText('VOICE_HUB_STT_MODEL', { env })?.trim() ||
    getRegisteredEnvText('WHISPERKIT_MODEL', { env })?.trim() ||
    getRegisteredEnvText('MLX_AUDIO_STT_MODEL', { env })?.trim() ||
    'openai_whisper-large-v3';
  const apiKey =
    getRegisteredEnvText('VOICE_HUB_STT_API_KEY', { env })?.trim() ||
    getRegisteredEnvText('WHISPERKIT_API_KEY', { env })?.trim() ||
    getRegisteredEnvText('MLX_AUDIO_API_KEY', { env })?.trim() ||
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

type ConcreteVoiceSttBackend = Exclude<VoiceSttBackend, 'auto'>;

export const VOICE_HUB_STT_SEAM = 'voice-hub-stt';

export interface VoiceSttOrderOptions {
  /** Governed purpose of the voice-hub-stt policy (accuracy, latency, privacy). */
  purpose?: string;
  /** Request facts operator rules may match on, e.g. { language: 'ja' }. */
  context?: Record<string, string>;
  /** Record the decision to the audit chain (default true); display-only callers pass false. */
  record?: boolean;
}

function isVoiceSttBackendAvailable(
  backend: ConcreteVoiceSttBackend,
  availability: VoiceSttAvailability
): boolean {
  const adapter = resolveVoiceSttAdapter(backend);
  if (adapter.adapter_id === 'openai_compatible_server') return availability.server;
  if (adapter.adapter_id === 'fluid_audio_native') return availability.fluidAudio === true;
  if (adapter.adapter_id === 'faster_whisper_python') return availability.fasterWhisper === true;
  if (adapter.adapter_id === 'managed_python_bridge') return availability.mlxWhisper === true;
  if (adapter.adapter_id === 'whisper_cpp_cli') return availability.whisperCpp;
  if (adapter.adapter_id === 'native_speech') return availability.nativeSpeech;
  return false;
}

/**
 * Seam-policy ordering for `auto` without an explicit preference: runs when a
 * purpose is given or an operator rule for voice-hub-stt matches. A purpose
 * ranks every available backend; an operator rule (or mission pin) puts its
 * providers first and keeps the platform order for the rest. Returns null
 * when the platform order stays (no purpose / no matching rule).
 */
function selectVoiceSttBackendOrder(
  baseOrder: ConcreteVoiceSttBackend[],
  availability: VoiceSttAvailability,
  options: VoiceSttOrderOptions
): ConcreteVoiceSttBackend[] | null {
  const purpose = options.purpose?.trim() || undefined;
  if (!purpose && !matchSeamSelectionRule(VOICE_HUB_STT_SEAM, { context: options.context })) {
    return null;
  }
  const ids = Array.from(
    new Set([...baseOrder, ...listVoiceSttAdapters().map((adapter) => adapter.backend)])
  ).filter((backend): backend is ConcreteVoiceSttBackend => backend !== 'auto');
  const candidates = ids.map((id) =>
    isVoiceSttBackendAvailable(id, availability)
      ? { id, eligible: true }
      : { id, eligible: false, unmet: ['not available (needs setup)'] }
  );
  const request = {
    seam: VOICE_HUB_STT_SEAM,
    candidates,
    ...(purpose ? { purpose } : {}),
    ...(options.context && Object.keys(options.context).length > 0
      ? { context: options.context }
      : {}),
    decisionKey: purpose || 'default',
  };
  const decision =
    options.record === false
      ? explainSeamProviderDecision(request)
      : resolveSeamProviderDecision(request);
  if (decision.strategy === 'unresolved') {
    const known = listSeamSelectionPurposes(VOICE_HUB_STT_SEAM);
    if (purpose && !known.includes(purpose)) {
      throw new Error(
        `[voice-stt] unknown purpose '${purpose}' for seam '${VOICE_HUB_STT_SEAM}' (known: ${known.join(', ')})`
      );
    }
    return null;
  }
  const ranked = decision.ranked as ConcreteVoiceSttBackend[];
  if (decision.strategy === 'purpose' || decision.strategy === 'fallback') return ranked;
  if (decision.strategy === 'default') return null;
  let leading: ConcreteVoiceSttBackend[] = [decision.provider_id as ConcreteVoiceSttBackend];
  if (decision.strategy === 'rule') {
    const rule = matchSeamSelectionRule(VOICE_HUB_STT_SEAM, request);
    const eligible = new Set(decision.eligible);
    const preferred = (rule?.prefer ?? []).filter((id) => eligible.has(id));
    if (preferred.length > 0) leading = preferred as ConcreteVoiceSttBackend[];
  }
  const rest = [...baseOrder, ...ranked].filter((id) => !leading.includes(id));
  return Array.from(new Set([...leading, ...rest]));
}

/**
 * Backend order for voice-hub STT. Explicit choices win: a requested backend
 * (request body or the operator's voice-selection preference), then
 * VOICE_HUB_STT_PREFERENCE. For `auto` without them, the voice-hub-stt seam
 * policy orders the backends when a purpose or operator rule applies;
 * otherwise the platform default order stays. Availability probes decide
 * eligibility in every case.
 */
export function resolveVoiceSttBackendOrder(
  requested: VoiceSttBackend,
  availability: VoiceSttAvailability,
  env: NodeJS.ProcessEnv = process.env,
  options: VoiceSttOrderOptions = {}
): Array<Exclude<VoiceSttBackend, 'auto'>> {
  if (requested !== 'auto') return [requested];

  const explicitPreference = getRegisteredEnvText('VOICE_HUB_STT_PREFERENCE', { env });
  const preference = (
    explicitPreference ||
    (process.platform === 'win32'
      ? 'server,faster_whisper,whisper_cpp,native_speech'
      : 'server,fluid_audio,mlx_whisper,whisper_cpp,native_speech')
  )
    .split(',')
    .map((item) => parseVoiceSttBackend(item))
    .filter((item): item is Exclude<VoiceSttBackend, 'auto'> => item !== 'auto');

  const deduped = Array.from(new Set(preference));
  const available = deduped.filter((backend) => isVoiceSttBackendAvailable(backend, availability));

  let baseOrder: ConcreteVoiceSttBackend[] = available;
  if (available.length === 0) {
    const fallback: ConcreteVoiceSttBackend[] = [];
    const fallbackCandidates = Array.from(
      new Set([...deduped, ...listVoiceSttAdapters().map((adapter) => adapter.backend)])
    ).filter((backend): backend is ConcreteVoiceSttBackend => backend !== 'auto');
    for (const backend of fallbackCandidates) {
      if (isVoiceSttBackendAvailable(backend, availability) && !fallback.includes(backend)) {
        fallback.push(backend);
      }
    }
    baseOrder = fallback;
  }

  if (!explicitPreference) {
    const selected = selectVoiceSttBackendOrder(baseOrder, availability, options);
    if (selected) return selected;
  }
  return baseOrder;
}
