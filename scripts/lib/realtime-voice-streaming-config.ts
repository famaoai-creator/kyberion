import { getRegisteredEnvText } from '@agent/core/foundation/env';
import type { RealtimeVoiceConversationPreferences } from '@agent/core/voice/realtime-voice-preferences';

/** Invocation-owned streaming settings. They never configure the file/batch STT path. */
export interface RealtimeVoiceStreamingConfig {
  sttCommand?: string;
  sttArgs?: string;
  ttsCommand?: string;
  ttsArgs?: string;
  ttsSampleRateHz?: 16000 | 24000 | 48000;
  playbackCommand?: readonly string[];
}

export function resolveRealtimeVoiceStreamingConfig(
  preferences: RealtimeVoiceConversationPreferences | null,
  env: NodeJS.ProcessEnv = process.env
): RealtimeVoiceStreamingConfig {
  const resolve = (name: string, fallback?: string): string | undefined =>
    getRegisteredEnvText(name, { env })?.trim() || fallback;
  const resolveArgs = (name: string, fallback?: string): string | undefined =>
    getRegisteredEnvText(name, { env, preserveEmpty: true })?.trim() ?? fallback;
  const rawRate = resolve(
    'KYBERION_TTS_SAMPLE_RATE_HZ',
    preferences?.streaming_tts_sample_rate?.toString()
  );
  const rate = rawRate ? Number.parseInt(rawRate, 10) : undefined;
  // Preserve the shell bridge's governed-rate fallback for invalid deployment envs.
  const sampleRate =
    rate === undefined ? undefined : [16000, 24000, 48000].includes(rate) ? rate : 16000;
  const playback = resolve('KYBERION_TTS_PLAY_COMMAND', preferences?.streaming_tts_play_command)
    ?.split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return {
    sttCommand: resolve('KYBERION_STT_COMMAND', preferences?.streaming_stt_command),
    sttArgs: resolveArgs('KYBERION_STT_ARGS', preferences?.streaming_stt_args),
    ttsCommand: resolve('KYBERION_TTS_COMMAND', preferences?.streaming_tts_command),
    ttsArgs: resolveArgs('KYBERION_TTS_ARGS', preferences?.streaming_tts_args),
    ttsSampleRateHz: sampleRate as RealtimeVoiceStreamingConfig['ttsSampleRateHz'],
    ...(playback?.length ? { playbackCommand: playback } : {}),
  };
}

/** Private bridge input, never assigned to process.env or passed to batch installers. */
export function realtimeVoiceStreamingEnvironment(
  config: RealtimeVoiceStreamingConfig,
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return {
    ...env,
    KYBERION_STT_COMMAND: config.sttCommand,
    KYBERION_STT_ARGS: config.sttArgs,
    KYBERION_TTS_COMMAND: config.ttsCommand,
    KYBERION_TTS_ARGS: config.ttsArgs,
    KYBERION_TTS_SAMPLE_RATE_HZ: config.ttsSampleRateHz?.toString(),
    KYBERION_TTS_PLAY_COMMAND: config.playbackCommand?.join(','),
  };
}
