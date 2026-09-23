import * as path from 'node:path';
import { defineCatalog } from './foundation/governed-catalog.js';
import { nowIso } from './foundation/time.js';

import { resolveActiveProfileRoot } from './profile-root.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeWriteFile,
} from './secure-io.js';
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
import { resolveVoiceTtsReadiness } from './voice-tts-readiness-adopters.js';
import {
  resolveVoiceSttAvailability,
  resolveVoiceSttReadinessAdopter,
} from './voice-stt-readiness-adopters.js';
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

const VOICE_SELECTION_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/voice-selection-preferences.schema.json'
);

function voiceSelectionCatalogAtPath(filePath: string) {
  return defineCatalog<VoiceSelectionPreferences>({
    id: 'voice-selection-preferences',
    path: filePath,
    schema: VOICE_SELECTION_SCHEMA_PATH,
  });
}

function selectionPath(): string {
  return assertSafeRepositoryPath(
    path.join(resolveActiveProfileRoot(), 'onboarding', 'voice-selection.json'),
    { allowMissingLeaf: true }
  );
}

function readPreferences(): VoiceSelectionPreferences | null {
  const filePath = selectionPath();
  if (!safeExistsSync(filePath)) return null;
  try {
    if (!safeLstat(filePath).isFile()) return null;
    const parsed = voiceSelectionCatalogAtPath(filePath).load();
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
  const readiness = resolveVoiceTtsReadiness(engine);
  let status: VoiceSelectionStatus = readiness.status;
  let reason = readiness.reason;
  const livePresence = engine.live_presence === true && adapter.live_presence;

  if (!livePresence) {
    status = 'unsupported';
    reason = engine.notes || reason;
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

function sttCandidates(availability: VoiceSttAvailability): VoiceSttSelectionCandidate[] {
  return [
    {
      backend: 'auto' as const,
      display_name: 'Auto (policy order)',
      adapter_id: 'policy',
      status: 'ready' as const,
      selectable: true,
      reason: 'Uses the configured fallback order and skips unavailable backends.',
    },
    ...listVoiceSttAdapters().map((adapter) => {
      const readinessAdopter = resolveVoiceSttReadinessAdopter(adapter);
      const available = readinessAdopter.availability_key
        ? availability[readinessAdopter.availability_key] === true
        : false;
      return {
        backend: adapter.backend,
        display_name: adapter.display_name,
        adapter_id: adapter.adapter_id,
        status: available ? ('ready' as const) : ('needs_setup' as const),
        selectable: available,
        reason: readinessAdopter.setup_message,
      };
    }),
  ];
}

export function getVoiceSelectionSnapshot(): VoiceSelectionSnapshot {
  const preferences = getPreferences();
  const availability = resolveVoiceSttAvailability();
  // Display only: the voice-hub listen path records the decision it acts on.
  const selectedOrder = resolveVoiceSttBackendOrder(
    preferences.stt_backend,
    availability,
    process.env,
    { record: false }
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

export function loadVoiceSelectionPreferences(): VoiceSelectionPreferences | null {
  try {
    return readPreferences();
  } catch {
    return null;
  }
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
  const validated = voiceSelectionCatalogAtPath(filePath).validate(
    {
      version: '1.0.0',
      tts_engine_id: nextTts,
      stt_backend: nextStt,
      updated_at: nowIso(),
    },
    filePath
  );
  safeWriteFile(filePath, JSON.stringify(validated, null, 2));
  return getVoiceSelectionSnapshot();
}
