import type { VoiceEngineRecord } from './voice-engine-registry.js';
import type { VoiceSttAvailability, VoiceSttBackend } from './voice-stt.js';
import { getSpeechToTextBridges } from './speech-to-text-bridge.js';

/**
 * Stable execution contracts shared by voice surfaces.
 *
 * Engine IDs belong in governance data. Runtime code should resolve an adapter
 * from the engine/backend descriptor and only branch on adapter capabilities.
 * Adding another engine that uses an existing adapter therefore requires no
 * change to voice-hub or Presence Studio.
 */
export type VoiceTtsAdapterId = 'native_tts' | 'python_bridge' | 'unsupported';
export type VoiceSttAdapterId =
  | 'native_speech'
  | 'fluid_audio_native'
  | 'faster_whisper_python'
  | 'managed_python_bridge'
  | 'whisper_cpp_cli'
  | 'openai_compatible_server'
  | 'speech_to_text_bridge'
  | 'unsupported'
  | (string & {});

export interface VoiceTtsAdapterDescriptor {
  adapter_id: VoiceTtsAdapterId;
  display_name: string;
  live_presence: boolean;
}

export interface VoiceSttAdapterDescriptor {
  backend: VoiceSttBackend;
  adapter_id: VoiceSttAdapterId;
  display_name: string;
  runtime_id?: string;
  bridge_script?: string;
  cli_path?: string;
  model_path?: string;
  availability_key?: keyof VoiceSttAvailability;
  setup_guidance?: string;
}

const TTS_ADAPTERS: Record<VoiceTtsAdapterId, VoiceTtsAdapterDescriptor> = {
  native_tts: {
    adapter_id: 'native_tts',
    display_name: 'Host native TTS adapter',
    live_presence: true,
  },
  python_bridge: {
    adapter_id: 'python_bridge',
    display_name: 'Governed Python bridge adapter',
    live_presence: true,
  },
  unsupported: {
    adapter_id: 'unsupported',
    display_name: 'Unsupported voice adapter',
    live_presence: false,
  },
};

const STT_ADAPTERS: Partial<Record<VoiceSttBackend, VoiceSttAdapterDescriptor>> = {
  auto: {
    backend: 'auto',
    adapter_id: 'unsupported',
    display_name: 'Automatic backend selection',
  },
  server: {
    backend: 'server',
    adapter_id: 'openai_compatible_server',
    display_name: 'Hosted / OpenAI-compatible server',
    availability_key: 'server',
    setup_guidance: 'Set VOICE_HUB_STT_BASE_URL or a provider-specific STT URL.',
  },
  mlx_whisper: {
    backend: 'mlx_whisper',
    adapter_id: 'managed_python_bridge',
    display_name: 'mlx-whisper managed Python bridge',
    availability_key: 'mlxWhisper',
    setup_guidance: 'Uses the managed mlx-whisper runtime on Apple Silicon.',
    runtime_id: 'mlx_whisper',
    bridge_script: 'libs/actuators/voice-actuator/scripts/mlx_audio_stt_bridge.py',
  },
  fluid_audio: {
    backend: 'fluid_audio',
    adapter_id: 'fluid_audio_native',
    display_name: 'FluidAudio Parakeet native bridge',
    availability_key: 'fluidAudio',
    setup_guidance:
      'Set KYBERION_FLUID_AUDIO_STT_COMMAND to a local FluidAudio/Parakeet JSON bridge command.',
  },
  faster_whisper: {
    backend: 'faster_whisper',
    adapter_id: 'faster_whisper_python',
    display_name: 'faster-whisper Windows Python bridge',
    availability_key: 'fasterWhisper',
    setup_guidance:
      'Set KYBERION_WINDOWS_STT_BACKEND=faster_whisper and install faster-whisper in the selected Python runtime.',
    runtime_id: 'faster_whisper',
    bridge_script: 'libs/actuators/voice-actuator/scripts/faster_whisper_stt_bridge.py',
  },
  whisper_cpp: {
    backend: 'whisper_cpp',
    adapter_id: 'whisper_cpp_cli',
    display_name: 'whisper.cpp CLI adapter',
    availability_key: 'whisperCpp',
    setup_guidance: 'Requires the configured whisper.cpp CLI and model.',
    cli_path: 'active/shared/tmp/whisper.cpp/build/bin/whisper-cli',
    model_path: 'active/shared/tmp/whisper.cpp/models/ggml-small.bin',
  },
  native_speech: {
    backend: 'native_speech',
    adapter_id: 'native_speech',
    display_name: 'Host native speech adapter',
    availability_key: 'nativeSpeech',
    setup_guidance: 'Uses the host OS speech API and microphone permission.',
  },
};

export function resolveVoiceTtsAdapter(
  engine: Pick<VoiceEngineRecord, 'tts_adapter_id' | 'bridge_script' | 'supports'>
): VoiceTtsAdapterDescriptor {
  const declared = engine.tts_adapter_id?.trim() as VoiceTtsAdapterId | undefined;
  if (declared) {
    const adapter = TTS_ADAPTERS[declared];
    if (adapter) return adapter;
    return engine.bridge_script ? TTS_ADAPTERS.python_bridge : TTS_ADAPTERS.unsupported;
  }
  if (engine.bridge_script) return TTS_ADAPTERS.python_bridge;
  if (engine.supports.playback) return TTS_ADAPTERS.native_tts;
  return TTS_ADAPTERS.unsupported;
}

export function resolveVoiceSttAdapter(backend: VoiceSttBackend): VoiceSttAdapterDescriptor {
  const configured = STT_ADAPTERS[backend];
  if (configured) return configured;
  const bridge = getSpeechToTextBridges().find((entry) => entry.name === backend);
  if (bridge) {
    return {
      backend,
      adapter_id: 'speech_to_text_bridge',
      display_name: bridge.name,
    };
  }
  return {
    backend,
    adapter_id: 'unsupported',
    display_name: `Unsupported STT backend: ${backend}`,
  };
}

export function listVoiceSttAdapters(): VoiceSttAdapterDescriptor[] {
  const configured = Object.values(STT_ADAPTERS).filter(
    (descriptor): descriptor is VoiceSttAdapterDescriptor =>
      Boolean(descriptor) && descriptor.backend !== 'auto'
  );
  const configuredIds = new Set(configured.map((descriptor) => descriptor.backend));
  const registered = getSpeechToTextBridges()
    .filter((bridge) => bridge.name !== 'stub' && !configuredIds.has(bridge.name))
    .map((bridge) => ({
      backend: bridge.name,
      adapter_id: 'speech_to_text_bridge' as const,
      display_name: bridge.name,
    }));
  return [...configured, ...registered];
}
