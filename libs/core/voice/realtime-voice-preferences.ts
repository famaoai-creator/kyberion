import * as path from 'node:path';
import { nowIso } from '../foundation/time.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { pathResolver } from '../path-resolver.js';
import { resolveActiveProfileRoot } from '../profile-root.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeWriteFile,
} from '../secure-io.js';
import { getVoiceProfileRecord, listVoiceProfiles } from './voice-profile-registry.js';

export type RealtimeVoiceLatencyProfile = 'low_latency' | 'balanced';
export type RealtimeVoiceReasoningTier = 'fast' | 'standard' | 'deep';
export type RealtimeVoiceReasoningEffort = 'low' | 'medium' | 'high';
export type RealtimeVoicePersonalVoiceMode = 'allow_fallback' | 'require_personal_voice';
export type RealtimeVoiceDeliveryMode = 'none' | 'artifact' | 'artifact_and_playback';

/**
 * Operator-owned defaults for the reusable realtime voice conversation front.
 * Session transcripts remain separate: changing this file affects new
 * sessions and the reasoning options of subsequent turns, not old evidence.
 */
export interface RealtimeVoiceConversationPreferences {
  version: '1.0.0';
  voice_profile_id: string;
  language: string;
  assistant_name: string;
  system_prompt?: string;
  latency_profile: RealtimeVoiceLatencyProfile;
  reasoning_model?: string;
  reasoning_model_tier?: RealtimeVoiceReasoningTier;
  reasoning_effort?: RealtimeVoiceReasoningEffort;
  personal_voice_mode: RealtimeVoicePersonalVoiceMode;
  delivery_mode: RealtimeVoiceDeliveryMode;
  /**
   * Defaults for interactive streaming only. Resolve these per invocation;
   * explicit environment values win. Never seed process.env or batch STT
   * settings from these preferences.
   */
  streaming_stt_command?: string;
  streaming_stt_args?: string;
  streaming_tts_command?: string;
  streaming_tts_args?: string;
  streaming_tts_play_command?: string;
  streaming_tts_sample_rate?: 16000 | 24000 | 48000;
  updated_at?: string;
}

export type RealtimeVoiceConversationPreferencesPatch = Partial<
  Omit<RealtimeVoiceConversationPreferences, 'version' | 'updated_at'>
>;

const PREFERENCES_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/realtime-voice-conversation-preferences.schema.json'
);

function preferencesPath(): string {
  return assertSafeRepositoryPath(
    path.join(resolveActiveProfileRoot(), 'onboarding', 'realtime-voice.json'),
    { allowMissingLeaf: true }
  );
}

function preferencesCatalogAtPath(filePath: string) {
  return defineCatalog<RealtimeVoiceConversationPreferences>({
    id: 'realtime-voice-conversation-preferences',
    path: filePath,
    schema: PREFERENCES_SCHEMA_PATH,
  });
}

function assertKnownVoiceProfile(profileId: string): void {
  if (!listVoiceProfiles('all').some((profile) => profile.profile_id === profileId)) {
    throw new Error(`Unknown realtime voice profile: ${profileId}`);
  }
}

function defaultPreferences(): RealtimeVoiceConversationPreferences {
  const profile = getVoiceProfileRecord();
  if (profile.status !== 'active') {
    throw new Error('The default voice profile is not active for realtime conversation');
  }
  return {
    version: '1.0.0',
    voice_profile_id: profile.profile_id,
    language: profile.languages[0] || 'ja',
    assistant_name: 'Kyberion',
    latency_profile: 'low_latency',
    personal_voice_mode: 'allow_fallback',
    delivery_mode: 'artifact_and_playback',
  };
}

function hasCommandControlCharacters(value: string): boolean {
  return value.includes('\u0000') || value.includes('\r') || value.includes('\n');
}

