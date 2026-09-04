import { describe, expect, it } from 'vitest';

import {
  parseBrowserState,
  parseOnboardingApply,
  parseOnboardingPreview,
  parseVoiceSample,
  parseVoiceSelection,
} from './onboarding-response.js';

const reasoningCandidate = {
  provider: 'codex-cli',
  display_name: 'Codex CLI',
  status: 'ready',
  selectable: true,
  model_ids: ['gpt-5'],
  capabilities: ['reasoning'],
  reason: 'Ready.',
};

const browserState = {
  ok: true,
  identity: { name: 'Operator', language: 'ja', interaction_style: 'Senior Partner' },
  vision: 'Operate safely.',
  agent_identity: { agent_id: 'KYBERION-PRIME' },
  onboarding: {
    services: [{ service_id: 'github', auth_mode: 'oauth', required: false }],
    voice: { engine_id: 'local_say' },
  },
  providers: { priority: ['claude', 'codex'], default_models: { codex: 'gpt-5' } },
  reasoning_selection: {
    preferences: { version: '1.0.0', provider: 'codex-cli', model_id: 'gpt-5' },
    candidates: [reasoningCandidate],
  },
  adapter_defaults: {
    categories: [
      {
        key: 'voice.vad',
        display_name: 'Voice activity detector',
        selected_id: 'native',
        candidates: [
          {
            id: 'native',
            display_name: 'Native VAD',
            status: 'ready',
            selectable: true,
            reason: 'Ready.',
          },
        ],
      },
    ],
  },
  tools: {},
  voice_profiles: [],
  service_bindings: [],
  allowed_services: ['github'],
  readiness: { microphone: { available: true, reason: 'Available.' } },
};

describe('presence studio onboarding response parsers', () => {
  it('accepts the server response shapes used by onboarding', () => {
    expect(
      parseOnboardingPreview({
        ok: true,
        draft: {},
        effects: [{ kind: 'identity', path: '/profile/my-identity.json', description: 'Update' }],
        warnings: [],
        blockers: [],
      })?.effects
    ).toHaveLength(1);
    expect(
      parseOnboardingApply({
        ok: true,
        applied_at: '2026-09-04T00:00:00.000Z',
        artifacts: ['/profile/onboarding/state.json'],
        warnings: [],
      })?.artifacts
    ).toHaveLength(1);
    expect(
      parseVoiceSample({
        sample_ref: '/profile/sample.webm',
        bytes: 12,
        content_type: 'audio/webm',
      })
    ).toMatchObject({ bytes: 12 });
    expect(
      parseVoiceSelection({
        ok: true,
        preferences: { tts_engine_id: 'local_say' },
        tts: {
          selected_engine_id: 'local_say',
          candidates: [
            {
              engine_id: 'local_say',
              display_name: 'Local Say',
              provider: 'native',
              status: 'ready',
              selectable: true,
            },
          ],
        },
      })?.tts.candidates
    ).toHaveLength(1);
    expect(parseBrowserState(browserState)).toBe(browserState);
  });

  it('rejects unsafe or malformed responses before projection', () => {
    const unsafe = JSON.parse('{"ok":true,"__proto__":{"polluted":true}}');
    expect(parseOnboardingApply(unsafe)).toBeUndefined();

    expect(
      parseOnboardingPreview({
        ok: true,
        draft: {},
        effects: [{ kind: 'identity', path: '/profile', description: 42 }],
        warnings: [],
        blockers: [],
      })
    ).toBeUndefined();

    expect(
      parseBrowserState({
        ...browserState,
        providers: { priority: ['codex'], default_models: { codex: 42 } },
      })
    ).toBeUndefined();

    expect(
      parseVoiceSelection({
        ok: true,
        preferences: { tts_engine_id: 'local_say' },
        tts: {
          selected_engine_id: 'local_say',
          candidates: [
            {
              engine_id: 'local_say',
              display_name: 'Local Say',
              provider: 'native',
              status: 'ready',
              selectable: 'yes',
            },
          ],
        },
      })
    ).toBeUndefined();
  });
});
