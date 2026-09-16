import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeRmSync } from './secure-io.js';
import { resetVoiceProfileRegistryCache } from './voice-profile-registry.js';

const profileRoot = vi.hoisted(() => ({ value: '' }));

vi.mock('./profile-root.js', () => ({
  resolveActiveProfileRoot: () => profileRoot.value,
}));

import {
  getRealtimeVoiceConversationPreferences,
  loadRealtimeVoiceConversationPreferences,
  saveRealtimeVoiceConversationPreferences,
} from './realtime-voice-preferences.js';
import { getVoiceProfileRecord } from './voice-profile-registry.js';

describe('realtime voice conversation preferences', () => {
  beforeEach(() => {
    profileRoot.value = pathResolver.sharedTmp(`realtime-voice-preferences-${process.pid}`);
    safeRmSync(profileRoot.value, { recursive: true, force: true });
    // Keep defaults independent from the checked-in personal overlay, which
    // otherwise changes the default profile in CI checkouts.
    process.env.KYBERION_PERSONAL_VOICE_PROFILE_REGISTRY_PATH = path.join(
      profileRoot.value,
      'missing-personal-overlay.json'
    );
    resetVoiceProfileRegistryCache();
  });

  afterEach(() => {
    delete process.env.KYBERION_PERSONAL_VOICE_PROFILE_REGISTRY_PATH;
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

  it('rejects an unknown voice profile instead of silently falling back', () => {
    expect(() =>
      saveRealtimeVoiceConversationPreferences({ voice_profile_id: 'missing-profile' })
    ).toThrow('Unknown realtime voice profile');
  });
});
