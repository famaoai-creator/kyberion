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
  fallback_engine_id?: string;
  reason?: string;
  supports: VoiceEngineRecord['supports'];
}

export interface VoiceSttSelectionCandidate {
  backend: VoiceSttBackend;
  display_name: string;
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
  let status: VoiceSelectionStatus = 'unsupported';
  let reason =
    'This engine is available to governed voice artifacts, but not live Presence replies yet.';
  const livePresence = engine.engine_id === 'local_say' || engine.engine_id === 'mlx_audio_qwen3';

  if (engine.engine_id === 'local_say') {
    status = hasBuiltInTts() ? 'ready' : 'needs_setup';
    reason = hasBuiltInTts()
      ? 'Uses the host OS voice without network access.'
      : 'Install the host OS TTS command before selecting this engine.';
  } else if (engine.engine_id === 'mlx_audio_qwen3') {
    const runtime = probeToolRuntime('mlx_audio', 'installed');
    status = runtime.installed ? 'ready' : 'needs_setup';
    reason = runtime.installed
      ? 'Uses the managed mlx-audio runtime; voice cloning requires a profile sample.'
      : 'Run `pnpm voice:setup --apply` before selecting Qwen3-TTS.';
  }

  return {
    engine_id: engine.engine_id,
    display_name: engine.display_name,
    provider: engine.provider,
    status,
    selectable: livePresence && status === 'ready',
    live_presence: livePresence,
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
  const rows: Array<[VoiceSttBackend, string, boolean, string]> = [
    [
      'auto',
      'Auto (policy order)',
      true,
      'Uses the configured fallback order and skips unavailable backends.',
    ],
    [
      'server',
      'Hosted / OpenAI-compatible server',
      availability.server,
      'Set VOICE_HUB_STT_BASE_URL or a provider-specific STT URL.',
    ],
    [
      'mlx_whisper',
      'mlx-whisper (managed local)',
      availability.mlxWhisper === true,
      'Uses the managed mlx-whisper runtime on Apple Silicon.',
    ],
    [
      'whisper_cpp',
      'whisper.cpp',
      availability.whisperCpp,
      'Requires WHISPER_CLI_PATH and WHISPER_MODEL_PATH.',
    ],
    [
      'native_speech',
      'Native Speech',
      availability.nativeSpeech,
      'Uses the host OS speech API and microphone permission.',
    ],
  ];
  return rows.map(([backend, display_name, available, reason]) => ({
    backend,
    display_name,
    status: available ? 'ready' : 'needs_setup',
    selectable: available,
    reason,
  }));
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
