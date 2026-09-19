import { describe, expect, it } from 'vitest';
import {
  hasRequiredServiceConnectionValue,
  isServiceConnectionReady,
  isServiceConnectionRequired,
  loadServiceConnectionReadinessConfig,
} from './service-connection-readiness.js';

describe('service connection readiness', () => {
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

  it('loads the committed readiness catalog through its schema', () => {
    expect(loadServiceConnectionReadinessConfig()).toMatchObject({
      version: expect.any(String),
      required_services: {
        voice: { required_keys_any: expect.arrayContaining(['voice_name']) },
      },
    });
  });

  it('treats services without an explicit opt-out as required', () => {
    expect(isServiceConnectionRequired('voice')).toBe(true);
    expect(isServiceConnectionRequired('definitely-not-configured-service')).toBe(true);
  });

  it('treats the explicitly opted-out meeting service as not required', () => {
    expect(isServiceConnectionRequired('meeting')).toBe(false);
    expect(isServiceConnectionReady('meeting', {})).toBe(true);
  });
});
