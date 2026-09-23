import { hasBuiltInTts } from './native-tts.js';
import { probeToolRuntime } from './tool-runtime-registry.js';
import type { VoiceEngineRecord } from './voice-engine-registry.js';
import { resolveVoiceTtsAdapter, type VoiceTtsAdapterId } from './voice-provider-adapters.js';

export interface VoiceTtsReadiness {
  status: 'ready' | 'needs_setup' | 'unsupported';
  reason: string;
}

interface VoiceTtsReadinessAdopter {
  readonly adapter_id: VoiceTtsAdapterId;
  probe(engine: VoiceEngineRecord): VoiceTtsReadiness;
}

const nativeTtsAdopter: VoiceTtsReadinessAdopter = {
  adapter_id: 'native_tts',
  probe() {
    const ready = hasBuiltInTts();
    return {
      status: ready ? 'ready' : 'needs_setup',
      reason: ready
        ? 'Uses the host OS voice without network access.'
        : 'Install the host OS TTS command before selecting this engine.',
    };
  },
};

const pythonBridgeAdopter: VoiceTtsReadinessAdopter = {
  adapter_id: 'python_bridge',
  probe(engine) {
    const runtime = engine.runtime_id
      ? probeToolRuntime(engine.runtime_id, 'installed')
      : { installed: Boolean(engine.bridge_script) };
    return {
      status: runtime.installed ? 'ready' : 'needs_setup',
      reason: runtime.installed
        ? `Uses the governed ${engine.runtime_id || 'Python'} bridge adapter.`
        : `Prepare the ${engine.runtime_id || 'Python'} runtime before selecting this engine.`,
    };
  },
};

const unsupportedTtsAdopter: VoiceTtsReadinessAdopter = {
  adapter_id: 'unsupported',
  probe(engine) {
    return {
      status: 'unsupported',
      reason:
        engine.notes ||
        'This engine is available to governed voice artifacts, but not live Presence replies yet.',
    };
  },
};

const VOICE_TTS_READINESS_ADOPTERS: Readonly<Record<VoiceTtsAdapterId, VoiceTtsReadinessAdopter>> =
  {
    native_tts: nativeTtsAdopter,
    python_bridge: pythonBridgeAdopter,
    unsupported: unsupportedTtsAdopter,
  };

export function resolveVoiceTtsReadiness(engine: VoiceEngineRecord): VoiceTtsReadiness {
  const adapter = resolveVoiceTtsAdapter(engine);
  return VOICE_TTS_READINESS_ADOPTERS[adapter.adapter_id].probe(engine);
}
