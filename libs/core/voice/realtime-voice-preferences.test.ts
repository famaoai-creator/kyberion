import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeReadFile, safeRmSync, safeWriteFile } from '../secure-io.js';
import { resetVoiceProfileRegistryCache } from './voice-profile-registry.js';

const profileRoot = vi.hoisted(() => ({ value: '' }));

vi.mock('../profile-root.js', () => ({
  resolveActiveProfileRoot: () => profileRoot.value,
}));

import {
  getRealtimeVoiceConversationPreferences,
  loadRealtimeVoiceConversationPreferences,
  getRealtimeVoiceConversationPreferencesPath,
  previewRealtimeVoiceConversationPreferences,
  type RealtimeVoiceConversationPreferencesPatch,
  saveRealtimeVoiceConversationPreferences,
} from './realtime-voice-preferences.js';
import { getVoiceProfileRecord } from './voice-profile-registry.js';

describe('realtime voice conversation preferences', () => {
  beforeEach(() => {
    profileRoot.value = pathResolver.sharedTmp(`realtime-voice-preferences-${process.pid}`);
    safeRmSync(profileRoot.value, { recursive: true, force: true });
    // Keep defaults independent from the checked-in personal overlay, which
    // otherwise changes the default profile in CI checkouts.
    vi.stubEnv(
      'KYBERION_PERSONAL_VOICE_PROFILE_REGISTRY_PATH',
      path.join(profileRoot.value, 'missing-personal-overlay.json')
    );
    resetVoiceProfileRegistryCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetVoiceProfileRegistryCache();
    safeRmSync(profileRoot.value, { recursive: true, force: true });
  });

  it('provides local-first defaults and persists model/voice changes through the schema', () => {
    const defaultVoiceProfileId = getVoiceProfileRecord().profile_id;
    expect(getRealtimeVoiceConversationPreferences()).toMatchObject({
      voice_profile_id: defaultVoiceProfileId,
      latency_profile: 'low_latency',
      personal_voice_mode: 'allow_fallback',
    });

    const saved = saveRealtimeVoiceConversationPreferences({
      voice_profile_id: defaultVoiceProfileId,
      language: 'ja',
      reasoning_model: 'gpt-5.6-luna',
      reasoning_model_tier: 'fast',
      reasoning_effort: 'low',
      latency_profile: 'low_latency',
    });
    expect(saved.reasoning_model).toBe('gpt-5.6-luna');
    expect(loadRealtimeVoiceConversationPreferences()).toEqual(saved);
  });

  it('round-trips interactive streaming defaults, including TTS argv, through the schema', () => {
    const saved = saveRealtimeVoiceConversationPreferences({
      streaming_stt_command: 'python',
      streaming_stt_args: 'stt.py,--language,ja',
      streaming_tts_command: 'python',
      streaming_tts_args: 'tts.py,--stream-framed',
      streaming_tts_play_command: 'ffplay,-nodisp,-autoexit',
      streaming_tts_sample_rate: 24000,
    });
    expect(loadRealtimeVoiceConversationPreferences()).toEqual(saved);
    expect(saved.streaming_tts_args).toBe('tts.py,--stream-framed');
  });

  it.each([
    'streaming_stt_command',
    'streaming_tts_command',
    'streaming_tts_play_command',
  ] as const)('rejects empty, whitespace, null and control characters for %s', (key) => {
    for (const value of ['', '  ', null, 'python\nother', 'python\u0000']) {
      expect(() =>
        saveRealtimeVoiceConversationPreferences({
          [key]: value,
        } as unknown as RealtimeVoiceConversationPreferencesPatch)
      ).toThrow();
    }
  });

  it.each(['streaming_stt_command', 'streaming_tts_command'] as const)(
    'rejects embedded executable whitespace for %s before save and preview',
    (key) => {
      for (const command of ['python worker.py', 'path' + String.fromCharCode(9) + 'python']) {
        const patch = { [key]: command };
        expect(() => saveRealtimeVoiceConversationPreferences(patch)).toThrow(
          'embedded whitespace'
        );
        expect(() => previewRealtimeVoiceConversationPreferences(patch)).toThrow(
          'embedded whitespace'
        );
        expect(loadRealtimeVoiceConversationPreferences()).toBeNull();
      }
    }
  );

  it('rejects playback argv without an executable and malformed optional args', () => {
    expect(() =>
      saveRealtimeVoiceConversationPreferences({
        streaming_tts_play_command: ' ,--rate,24000',
      })
    ).toThrow('requires an executable');
    for (const key of ['streaming_stt_args', 'streaming_tts_args'] as const) {
      expect(() =>
        saveRealtimeVoiceConversationPreferences({
          [key]: null,
        } as unknown as RealtimeVoiceConversationPreferencesPatch)
      ).toThrow('must be a string');
      expect(() =>
        saveRealtimeVoiceConversationPreferences({
          [key]: '--bad' + String.fromCharCode(10) + 'argument',
        })
      ).toThrow();
    }
  });

  it('validates previews without writes and removes optional defaults without changing other preferences', () => {
    const saved = saveRealtimeVoiceConversationPreferences({
      assistant_name: 'Aoi',
      streaming_stt_command: 'python',
      streaming_stt_args: '',
    });
    const file = getRealtimeVoiceConversationPreferencesPath();
    const before = String(safeReadFile(file));
    const proposed = previewRealtimeVoiceConversationPreferences({
      streaming_stt_command: undefined,
    });
    expect(proposed).not.toHaveProperty('streaming_stt_command');
    expect(proposed.assistant_name).toBe('Aoi');
    expect(String(safeReadFile(file))).toBe(before);
    const cleared = saveRealtimeVoiceConversationPreferences({
      streaming_stt_command: undefined,
    });
    expect(cleared).not.toHaveProperty('streaming_stt_command');
    expect(cleared.streaming_stt_args).toBe('');
    expect(cleared.voice_profile_id).toBe(saved.voice_profile_id);
    expect(loadRealtimeVoiceConversationPreferences()).toEqual(cleared);
  });

  it('rejects invalid persisted command settings instead of deferring failure to execution', () => {
    const preferences = saveRealtimeVoiceConversationPreferences({});
    const file = getRealtimeVoiceConversationPreferencesPath();
    safeWriteFile(file, JSON.stringify({ ...preferences, streaming_tts_command: '   ' }));
    expect(() => loadRealtimeVoiceConversationPreferences()).toThrow();
  });

  it('rejects an unknown voice profile instead of silently falling back', () => {
    expect(() =>
      saveRealtimeVoiceConversationPreferences({
        voice_profile_id: 'missing-profile',
      })
    ).toThrow('Unknown realtime voice profile');
  });
});
