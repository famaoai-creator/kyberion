import * as path from 'node:path';

import { resolveActiveProfileRoot } from './profile-root.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeWriteFile } from './secure-io.js';
import { getVoiceProfileRecord } from './voice-profile-registry.js';
import {
  getVoiceEngineRegistry,
  listVoiceEngines,
  resolveVoiceEngineForPlatform,
  type VoiceEngineRecord,
} from './voice-engine-registry.js';
import {
  parseVoiceSttBackend,
  resolveVoiceSttBackendOrder,
  type VoiceSttAvailability,
  type VoiceSttBackend,
} from './voice-stt.js';
import { hasBuiltInTts } from './native-tts.js';
import { probeToolRuntime } from './tool-runtime-registry.js';
import { pathResolver } from './path-resolver.js';
import { listVoiceSttAdapters, resolveVoiceTtsAdapter } from './voice-provider-adapters.js';

export interface VoiceSelectionPreferences {
  version: '1.0.0';
  tts_engine_id: string;
  stt_backend: VoiceSttBackend;
  updated_at?: string;
}

export type VoiceSelectionStatus = 'ready' | 'needs_setup' | 'unsupported';

export interface VoiceTtsSelectionCandidate {
  engine_id: string;
  display_name: string;
  provider: string;
  status: VoiceSelectionStatus;
  selectable: boolean;
  live_presence: boolean;
  adapter_id: string;
  fallback_engine_id?: string;
  reason?: string;
  supports: VoiceEngineRecord['supports'];
}

export interface VoiceSttSelectionCandidate {
  backend: VoiceSttBackend;
  display_name: string;
  adapter_id: string;
  status: VoiceSelectionStatus;
  selectable: boolean;
  reason?: string;
}

export interface VoiceSelectionSnapshot {
  preferences: VoiceSelectionPreferences;
  storage_path: string;
  tts: {
    selected_engine_id: string;
    candidates: VoiceTtsSelectionCandidate[];
  };
  stt: {
    selected_backend: VoiceSttBackend;
    selected_order: Array<Exclude<VoiceSttBackend, 'auto'>>;
    availability: VoiceSttAvailability;
    candidates: VoiceSttSelectionCandidate[];
  };
}

const DEFAULT_PREFERENCES: VoiceSelectionPreferences = {
  version: '1.0.0',
  tts_engine_id: 'local_say',
  stt_backend: 'auto',
};

function selectionPath(): string {
  return path.join(resolveActiveProfileRoot(), 'onboarding', 'voice-selection.json');
}

function readPreferences(): VoiceSelectionPreferences | null {
  const filePath = selectionPath();
  if (!safeExistsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(
      String(safeReadFile(filePath, { encoding: 'utf8' }))
    ) as Partial<VoiceSelectionPreferences>;
    const backend = parseVoiceSttBackend(parsed.stt_backend);
    if (typeof parsed.tts_engine_id !== 'string' || !parsed.tts_engine_id.trim()) return null;
    return {
      version: '1.0.0',
      tts_engine_id: parsed.tts_engine_id.trim(),
      stt_backend: backend,
      updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : undefined,
    };
  } catch {
    return null;
  }
}

function defaultPreferences(): VoiceSelectionPreferences {
  try {
    return {
      ...DEFAULT_PREFERENCES,
      tts_engine_id:
        getVoiceProfileRecord().default_engine_id || getVoiceEngineRegistry().default_engine_id,
    };
  } catch {
    return { ...DEFAULT_PREFERENCES, tts_engine_id: getVoiceEngineRegistry().default_engine_id };
  }
}

function getPreferences(): VoiceSelectionPreferences {
  return readPreferences() || defaultPreferences();
}

function resolveTtsCandidate(engine: VoiceEngineRecord): VoiceTtsSelectionCandidate {
  const adapter = resolveVoiceTtsAdapter(engine);
  let status: VoiceSelectionStatus = 'unsupported';
  let reason =
    'This engine is available to governed voice artifacts, but not live Presence replies yet.';
  const livePresence = engine.live_presence === true && adapter.live_presence;

  if (!livePresence) {
    reason = engine.notes || reason;
  } else if (adapter.adapter_id === 'native_tts') {
    status = hasBuiltInTts() ? 'ready' : 'needs_setup';
    reason = hasBuiltInTts()
      ? 'Uses the host OS voice without network access.'
      : 'Install the host OS TTS command before selecting this engine.';
  } else if (adapter.adapter_id === 'python_bridge') {
    const runtime = engine.runtime_id
      ? probeToolRuntime(engine.runtime_id, 'installed')
      : { installed: Boolean(engine.bridge_script) };
    status = runtime.installed ? 'ready' : 'needs_setup';
    reason = runtime.installed
      ? `Uses the governed ${engine.runtime_id || 'Python'} bridge adapter.`
      : `Prepare the ${engine.runtime_id || 'Python'} runtime before selecting this engine.`;
  }

  return {
    engine_id: engine.engine_id,
    display_name: engine.display_name,
    provider: engine.provider,
    status,
    selectable: livePresence && status === 'ready',
    live_presence: livePresence,
    adapter_id: adapter.adapter_id,
    fallback_engine_id: engine.fallback_engine_id,
    reason,
    supports: engine.supports,
  };
}

