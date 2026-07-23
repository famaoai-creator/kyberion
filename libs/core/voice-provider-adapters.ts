import type { VoiceEngineRecord } from './voice-engine-registry.js';
import type { VoiceSttBackend } from './voice-stt.js';

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
  | 'managed_python_bridge'
  | 'whisper_cpp_cli'
  | 'openai_compatible_server'
  | 'unsupported';

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

const STT_ADAPTERS: Record<VoiceSttBackend, VoiceSttAdapterDescriptor> = {
  auto: {
    backend: 'auto',
    adapter_id: 'unsupported',
    display_name: 'Automatic backend selection',
  },
  server: {
    backend: 'server',
    adapter_id: 'openai_compatible_server',
    display_name: 'Hosted / OpenAI-compatible server',
  },
  mlx_whisper: {
    backend: 'mlx_whisper',
    adapter_id: 'managed_python_bridge',
    display_name: 'mlx-whisper managed Python bridge',
    runtime_id: 'mlx_whisper',
    bridge_script: 'libs/actuators/voice-actuator/scripts/mlx_audio_stt_bridge.py',
  },
  fluid_audio: {
    backend: 'fluid_audio',
    adapter_id: 'fluid_audio_native',
    display_name: 'FluidAudio Parakeet native bridge',
  },
  whisper_cpp: {
    backend: 'whisper_cpp',
    adapter_id: 'whisper_cpp_cli',
    display_name: 'whisper.cpp CLI adapter',
    cli_path: 'active/shared/tmp/whisper.cpp/build/bin/whisper-cli',
    model_path: 'active/shared/tmp/whisper.cpp/models/ggml-small.bin',
  },
  native_speech: {
    backend: 'native_speech',
    adapter_id: 'native_speech',
    display_name: 'Host native speech adapter',
  },
};

export function resolveVoiceTtsAdapter(
  engine: Pick<VoiceEngineRecord, 'tts_adapter_id' | 'bridge_script' | 'supports'>
): VoiceTtsAdapterDescriptor {
  const declared = engine.tts_adapter_id?.trim() as VoiceTtsAdapterId | undefined;
  if (declared) return TTS_ADAPTERS[declared] || TTS_ADAPTERS.unsupported;
  if (engine.bridge_script) return TTS_ADAPTERS.python_bridge;
  if (engine.supports.playback) return TTS_ADAPTERS.native_tts;
  return TTS_ADAPTERS.unsupported;
}

export function resolveVoiceSttAdapter(backend: VoiceSttBackend): VoiceSttAdapterDescriptor {
  return (
    STT_ADAPTERS[backend] || {
      backend,
      adapter_id: 'unsupported',
      display_name: `Unsupported STT backend: ${backend}`,
    }
  );
}

export function listVoiceSttAdapters(): VoiceSttAdapterDescriptor[] {
  return Object.values(STT_ADAPTERS).filter((descriptor) => descriptor.backend !== 'auto');
}
