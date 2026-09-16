import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeRmSync } from './secure-io.js';

const profileRoot = vi.hoisted(() => ({ value: '' }));

vi.mock('./profile-root.js', () => ({
  resolveActiveProfileRoot: () => profileRoot.value,
}));

import {
  getRealtimeVoiceConversationPreferences,
  loadRealtimeVoiceConversationPreferences,
  saveRealtimeVoiceConversationPreferences,
} from './realtime-voice-preferences.js';

describe('realtime voice conversation preferences', () => {
  beforeEach(() => {
    profileRoot.value = pathResolver.sharedTmp(`realtime-voice-preferences-${process.pid}`);
    safeRmSync(profileRoot.value, { recursive: true, force: true });
  });

  it('provides local-first defaults and persists model/voice changes through the schema', () => {
    expect(getRealtimeVoiceConversationPreferences()).toMatchObject({
      voice_profile_id: 'operator-ja-default',
      latency_profile: 'low_latency',
      personal_voice_mode: 'allow_fallback',
    });

    const saved = saveRealtimeVoiceConversationPreferences({
      voice_profile_id: 'operator-ja-default',
      language: 'ja',
      reasoning_model: 'gpt-5.6-luna',
      reasoning_model_tier: 'fast',
      reasoning_effort: 'low',
      latency_profile: 'low_latency',
    });
    expect(saved.reasoning_model).toBe('gpt-5.6-luna');
    expect(loadRealtimeVoiceConversationPreferences()).toEqual(saved);
  });

  it('rejects an unknown voice profile instead of silently falling back', () => {
    expect(() =>
      saveRealtimeVoiceConversationPreferences({ voice_profile_id: 'missing-profile' })
    ).toThrow('Unknown realtime voice profile');
  });
});