function validatePreferences(value: RealtimeVoiceConversationPreferences): void {
  assertKnownVoiceProfile(value.voice_profile_id);
  if (!value.language.trim()) throw new Error('Realtime voice language must not be empty');
  if (!value.assistant_name.trim())
    throw new Error('Realtime voice assistant name must not be empty');
  for (const key of [
    'streaming_stt_command',
    'streaming_tts_command',
    'streaming_tts_play_command',
  ] as const) {
    const command = value[key];
    if (command === undefined) continue;
    if (typeof command !== 'string' || !command.trim() || hasCommandControlCharacters(command)) {
      throw new Error(key + ' must be a non-empty command without NUL or line breaks');
    }
    if (key !== 'streaming_tts_play_command' && /\s/u.test(command.trim())) {
      throw new Error(
        key +
          ' must name one executable without embedded whitespace; configure arguments separately'
      );
    }
    if (key === 'streaming_tts_play_command' && !command.split(',')[0]?.trim()) {
      throw new Error(key + ' requires an executable before comma-separated arguments');
    }
  }
  for (const key of ['streaming_stt_args', 'streaming_tts_args'] as const) {
    const args = value[key];
    if (args !== undefined && (typeof args !== 'string' || hasCommandControlCharacters(args))) {
      throw new Error(key + ' must be a string without NUL or line breaks');
    }
  }
  if (value.reasoning_model !== undefined && !value.reasoning_model.trim()) {
    throw new Error('Realtime voice reasoning model must not be empty');
  }
}

export function getRealtimeVoiceConversationPreferencesPath(): string {
  return preferencesPath();
}

export function loadRealtimeVoiceConversationPreferences(): RealtimeVoiceConversationPreferences | null {
  const filePath = preferencesPath();
  if (!safeExistsSync(filePath)) return null;
  if (!safeLstat(filePath).isFile()) {
    throw new Error(`Realtime voice preferences must be a regular file: ${filePath}`);
  }
  const preferences = preferencesCatalogAtPath(filePath).load();
  validatePreferences(preferences);
  return preferences;
}

export function getRealtimeVoiceConversationPreferences(): RealtimeVoiceConversationPreferences {
  return loadRealtimeVoiceConversationPreferences() || defaultPreferences();
}

/** Validate a proposed update exactly as save does, without writing profile state. */
export function previewRealtimeVoiceConversationPreferences(
  patch: RealtimeVoiceConversationPreferencesPatch
): RealtimeVoiceConversationPreferences {
  const next: RealtimeVoiceConversationPreferences = {
    ...getRealtimeVoiceConversationPreferences(),
    ...patch,
    version: '1.0.0',
    updated_at: nowIso(),
  };
  // An explicit undefined removes an optional setting; it must not remain as
  // an own property in the returned object or become a stale runtime default.
  for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
    if (patch[key] === undefined) delete (next as unknown as Record<string, unknown>)[key];
  }
  validatePreferences(next);
  const filePath = preferencesPath();
  return preferencesCatalogAtPath(filePath).validate(next, filePath);
}

export function saveRealtimeVoiceConversationPreferences(
  patch: RealtimeVoiceConversationPreferencesPatch
): RealtimeVoiceConversationPreferences {
  const validated = previewRealtimeVoiceConversationPreferences(patch);
  const filePath = preferencesPath();
  safeMkdir(path.dirname(filePath), { recursive: true });
  safeWriteFile(filePath, JSON.stringify(validated, null, 2) + '\n');
  return validated;
}

/** Restore the safe, local-first conversation defaults. */
export function resetRealtimeVoiceConversationPreferences(): RealtimeVoiceConversationPreferences {
  const defaults = defaultPreferences();
  const filePath = preferencesPath();
  const validated = preferencesCatalogAtPath(filePath).validate(
    { ...defaults, updated_at: nowIso() },
    filePath
  );
  safeMkdir(path.dirname(filePath), { recursive: true });
  safeWriteFile(filePath, JSON.stringify(validated, null, 2) + '\n');
  return validated;
}
