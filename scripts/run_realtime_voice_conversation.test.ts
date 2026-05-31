import { afterEach, describe, expect, it } from 'vitest';
import { registerSpeechToTextBridge, resetSpeechToTextBridge, type SpeechToTextBridge } from '@agent/core';
import {
  parseRealtimeVoiceConversationCli,
  runRealtimeVoiceConversationInteractive,
} from './run_realtime_voice_conversation.js';

describe('run_realtime_voice_conversation cli', () => {
  afterEach(() => {
    resetSpeechToTextBridge();
  });

  it('parses interactive mode and default record settings', () => {
    const parsed = parseRealtimeVoiceConversationCli({
      'session-id': 'rtc-1',
      interactive: true,
      'assistant-name': 'Kyberion',
    });

    expect(parsed.sessionId).toBe('rtc-1');
    expect(parsed.interactive).toBe(true);
    expect(parsed.recordSeconds).toBe(8);
    expect(parsed.deliveryMode).toBe('artifact_and_playback');
    expect(parsed.personalVoiceMode).toBe('require_personal_voice');
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
        recordSeconds: 3,
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
            input_timeline: { kind: 'input' } as any,
            reply_timeline: { kind: 'reply' } as any,
          };
        },
        promptForContinue: async () => undefined,
      },
    );

    expect(recordCalls).toEqual([0, 1]);
    expect(turnCalls).toHaveLength(2);
    expect(turnCalls[0]?.audioPath).toBe('/tmp/realtime-voice/turn-01.wav');
    expect(turnCalls[1]?.audioPath).toBe('/tmp/realtime-voice/turn-02.wav');
  });
});
