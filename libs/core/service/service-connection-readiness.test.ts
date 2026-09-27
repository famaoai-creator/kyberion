import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The readiness predicates consult the committed catalog; fixture injection
// keeps unit coverage of the required-service path independent of which
// services a given deployment opts out of. A null fixture falls through to
// the real catalog file so the committed-catalog contract stays covered.
const fixtureState = vi.hoisted(() => ({
  config: null as null | Record<string, unknown>,
}));
vi.mock('../foundation/governed-catalog.js', () => ({
  defineCatalog: (definition: { path: string }) => ({
    load: () =>
      fixtureState.config ??
      (JSON.parse(fs.readFileSync(definition.path, 'utf8')) as Record<string, unknown>),
    validate: (value: unknown) => value,
  }),
}));

import {
  hasRequiredServiceConnectionValue,
  isServiceConnectionReady,
  isServiceConnectionRequired,
  loadServiceConnectionReadinessConfig,
} from './service-connection-readiness.js';

const REQUIRED_FIXTURE = {
  version: 'test',
  required_services: {
    voice: { required_keys_any: ['voice_name', 'voice_python_bin'] },
    whisper: {
      required_keys_any: [
        'whisperkit_base_url',
        'whisperkit_cli_path',
        'whisper_cli_path',
        'whisper_python_bin',
        'apple_speech_available',
      ],
    },
    meeting: { required_keys_any: ['meeting_python_bin'], required: false },
  },
};

describe('service connection readiness', () => {
  beforeEach(() => {
    fixtureState.config = REQUIRED_FIXTURE;
  });

  it('does not treat an empty required value as ready', () => {
    expect(hasRequiredServiceConnectionValue({ voice_name: '' }, ['voice_name'])).toBe(false);
    expect(isServiceConnectionReady('voice', { voice_name: '' })).toBe(false);
  });

  it('accepts a non-empty required value', () => {
    expect(isServiceConnectionReady('voice', { voice_name: 'Kyoko' })).toBe(true);
  });

  it('accepts detected Apple Silicon STT backends as whisper connections', () => {
    expect(
      isServiceConnectionReady('whisper', {
        stt_backend: 'whisperkit_cli',
        whisperkit_cli_path: '/opt/homebrew/bin/whisperkit-cli',
      })
    ).toBe(true);
    expect(isServiceConnectionReady('whisper', { apple_speech_available: true })).toBe(true);
    expect(isServiceConnectionReady('whisper', { whisperkit_cli_path: '' })).toBe(false);
  });

  it('loads the committed readiness catalog', () => {
    fixtureState.config = null;
    const committed = loadServiceConnectionReadinessConfig();
    expect(committed).toMatchObject({ version: expect.any(String) });
    for (const rule of Object.values(committed?.required_services ?? {})) {
      expect(rule.required_keys_any?.length).toBeGreaterThan(0);
    }
  });

  it('treats services without an explicit opt-out as required', () => {
    expect(isServiceConnectionRequired('voice')).toBe(true);
    expect(isServiceConnectionRequired('definitely-not-configured-service')).toBe(true);
  });

  it('treats explicitly opted-out services as not required and vacuously ready', () => {
    expect(isServiceConnectionRequired('meeting')).toBe(false);
    expect(isServiceConnectionReady('meeting', {})).toBe(true);
  });
});
