import { describe, expect, it } from 'vitest';
import type { RealtimeVoiceConversationPreferences } from '@agent/core/voice/realtime-voice-preferences';
import {
  realtimeVoiceStreamingEnvironment,
  resolveRealtimeVoiceStreamingConfig,
} from './realtime-voice-streaming-config.js';

const preferences: RealtimeVoiceConversationPreferences = {
  version: '1.0.0',
  voice_profile_id: 'fixture',
  language: 'ja',
  assistant_name: 'Agent',
  latency_profile: 'low_latency',
  personal_voice_mode: 'allow_fallback',
  delivery_mode: 'none',
  streaming_stt_command: 'profile-stt',
  streaming_stt_args: '--json,--partial',
  streaming_tts_command: 'profile-tts',
  streaming_tts_args: '--raw,--stream',
  streaming_tts_sample_rate: 24000,
  streaming_tts_play_command: 'profile-player,--pcm',
};

describe('invocation-owned realtime streaming settings', () => {
  it('resolves saved defaults without changing the environment and uses the canonical Hz key', () => {
    const env = Object.freeze({ SENTINEL: 'unchanged' });
    const config = resolveRealtimeVoiceStreamingConfig(preferences, env);
    expect(config).toMatchObject({
      sttCommand: 'profile-stt',
      sttArgs: '--json,--partial',
      ttsCommand: 'profile-tts',
      ttsArgs: '--raw,--stream',
      ttsSampleRateHz: 24000,
      playbackCommand: ['profile-player', '--pcm'],
    });
    const bridgeEnv = realtimeVoiceStreamingEnvironment(config, env);
    expect(bridgeEnv.KYBERION_TTS_SAMPLE_RATE_HZ).toBe('24000');
    expect(bridgeEnv).not.toHaveProperty('KYBERION_TTS_SAMPLE_RATE');
    expect(env).toEqual({ SENTINEL: 'unchanged' });
  });

  it('keeps deployment environment values ahead of every saved default', () => {
    const env = Object.freeze({
      KYBERION_STT_COMMAND: 'env-stt',
      KYBERION_STT_ARGS: '--env',
      KYBERION_TTS_COMMAND: 'env-tts',
      KYBERION_TTS_ARGS: '--env-tts',
      KYBERION_TTS_SAMPLE_RATE_HZ: '48000',
      KYBERION_TTS_PLAY_COMMAND: 'env-player,--rate,48000',
    });
    expect(resolveRealtimeVoiceStreamingConfig(preferences, env)).toEqual({
      sttCommand: 'env-stt',
      sttArgs: '--env',
      ttsCommand: 'env-tts',
      ttsArgs: '--env-tts',
      ttsSampleRateHz: 48000,
      playbackCommand: ['env-player', '--rate', '48000'],
    });
  });

  it.each(['', '   '])('lets explicit empty args clear saved flags (%j)', (args) => {
    const config = resolveRealtimeVoiceStreamingConfig(preferences, {
      KYBERION_STT_ARGS: args,
      KYBERION_TTS_ARGS: args,
    });
    expect(config.sttArgs).toBe('');
    expect(config.ttsArgs).toBe('');
    const env = realtimeVoiceStreamingEnvironment(config, {});
    expect(env.KYBERION_STT_ARGS).toBe('');
    expect(env.KYBERION_TTS_ARGS).toBe('');
  });

  it('re-resolves new defaults and a reset without retaining the previous invocation', () => {
    const env = Object.freeze({});
    const first = resolveRealtimeVoiceStreamingConfig(preferences, env);
    const next = resolveRealtimeVoiceStreamingConfig(
      { ...preferences, streaming_stt_command: 'replacement' },
      env
    );
    const reset = resolveRealtimeVoiceStreamingConfig(null, env);
    expect(first.sttCommand).toBe('profile-stt');
    expect(next.sttCommand).toBe('replacement');
    expect(reset.sttCommand).toBeUndefined();
    expect(reset.ttsCommand).toBeUndefined();
    expect(env).toEqual({});
  });

  it('retains the existing governed fallback for invalid deployment sample rates', () => {
    expect(
      resolveRealtimeVoiceStreamingConfig(preferences, { KYBERION_TTS_SAMPLE_RATE_HZ: '22050' })
        .ttsSampleRateHz
    ).toBe(16000);
  });
});
