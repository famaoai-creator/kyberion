import { describe, expect, it } from 'vitest';
import {
  parseVoiceSttBackend,
  resolveVoiceSttBackendOrder,
  resolveVoiceSttServerConfig,
} from './voice-stt.js';

describe('voice STT helpers', () => {
  it('parses backend aliases into canonical values', () => {
    expect(parseVoiceSttBackend('whisper.cpp')).toBe('whisper_cpp');
    expect(parseVoiceSttBackend('apple_speech')).toBe('native_speech');
    expect(parseVoiceSttBackend('server')).toBe('server');
    expect(parseVoiceSttBackend('unknown')).toBe('auto');
  });

  it('resolves a WhisperKit server configuration when present', () => {
    const config = resolveVoiceSttServerConfig({
      WHISPERKIT_BASE_URL: 'http://127.0.0.1:8080/',
      WHISPERKIT_MODEL: 'openai_whisper-large-v3',
    });

    expect(config).toEqual({
      baseUrl: 'http://127.0.0.1:8080',
      model: 'openai_whisper-large-v3',
      apiKey: undefined,
      provider: 'whisperkit_server',
    });
  });

  it('prefers explicit generic server settings over provider-specific env vars', () => {
    const config = resolveVoiceSttServerConfig({
      WHISPERKIT_BASE_URL: 'http://127.0.0.1:8080',
      VOICE_HUB_STT_BASE_URL: 'http://127.0.0.1:8000/',
      VOICE_HUB_STT_MODEL: 'mlx-community/whisper-large-v3-turbo-asr-fp16',
      VOICE_HUB_STT_API_KEY: 'secret',
    });

    expect(config).toEqual({
      baseUrl: 'http://127.0.0.1:8000',
      model: 'mlx-community/whisper-large-v3-turbo-asr-fp16',
      apiKey: 'secret',
      provider: 'openai_compatible_server',
    });
  });

  it('builds an automatic backend order from availability and preference', () => {
    const order = resolveVoiceSttBackendOrder(
      'auto',
      {
        server: false,
        whisperCpp: true,
        nativeSpeech: true,
      },
      {
        VOICE_HUB_STT_PREFERENCE: 'server,native_speech,whisper_cpp',
      },
    );

    expect(order).toEqual(['native_speech', 'whisper_cpp']);
  });

  it('returns the requested backend directly for explicit choices', () => {
    const order = resolveVoiceSttBackendOrder(
      'whisper_cpp',
      {
        server: true,
        whisperCpp: true,
        nativeSpeech: true,
      },
    );

    expect(order).toEqual(['whisper_cpp']);
  });
});
