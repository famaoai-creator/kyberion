import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  registerSpeechToTextBridge,
  resetSpeechToTextBridge,
  type SpeechToTextBridge,
} from '@agent/core';
import {
  parseRealtimeVoiceConversationCli,
  runRealtimeVoiceConversationInteractive,
} from './run_realtime_voice_conversation.js';

describe('run_realtime_voice_conversation cli', () => {
  const previousSudo = process.env.KYBERION_SUDO;

  beforeEach(() => {
    // These tests inject recorder/turn dependencies and never open a real mic.
    process.env.KYBERION_SUDO = 'true';
  });

  afterEach(() => {
    resetSpeechToTextBridge();
    if (previousSudo === undefined) delete process.env.KYBERION_SUDO;
    else process.env.KYBERION_SUDO = previousSudo;
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
    expect(parsed.recordSeconds).toBe(8);
    expect(parsed.maxUtteranceSeconds).toBe(30);
    expect(parsed.vadEndpointMs).toBe(700);
    expect(parsed.vadThresholdRms).toBeUndefined();
    expect(parsed.deliveryMode).toBe('artifact_and_playback');
    expect(parsed.personalVoiceMode).toBe('require_personal_voice');
    expect(parsed.bargeIn).toBe(false);
    expect(parsed.streamingStt).toBe(true);
    expect(parsed.warmActuator).toBe(true);
    expect(parsed.idleTimeoutSeconds).toBe(120);
    expect(parsed.mission).toBe('MSN-CLI-TEST-001');
    expect(parsed.vadBackend).toBeUndefined();
  });

  it('parses realtime loop flags', () => {
    const parsed = parseRealtimeVoiceConversationCli({
      'session-id': 'rtc-loop',
      interactive: true,
      'barge-in': true,
      'vad-backend': 'silero',
      'streaming-stt': false,
      'warm-actuator': false,
      mission: 'MSN-CLI-TEST-002',
      'idle-timeout-seconds': 45,
    });
    expect(parsed.bargeIn).toBe(true);
    expect(parsed.vadBackend).toBe('silero');
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
      }
    );

    expect(recordCalls).toEqual([0, 1]);
    expect(turnCalls).toHaveLength(2);
    expect(turnCalls[0]?.audioPath).toBe('/tmp/realtime-voice/turn-01.wav');
    expect(turnCalls[1]?.audioPath).toBe('/tmp/realtime-voice/turn-02.wav');
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
});
