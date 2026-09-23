import { getRegisteredEnvText } from './foundation/env.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync } from './secure-io.js';
import { probeToolRuntime } from './tool-runtime-registry.js';
import {
  listVoiceSttAdapters,
  type VoiceSttAdapterDescriptor,
  type VoiceSttAvailabilityKey,
} from './voice-provider-adapters.js';
import type { VoiceSttAvailability } from './voice-stt.js';

export interface VoiceSttReadinessAdopter {
  readonly adapter_id: string;
  readonly availability_key?: VoiceSttAvailabilityKey;
  readonly setup_message: string;
  isAvailable(adapter: VoiceSttAdapterDescriptor): boolean;
}

const serverAdopter: VoiceSttReadinessAdopter = {
  adapter_id: 'openai_compatible_server',
  availability_key: 'server',
  setup_message: 'Set VOICE_HUB_STT_BASE_URL or a provider-specific STT URL.',
  isAvailable() {
    return Boolean(
      getRegisteredEnvText('VOICE_HUB_STT_BASE_URL')?.trim() ||
      getRegisteredEnvText('WHISPERKIT_BASE_URL')?.trim() ||
      getRegisteredEnvText('MLX_AUDIO_BASE_URL')?.trim()
    );
  },
};

const fluidAudioAdopter: VoiceSttReadinessAdopter = {
  adapter_id: 'fluid_audio_native',
  availability_key: 'fluidAudio',
  setup_message:
    'Set KYBERION_FLUID_AUDIO_STT_COMMAND to a local FluidAudio/Parakeet JSON bridge command.',
  isAvailable() {
    return Boolean(
      process.platform === 'darwin' &&
      getRegisteredEnvText('KYBERION_FLUID_AUDIO_STT_COMMAND')?.trim()
    );
  },
};

const fasterWhisperAdopter: VoiceSttReadinessAdopter = {
  adapter_id: 'faster_whisper_python',
  availability_key: 'fasterWhisper',
  setup_message:
    'Set KYBERION_WINDOWS_STT_BACKEND=faster_whisper and install faster-whisper in the selected Python runtime.',
  isAvailable() {
    return Boolean(
      process.platform === 'win32' &&
      (getRegisteredEnvText('KYBERION_WINDOWS_STT_BACKEND') === 'faster_whisper' ||
        getRegisteredEnvText('KYBERION_STT_MODEL_DIR')?.trim())
    );
  },
};

const managedPythonAdopter: VoiceSttReadinessAdopter = {
  adapter_id: 'managed_python_bridge',
  availability_key: 'mlxWhisper',
  setup_message: 'Uses the managed mlx-whisper runtime on Apple Silicon.',
  isAvailable(adapter) {
    return Boolean(
      adapter.runtime_id && probeToolRuntime(adapter.runtime_id, 'installed').installed
    );
  },
};

const whisperCppAdopter: VoiceSttReadinessAdopter = {
  adapter_id: 'whisper_cpp_cli',
  availability_key: 'whisperCpp',
  setup_message: 'Requires the configured whisper.cpp CLI and model.',
  isAvailable(adapter) {
    return Boolean(
      adapter.cli_path &&
      adapter.model_path &&
      safeExistsSync(pathResolver.resolve(adapter.cli_path)) &&
      safeExistsSync(pathResolver.resolve(adapter.model_path))
    );
  },
};

const nativeSpeechAdopter: VoiceSttReadinessAdopter = {
  adapter_id: 'native_speech',
  availability_key: 'nativeSpeech',
  setup_message: 'Uses the host OS speech API and microphone permission.',
  isAvailable(adapter) {
    return Boolean(
      adapter.bridge_script &&
      safeExistsSync(pathResolver.resolve(adapter.bridge_script)) &&
      ['darwin', 'win32', 'linux'].includes(process.platform)
    );
  },
};

const VOICE_STT_READINESS_ADOPTERS: Readonly<Record<string, VoiceSttReadinessAdopter>> = {
  openai_compatible_server: serverAdopter,
  fluid_audio_native: fluidAudioAdopter,
  faster_whisper_python: fasterWhisperAdopter,
  managed_python_bridge: managedPythonAdopter,
  whisper_cpp_cli: whisperCppAdopter,
  native_speech: nativeSpeechAdopter,
};

export function resolveVoiceSttReadinessAdopter(
  adapter: VoiceSttAdapterDescriptor
): VoiceSttReadinessAdopter {
  return (
    VOICE_STT_READINESS_ADOPTERS[adapter.adapter_id] ?? {
      adapter_id: adapter.adapter_id,
      setup_message: 'No readiness adopter is registered for this adapter.',
      isAvailable: () => false,
    }
  );
}

export function resolveVoiceSttAvailability(): VoiceSttAvailability {
  const availability: Record<VoiceSttAvailabilityKey, boolean> = {
    server: false,
    fluidAudio: false,
    fasterWhisper: false,
    mlxWhisper: false,
    whisperCpp: false,
    nativeSpeech: false,
  };
  for (const adapter of listVoiceSttAdapters()) {
    const adopter = resolveVoiceSttReadinessAdopter(adapter);
    if (adopter.availability_key) {
      availability[adopter.availability_key] = adopter.isAvailable(adapter);
    }
  }
  return availability;
}