function resolveSttAvailability(): VoiceSttAvailability {
  const mlxWhisper = probeToolRuntime('mlx_whisper', 'installed');
  return {
    server: Boolean(
      process.env.VOICE_HUB_STT_BASE_URL?.trim() ||
      process.env.WHISPERKIT_BASE_URL?.trim() ||
      process.env.MLX_AUDIO_BASE_URL?.trim()
    ),
    mlxWhisper: mlxWhisper.installed,
    whisperCpp:
      safeExistsSync(pathResolver.resolve('active/shared/tmp/whisper.cpp/build/bin/whisper-cli')) &&
      safeExistsSync(pathResolver.resolve('active/shared/tmp/whisper.cpp/models/ggml-small.bin')),
    nativeSpeech:
      safeExistsSync(pathResolver.resolve('satellites/voice-hub/native-stt.swift')) &&
      (process.platform === 'darwin' ||
        process.platform === 'win32' ||
        process.platform === 'linux'),
  };
}

function sttCandidates(availability: VoiceSttAvailability): VoiceSttSelectionCandidate[] {
  const isAvailable = (backend: VoiceSttBackend): boolean => {
    if (backend === 'server') return availability.server;
    if (backend === 'mlx_whisper') return availability.mlxWhisper === true;
    if (backend === 'whisper_cpp') return availability.whisperCpp;
    if (backend === 'native_speech') return availability.nativeSpeech;
    return false;
  };
  const reasonFor = (backend: VoiceSttBackend): string => {
    if (backend === 'server') return 'Set VOICE_HUB_STT_BASE_URL or a provider-specific STT URL.';
    if (backend === 'mlx_whisper') return 'Uses the managed mlx-whisper runtime on Apple Silicon.';
    if (backend === 'whisper_cpp') return 'Requires the configured whisper.cpp CLI and model.';
    if (backend === 'native_speech')
      return 'Uses the host OS speech API and microphone permission.';
    return 'Uses the configured fallback order and skips unavailable backends.';
  };
  return [
    {
      backend: 'auto' as const,
      display_name: 'Auto (policy order)',
      adapter_id: 'policy',
      status: 'ready' as const,
      selectable: true,
      reason: reasonFor('auto'),
    },
    ...listVoiceSttAdapters().map((adapter) => ({
      backend: adapter.backend,
      display_name: adapter.display_name,
      adapter_id: adapter.adapter_id,
      status: isAvailable(adapter.backend) ? ('ready' as const) : ('needs_setup' as const),
      selectable: isAvailable(adapter.backend),
      reason: reasonFor(adapter.backend),
    })),
  ];
}

export function getVoiceSelectionSnapshot(): VoiceSelectionSnapshot {
  const preferences = getPreferences();
  const availability = resolveSttAvailability();
  const selectedOrder = resolveVoiceSttBackendOrder(
    preferences.stt_backend,
    availability,
    process.env
  );
  const engines = listVoiceEngines('active')
    .filter((engine) => {
      try {
        resolveVoiceEngineForPlatform(engine.engine_id);
        return true;
      } catch {
        return false;
      }
    })
    .map(resolveTtsCandidate);
  return {
    preferences,
    storage_path: selectionPath(),
    tts: {
      selected_engine_id: preferences.tts_engine_id,
      candidates: engines,
    },
    stt: {
      selected_backend: preferences.stt_backend,
      selected_order: selectedOrder,
      availability,
      candidates: sttCandidates(availability),
    },
  };
}

export function saveVoiceSelectionPreferences(input: {
  tts_engine_id?: unknown;
  stt_backend?: unknown;
}): VoiceSelectionSnapshot {
  const current = getPreferences();
  const nextTts =
    typeof input.tts_engine_id === 'string' && input.tts_engine_id.trim()
      ? input.tts_engine_id.trim()
      : current.tts_engine_id;
  const nextStt = parseVoiceSttBackend(input.stt_backend ?? current.stt_backend);
  const snapshot = getVoiceSelectionSnapshot();
  if (input.tts_engine_id !== undefined) {
    const tts = snapshot.tts.candidates.find((candidate) => candidate.engine_id === nextTts);
    if (!tts) throw new Error(`Unknown TTS engine: ${nextTts}`);
    if (!tts.selectable)
      throw new Error(
        `TTS engine '${nextTts}' is not ready for live Presence replies: ${tts.reason}`
      );
  }
  const stt = snapshot.stt.candidates.find((candidate) => candidate.backend === nextStt);
  if (!stt) throw new Error(`Unknown STT backend: ${nextStt}`);
  if (!stt.selectable) throw new Error(`STT backend '${nextStt}' is not available: ${stt.reason}`);

  const filePath = selectionPath();
  safeMkdir(path.dirname(filePath), { recursive: true });
  safeWriteFile(
    filePath,
    JSON.stringify(
      {
        version: '1.0.0',
        tts_engine_id: nextTts,
        stt_backend: nextStt,
        updated_at: new Date().toISOString(),
      },
      null,
      2
    )
  );
  return getVoiceSelectionSnapshot();
}

export function resetVoiceSelectionPreferencesCache(): void {
  // Preferences are intentionally read on each request so UI changes take effect without a restart.
}
