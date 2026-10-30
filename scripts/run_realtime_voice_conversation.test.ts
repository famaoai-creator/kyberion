import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RealtimeVoiceConversationPreferences } from '@agent/core/voice/realtime-voice-preferences';
import { readFileSync } from 'node:fs';
import {
  registerSpeechToTextBridge,
  resetSpeechToTextBridge,
  type SpeechToTextBridge,
} from '@agent/core';
import {
  defaultBargeInMode,
  parseRecorderBridgeResponse,
  parseRealtimeVoiceConversationCli,
  resolveSpeculativeReplyGuards,
  runRealtimeVoiceConversationInteractive,
} from './run_realtime_voice_conversation.js';

const preferenceState = vi.hoisted(() => ({
  current: null as RealtimeVoiceConversationPreferences | null,
}));
vi.mock('@agent/core/voice/realtime-voice-preferences', async (original) => ({
  ...(await original<typeof import('@agent/core/voice/realtime-voice-preferences')>()),
  loadRealtimeVoiceConversationPreferences: () => preferenceState.current,
}));

describe('run_realtime_voice_conversation cli', () => {
  const previousSudo = process.env.KYBERION_SUDO;

  beforeEach(() => {
    preferenceState.current = null;
    for (const key of [
      'KYBERION_STT_COMMAND',
      'KYBERION_STT_ARGS',
      'KYBERION_TTS_COMMAND',
      'KYBERION_TTS_ARGS',
      'KYBERION_TTS_PLAY_COMMAND',
      'KYBERION_TTS_SAMPLE_RATE_HZ',
      'KYBERION_TTS_SAMPLE_RATE',
    ])
      vi.stubEnv(key, undefined);
    // These tests inject recorder/turn dependencies and never open a real mic.
    process.env.KYBERION_SUDO = 'true';
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetSpeechToTextBridge();
    if (previousSudo === undefined) delete process.env.KYBERION_SUDO;
    else process.env.KYBERION_SUDO = previousSudo;
  });

  function streamingPreferences(command: string): RealtimeVoiceConversationPreferences {
    return {
      version: '1.0.0',
      voice_profile_id: 'fixture',
      language: 'ja',
      assistant_name: 'Agent',
      latency_profile: 'low_latency',
      personal_voice_mode: 'allow_fallback',
      delivery_mode: 'none',
      streaming_stt_command: command,
      streaming_tts_command: 'stream-tts',
      streaming_tts_sample_rate: 24000,
    };
  }

  it('re-parses saved streaming settings and their reset without mutating process.env', () => {
    const args = { 'session-id': 'stream-pure', interactive: true, mission: 'MSN-STREAM-PURE' };
    preferenceState.current = streamingPreferences('first-stream');
    const first = parseRealtimeVoiceConversationCli(args);
    preferenceState.current = streamingPreferences('second-stream');
    const second = parseRealtimeVoiceConversationCli(args);
    preferenceState.current = null;
    const reset = parseRealtimeVoiceConversationCli(args);
    expect(first.streamingConfig?.sttCommand).toBe('first-stream');
    expect(second.streamingConfig?.sttCommand).toBe('second-stream');
    expect(reset.streamingConfig?.sttCommand).toBeUndefined();
    expect(process.env.KYBERION_STT_COMMAND).toBeUndefined();
    expect(process.env.KYBERION_TTS_SAMPLE_RATE_HZ).toBeUndefined();
    expect(process.env.KYBERION_TTS_SAMPLE_RATE).toBeUndefined();
  });

  it('does not seed saved commands into a failed parse or the batch/fixed command environment', () => {
    preferenceState.current = streamingPreferences('ndjson-stream-only');
    expect(() =>
      parseRealtimeVoiceConversationCli({
        'session-id': 'invalid',
        interactive: true,
        mission: 'MSN-INVALID',
        'record-seconds': -1,
      })
    ).toThrow('--record-seconds');
    parseRealtimeVoiceConversationCli({ 'session-id': 'batch', audio: 'package.json' });
    parseRealtimeVoiceConversationCli({
      'session-id': 'fixed',
      interactive: true,
      recorder: 'fixed',
      mission: 'MSN-FIXED',
    });
    expect(process.env.KYBERION_STT_COMMAND).toBeUndefined();
    expect(process.env.KYBERION_STT_ARGS).toBeUndefined();
    expect(process.env.KYBERION_TTS_COMMAND).toBeUndefined();
  });

  it('parses interactive mode and default record settings', () => {
    const parsed = parseRealtimeVoiceConversationCli({
      'session-id': 'rtc-1',
      interactive: true,
      'assistant-name': 'Kyberion',
      mission: 'MSN-CLI-TEST-001',
    });

    expect(parsed.sessionId).toBe('rtc-1');
    expect(parsed.interactive).toBe(true);
    expect(parsed.recorder).toBe('vad');
    expect(parsed.latencyProfile).toBe('low_latency');
    expect(parsed.recordSeconds).toBe(8);
    expect(parsed.maxUtteranceSeconds).toBe(30);
    expect(parsed.vadEndpointMs).toBe(500);
    expect(parsed.vadThresholdRms).toBeUndefined();
    expect(parsed.deliveryMode).toBe('artifact_and_playback');
    expect(parsed.personalVoiceMode).toBe('require_personal_voice');
    expect(parsed.bargeIn).toBe(false);
    expect(parsed.streamingStt).toBe(true);
    expect(parsed.warmActuator).toBe(true);
    expect(parsed.idleTimeoutSeconds).toBe(120);
    expect(parsed.speechSegmentChars).toBe(80);
    expect(parsed.mission).toBe('MSN-CLI-TEST-001');
    expect(parsed.vadBackend).toBeUndefined();
  });

  it('parses avatar-follow and tts-engine flags', () => {
    const parsed = parseRealtimeVoiceConversationCli({
      'session-id': 'rtc-avatar',
      interactive: true,
      'avatar-follow': true,
      'tts-engine': 'kokoro',
      mission: 'MSN-CLI-TEST-AVATAR',
    });
    expect(parsed.avatarFollow).toBe(true);
    expect(parsed.ttsEngine).toBe('kokoro');

    const defaults = parseRealtimeVoiceConversationCli({
      'session-id': 'rtc-avatar',
      interactive: true,
      mission: 'MSN-CLI-TEST-AVATAR',
    });
    expect(defaults.avatarFollow).toBe(false);
    expect(defaults.ttsEngine).toBeUndefined();
  });

  it('parses turn-taking flags and resolves the default barge-in mode', () => {
    const base = {
      'session-id': 'rtc-tt',
      interactive: true,
      mission: 'MSN-CLI-TEST-003',
    };
    const defaults = parseRealtimeVoiceConversationCli(base);
    expect(defaults.bargeInMode).toBeUndefined();
    expect(defaults.speculativeReply).toBeUndefined();
    expect(defaults.firstPhraseCache).toBe(false);
    expect(defaults.eotHold).toBe(true);
    expect(defaults.respondGate).toBe(true);
    expect(defaultBargeInMode(defaults, true)).toBe('two_stage');
    expect(defaultBargeInMode(defaults, false)).toBe('off');
    expect(defaultBargeInMode({ latencyProfile: 'balanced' }, true)).toBe('off');

    const explicit = parseRealtimeVoiceConversationCli({
      ...base,
      'barge-in-mode': 'two_stage',
      'speculative-reply': true,
      'first-phrase-cache': true,
      'eot-hold': false,
      'respond-gate': false,
    });
    expect(explicit.bargeInMode).toBe('two_stage');
    expect(explicit.speculativeReply).toBe(true);
    expect(explicit.firstPhraseCache).toBe(true);
    expect(explicit.eotHold).toBe(false);
    expect(explicit.respondGate).toBe(false);

    expect(parseRealtimeVoiceConversationCli({ ...base, 'barge-in': true }).bargeInMode).toBe(
      'legacy'
    );
    expect(parseRealtimeVoiceConversationCli({ ...base, 'barge-in': false }).bargeInMode).toBe(
      'off'
    );
    expect(() => parseRealtimeVoiceConversationCli({ ...base, 'barge-in-mode': 'always' })).toThrow(
      /--barge-in-mode/
    );
  });

  it('derives the speculative-reply guard from power source and backend cost tier', () => {
    expect(
      resolveSpeculativeReplyGuards({
        reasoningMode: 'claude-cli',
        detectPowerSource: () => 'battery',
      })
    ).toEqual({ powerSource: 'battery', costTier: 'free' });
    expect(
      resolveSpeculativeReplyGuards({ reasoningMode: 'anthropic', detectPowerSource: () => 'ac' })
    ).toEqual({ powerSource: 'ac', costTier: 'metered' });
    expect(
      resolveSpeculativeReplyGuards({ reasoningMode: null, detectPowerSource: () => 'unknown' })
        .costTier
    ).toBe('metered');
  });

  it('parses realtime loop flags', () => {
    const parsed = parseRealtimeVoiceConversationCli({
      'session-id': 'rtc-loop',
      interactive: true,
      'barge-in': true,
      'vad-backend': 'silero',
      'latency-profile': 'balanced',
      'streaming-stt': false,
      'warm-actuator': false,
      mission: 'MSN-CLI-TEST-002',
      'idle-timeout-seconds': 45,
    });
    expect(parsed.bargeIn).toBe(true);
    expect(parsed.vadBackend).toBe('silero');
    expect(parsed.latencyProfile).toBe('balanced');
    expect(parsed.vadEndpointMs).toBe(700);
    expect(parsed.speechSegmentChars).toBe(120);
    expect(parsed.streamingStt).toBe(false);
    expect(parsed.warmActuator).toBe(false);
    expect(parsed.mission).toBe('MSN-CLI-TEST-002');
    expect(parsed.idleTimeoutSeconds).toBe(45);

    expect(() =>
      parseRealtimeVoiceConversationCli({
        'session-id': 'rtc-loop',
        interactive: true,
        mission: 'MSN-CLI-TEST-002',
        'idle-timeout-seconds': 0,
      })
    ).toThrow(/--idle-timeout-seconds/);
    expect(() =>
      parseRealtimeVoiceConversationCli({
        'session-id': 'rtc-loop',
        interactive: true,
        mission: 'MSN-CLI-TEST-002',
        'speech-segment-chars': 0,
      })
    ).toThrow(/--speech-segment-chars/);
  });

  it('preserves fractional fixed-record durations instead of truncating them to zero', () => {
    const parsed = parseRealtimeVoiceConversationCli({
      'session-id': 'rtc-fractional-record',
      interactive: true,
      mission: 'MSN-CLI-TEST-FRACTIONAL',
      'record-seconds': 0.5,
    });

    expect(parsed.recordSeconds).toBe(0.5);
  });

  it('parses VAD recorder overrides and rejects invalid values', () => {
    const parsed = parseRealtimeVoiceConversationCli({
      'session-id': 'rtc-2',
      interactive: true,
      mission: 'MSN-CLI-TEST-003',
      'vad-threshold': 1200,
      'vad-endpoint-ms': 500,
      'max-utterance-seconds': 12,
      'mic-device': ':1',
    });
    expect(parsed.recorder).toBe('vad');
    expect(parsed.vadThresholdRms).toBe(1200);
    expect(parsed.vadEndpointMs).toBe(500);
    expect(parsed.maxUtteranceSeconds).toBe(12);
    expect(parsed.micDevice).toBe(':1');

    expect(() =>
      parseRealtimeVoiceConversationCli({
        'session-id': 'rtc-2',
        interactive: true,
        mission: 'MSN-CLI-TEST-003',
        recorder: 'neural',
      })
    ).toThrow(/--recorder/);
    expect(() =>
      parseRealtimeVoiceConversationCli({
        'session-id': 'rtc-2',
        interactive: true,
        mission: 'MSN-CLI-TEST-003',
        'vad-threshold': -5,
      })
    ).toThrow(/--vad-threshold/);
  });

  it('rejects custom recording paths outside the repository', () => {
    expect(() =>
      parseRealtimeVoiceConversationCli({
        'session-id': 'rtc-boundary',
        audio: 'active/shared/tmp/input.wav',
        'record-bridge-path': '../record_bridge.py',
      })
    ).toThrow('[RESOURCE_PATH_SCOPE]');
    expect(() =>
      parseRealtimeVoiceConversationCli({
        'session-id': 'rtc-boundary',
        interactive: true,
        mission: 'MSN-BOUNDARY-001',
        'record-output-dir': '../recordings',
      })
    ).toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('parses recorder bridge output at the external process boundary', () => {
    expect(
      parseRecorderBridgeResponse('progress\n{"status":"success","path":"/tmp/turn.wav"}')
    ).toEqual({ status: 'success', path: '/tmp/turn.wav' });
    expect(() => parseRecorderBridgeResponse('{"status":"success","path":42}')).toThrow(
      'recorder bridge response field path must be a string'
    );
    expect(() => parseRecorderBridgeResponse('{"status":"success","__proto__":{}}')).toThrow(
      /Could not find JSON payload/
    );
  });

  it('runs an injected interactive loop without touching real audio backends', async () => {
    const fakeStt: SpeechToTextBridge = {
      name: 'fake-stt',
      async transcribe() {
        return { text: '来週の予定教えて', backend: 'fake-stt' };
      },
    };
    registerSpeechToTextBridge(fakeStt);

    const recordCalls: number[] = [];
    const turnCalls: Array<{ audioPath: string; user_text: string }> = [];
    const output: string[] = [];

    await runRealtimeVoiceConversationInteractive(
      {
        sessionId: 'rtc-test',
        interactive: true,
        assistantName: 'Kyberion',
        surfaceId: 'presence-studio',
        sourceId: 'local-mic',
        deliveryMode: 'none',
        personalVoiceMode: 'allow_fallback',
        recorder: 'fixed',
        recordSeconds: 3,
        maxUtteranceSeconds: 30,
        vadEndpointMs: 700,
        bargeIn: false,
        streamingStt: true,
        warmActuator: true,
        idleTimeoutSeconds: 120,
        turns: 2,
        recordBridgePath: '/tmp/record_bridge.py',
        pythonBin: '/tmp/python3',
        recordOutputDir: '/tmp/realtime-voice',
      },
      {
        recordTurnAudio: async (turnIndex) => {
          recordCalls.push(turnIndex);
          return `/tmp/realtime-voice/turn-${String(turnIndex + 1).padStart(2, '0')}.wav`;
        },
        runTurn: async (input) => {
          turnCalls.push({ audioPath: input.audioPath, user_text: '来週の予定教えて' });
          return {
            session_id: input.sessionId,
            profile_id: input.profileId ?? 'default-profile',
            language: input.language ?? 'ja',
            user_text: '来週の予定教えて',
            assistant_text: '予定を確認します。',
            transcript_path: '/tmp/realtime-voice/session.json',
            input_timeline: { action: 'presence_timeline', events: [] },
            reply_timeline: { action: 'presence_timeline', events: [] },
          };
        },
        promptForContinue: async () => undefined,
      },
      (value) => output.push(String(value))
    );

    expect(recordCalls).toEqual([0, 1]);
    expect(turnCalls).toHaveLength(2);
    expect(turnCalls[0]?.audioPath).toBe('/tmp/realtime-voice/turn-01.wav');
    expect(turnCalls[1]?.audioPath).toBe('/tmp/realtime-voice/turn-02.wav');
    expect(output.some((line) => line.includes('User: 来週の予定教えて'))).toBe(true);
    expect(output.some((line) => line.includes('Assistant: 予定を確認します。'))).toBe(true);
  });

  it('does not gate VAD-mode turns behind the Enter prompt', async () => {
    const fakeStt: SpeechToTextBridge = {
      name: 'fake-stt',
      async transcribe() {
        return { text: 'テスト発話', backend: 'fake-stt' };
      },
    };
    registerSpeechToTextBridge(fakeStt);

    const recordCalls: number[] = [];
    await runRealtimeVoiceConversationInteractive(
      {
        sessionId: 'rtc-vad-test',
        interactive: true,
        assistantName: 'Kyberion',
        surfaceId: 'presence-studio',
        sourceId: 'local-mic',
        deliveryMode: 'none',
        personalVoiceMode: 'allow_fallback',
        recorder: 'vad',
        recordSeconds: 8,
        maxUtteranceSeconds: 30,
        vadEndpointMs: 700,
        bargeIn: false,
        streamingStt: true,
        warmActuator: true,
        idleTimeoutSeconds: 120,
        turns: 2,
        recordBridgePath: '/tmp/record_bridge.py',
        pythonBin: '/tmp/python3',
        recordOutputDir: '/tmp/realtime-voice',
      },
      {
        recordTurnAudio: async (turnIndex) => {
          recordCalls.push(turnIndex);
          return `/tmp/realtime-voice/turn-${String(turnIndex + 1).padStart(2, '0')}.wav`;
        },
        runTurn: async (input) => ({
          session_id: input.sessionId,
          profile_id: input.profileId ?? 'default-profile',
          language: input.language ?? 'ja',
          user_text: 'テスト発話',
          assistant_text: '了解です。',
          transcript_path: '/tmp/realtime-voice/session.json',
          input_timeline: { action: 'presence_timeline', events: [] },
          reply_timeline: { action: 'presence_timeline', events: [] },
        }),
        promptForContinue: async () => {
          throw new Error('promptForContinue must not be called in VAD mode');
        },
      }
    );

    expect(recordCalls).toEqual([0, 1]);
  });

  it('keeps the production entrypoint free of direct final-output logging', () => {
    const source = readFileSync(
      new URL('./run_realtime_voice_conversation.ts', import.meta.url),
      'utf8'
    );
    expect(source).toContain('run: ({ argv, print }) => main(argv, print)');
    expect(source).not.toContain('console.log(');
    expect(source).not.toContain('process.stdout.write');
    expect(source).not.toContain('process.stderr.write');
    expect(source).not.toMatch(/env\.KYBERION_/u);
    expect(source).toContain('getRegisteredEnvText');
  });
});
