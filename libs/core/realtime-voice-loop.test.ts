import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startRealtimeVoiceLoop, type RealtimeVoiceLoopTurnResult } from './realtime-voice-loop.js';
import { StubStreamingSpeechToTextBridge } from './streaming-stt-bridge.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeRmSync } from './secure-io.js';
import type { PlaybackHandle, PlaybackResult } from './audio-playback.js';
import { MediaEventBuffer } from './realtime-media-session.js';
import type { AudioChunk } from './meeting-session-types.js';

const testDir = pathResolver.sharedTmp('realtime-voice-loop-test');

/**
 * Paced mic fixture: two utterances (400ms speech + 900ms silence each)
 * with a real-time gap in between so the loop finishes turn 1 before
 * utterance 2 arrives. PCM_S16LE mono @16kHz → 32 bytes/ms.
 */
function twoUtteranceCommand(gapMs = 1200): string[] {
  return [
    process.execPath,
    '-e',
    [
      'const sp=(ms)=>{const b=Buffer.alloc(ms*32);for(let i=0;i<b.length;i+=2)b.writeInt16LE(((i%64)-32)*900,i);return b};',
      'const sil=(ms)=>Buffer.alloc(ms*32);',
      'const w=(b)=>new Promise(r=>process.stdout.write(b,r));',
      '(async()=>{',
      'await w(Buffer.concat([sp(400),sil(900)]));',
      `await new Promise(r=>setTimeout(r,${gapMs}));`,
      'await w(Buffer.concat([sp(400),sil(900)]));',
      '})();',
    ].join(''),
  ];
}

function immediateHandle(): PlaybackHandle {
  const done = Promise.resolve<PlaybackResult>({ ok: true, interrupted: false });
  return { done, stop: async () => ({ ok: true, interrupted: true }) };
}

beforeEach(() => {
  safeMkdir(testDir, { recursive: true });
});

afterEach(() => {
  safeRmSync(testDir, { recursive: true, force: true });
});

describe('realtime voice loop', () => {
  it(
    'runs two full turns with batch STT and reports per-turn metrics',
    { timeout: 60_000 },
    async () => {
      const turns: RealtimeVoiceLoopTurnResult[] = [];
      const synthesized: string[] = [];
      const mediaEvents: string[] = [];

      const handle = await startRealtimeVoiceLoop({
        recordingDir: testDir,
        consent: { requireRecordingConsent: false },
        mic: { command: twoUtteranceCommand(), sampleRateHz: 16000, chunkMs: 100 },
        vad: { rmsThreshold: 800, endpointMs: 700 },
        maxTurns: 2,
        transcribe: async (audioPath) => {
          expect(safeExistsSync(audioPath)).toBe(true);
          return 'こんにちは';
        },
        reply: async (userText, turn) => `了解です (${userText} / turn ${turn + 1})。次をどうぞ。`,
        synthesizeSegment: async (segment, index, turn) => {
          synthesized.push(segment);
          return `/tmp/fake-t${turn}-s${index}.wav`;
        },
        play: () => immediateHandle(),
        onTurn: (turn) => {
          turns.push(turn);
        },
        sessionId: 'voice-session-1',
        mediaEventBufferFactory: (sessionId) => {
          const buffer = new MediaEventBuffer(sessionId, 32);
          buffer.subscribe((event) => mediaEvents.push(event.type));
          return buffer;
        },
      });

      const report = await handle.done;
      expect(report.ended_by).toBe('max_turns');
      expect(report.turns_completed).toBe(2);
      expect(report.interruptions).toBe(0);

      expect(turns).toHaveLength(2);
      expect(turns[0].user_text).toBe('こんにちは');
      expect(turns[0].stt_mode).toBe('batch');
      expect(turns[0].interrupted).toBe(false);
      expect(turns[0].audio_path).toBe(path.join(testDir, 'turn-01.wav'));
      expect(turns[1].audio_path).toBe(path.join(testDir, 'turn-02.wav'));
      expect(mediaEvents[0]).toBe('session_started');
      expect(mediaEvents).toContain('speech_started');
      expect(mediaEvents).toContain('speech_ended');
      expect(mediaEvents).toContain('transcript_final');
      expect(mediaEvents).toContain('assistant_text_delta');
      expect(mediaEvents).toContain('turn_completed');
      expect(mediaEvents.at(-1)).toBe('session_ended');
      // pre-roll (≤300ms) + 400ms speech + 700ms endpoint silence
      expect(turns[0].metrics.listen_ms).toBeGreaterThanOrEqual(1000);
      expect(turns[0].metrics.listen_ms).toBeLessThanOrEqual(1600);
      expect(turns[0].metrics.speak_ms).toBeGreaterThanOrEqual(0);
      expect(synthesized.length).toBeGreaterThanOrEqual(2);
      expect(turns[0].assistant_audio_paths).toEqual(['/tmp/fake-t0-s0.wav']);
    }
  );

  it('uses streaming STT finals when a bridge is provided', { timeout: 60_000 }, async () => {
    const turns: RealtimeVoiceLoopTurnResult[] = [];
    let batchCalls = 0;

    const handle = await startRealtimeVoiceLoop({
      recordingDir: testDir,
      consent: { requireRecordingConsent: false },
      mic: { command: twoUtteranceCommand(), sampleRateHz: 16000, chunkMs: 100 },
      vad: { rmsThreshold: 800, endpointMs: 700 },
      maxTurns: 1,
      streamingStt: new StubStreamingSpeechToTextBridge(2),
      transcribe: async () => {
        batchCalls += 1;
        return 'batch-fallback';
      },
      reply: async () => '了解です。',
      synthesizeSegment: async () => '/tmp/fake.wav',
      play: () => immediateHandle(),
      onTurn: (turn) => {
        turns.push(turn);
      },
    });

    const report = await handle.done;
    expect(report.turns_completed).toBe(1);
    expect(turns[0].stt_mode).toBe('streaming');
    expect(turns[0].user_text).toMatch(/stub-utterance/);
    expect(batchCalls).toBe(0);
  });

  it('keeps capture identities unique when an empty transcript is skipped', async () => {
    const mediaEvents: string[] = [];
    let transcriptionCalls = 0;
    const turns: RealtimeVoiceLoopTurnResult[] = [];
    const handle = await startRealtimeVoiceLoop({
      recordingDir: testDir,
      consent: { requireRecordingConsent: false },
      mic: { command: twoUtteranceCommand(), sampleRateHz: 16000, chunkMs: 100 },
      vad: { rmsThreshold: 800, endpointMs: 700 },
      maxTurns: 1,
      transcribe: async () => (transcriptionCalls++ === 0 ? '' : '二回目'),
      reply: async () => '了解です。',
      synthesizeSegment: async () => '/tmp/fake.wav',
      play: () => immediateHandle(),
      onTurn: (turn) => turns.push(turn),
      sessionId: 'voice-empty-transcript-session',
      mediaEventBufferFactory: (sessionId) => {
        const buffer = new MediaEventBuffer(sessionId, 32);
        buffer.subscribe((event) => mediaEvents.push(event.type));
        return buffer;
      },
    });

    const report = await handle.done;
    expect(report.turns_completed).toBe(1);
    expect(turns[0]?.audio_path).toBe(path.join(testDir, 'turn-02.wav'));
    expect(mediaEvents.filter((event) => event === 'speech_started')).toHaveLength(2);
    expect(mediaEvents.filter((event) => event === 'speech_ended')).toHaveLength(2);
  }, 60_000);

  it(
    'publishes streamed PCM output on the canonical media session event sink',
    {
      timeout: 60_000,
    },
    async () => {
      const mediaEvents: string[] = [];
      const outputChunk: AudioChunk = {
        format: { encoding: 'pcm_s16le', sample_rate_hz: 16000, channels: 1 },
        payload: new Uint8Array([0, 0]),
        ts_ms: 0,
      };

      const handle = await startRealtimeVoiceLoop({
        recordingDir: testDir,
        consent: { requireRecordingConsent: false },
        mic: { command: twoUtteranceCommand(), sampleRateHz: 16000, chunkMs: 100 },
        vad: { rmsThreshold: 800, endpointMs: 700 },
        maxTurns: 1,
        transcribe: async () => 'こんにちは',
        streamReply: async (_userText, _turn, onSegment) => {
          await onSegment('ストリーム音声です。');
          return 'ストリーム音声です。';
        },
        reply: async () => 'unused',
        synthesizeSegment: async () => '/tmp/fake.wav',
        synthesizeAudioStream: async () =>
          (async function* (): AsyncGenerator<AudioChunk> {
            yield outputChunk;
          })(),
        playAudioStream: () => immediateHandle(),
        onTurn: (turn) => {
          expect(turn.assistant_audio_paths).toEqual([]);
        },
        sessionId: 'voice-stream-session-1',
        mediaEventBufferFactory: (sessionId) => {
          const buffer = new MediaEventBuffer(sessionId, 32);
          buffer.subscribe((event) => mediaEvents.push(event.type));
          return buffer;
        },
      });

      const report = await handle.done;
      expect(report.ended_by).toBe('max_turns');
      expect(mediaEvents).toContain('assistant_text_delta');
      expect(mediaEvents).toContain('audio_output_delta');
    }
  );

  it(
    'barge-in stops playback and captures the interrupting utterance as the next turn',
    { timeout: 60_000 },
    async () => {
      const turns: RealtimeVoiceLoopTurnResult[] = [];
      let stopCalls = 0;
      let playCalls = 0;

      // Turn 1 playback hangs until stopped (assistant "still talking"),
      // later playbacks resolve immediately.
      const makePlay = (): PlaybackHandle => {
        playCalls += 1;
        if (playCalls > 1) return immediateHandle();
        let resolveDone: (r: PlaybackResult) => void = () => undefined;
        const done = new Promise<PlaybackResult>((resolve) => {
          resolveDone = resolve;
        });
        return {
          done,
          stop: async () => {
            stopCalls += 1;
            resolveDone({ ok: true, interrupted: true });
            return done;
          },
        };
      };

      const command = [
        process.execPath,
        '-e',
        [
          'const sp=(ms)=>{const b=Buffer.alloc(ms*32);for(let i=0;i<b.length;i+=2)b.writeInt16LE(((i%64)-32)*900,i);return b};',
          'const sil=(ms)=>Buffer.alloc(ms*32);',
          'const w=(b)=>new Promise(r=>process.stdout.write(b,r));',
          '(async()=>{',
          // Utterance 1, then wait for the assistant to be mid-speech,
          // then barge in with sustained loud speech and finish it.
          'await w(Buffer.concat([sp(400),sil(900)]));',
          'await new Promise(r=>setTimeout(r,800));',
          'await w(Buffer.concat([sp(600),sil(900)]));',
          '})();',
        ].join(''),
      ];

      const handle = await startRealtimeVoiceLoop({
        recordingDir: testDir,
        consent: { requireRecordingConsent: false },
        mic: { command, sampleRateHz: 16000, chunkMs: 100 },
        vad: { rmsThreshold: 800, endpointMs: 700 },
        bargeIn: { enabled: true, minSpeechMs: 250 },
        maxTurns: 2,
        transcribe: async () => 'ユーザー発話',
        reply: async () => 'とても長い返答をしているところです。',
        synthesizeSegment: async () => '/tmp/fake.wav',
        play: () => makePlay(),
        onTurn: (turn) => {
          turns.push(turn);
        },
      });

      const report = await handle.done;
      expect(report.interruptions).toBe(1);
      expect(stopCalls).toBe(1);
      expect(report.turns_completed).toBe(2);
      expect(turns[0].interrupted).toBe(true);
      expect(turns[1].interrupted).toBe(false);
      // The barged utterance was captured (≥ the sustained 600ms of speech, minus debounce).
      expect(turns[1].metrics.listen_ms).toBeGreaterThanOrEqual(700);
    }
  );

  it('ends by idle timeout when nobody speaks', { timeout: 60_000 }, async () => {
    const handle = await startRealtimeVoiceLoop({
      recordingDir: testDir,
      consent: { requireRecordingConsent: false },
      mic: {
        command: [process.execPath, '-e', 'process.stdout.write(Buffer.alloc(64000))'],
        sampleRateHz: 16000,
        chunkMs: 100,
      },
      vad: { rmsThreshold: 800, endpointMs: 700 },
      idleTimeoutMs: 1000,
      transcribe: async () => 'unused',
      reply: async () => 'unused',
      synthesizeSegment: async () => '/tmp/fake.wav',
      play: () => immediateHandle(),
    });
    const report = await handle.done;
    expect(report.ended_by).toBe('idle_timeout');
    expect(report.turns_completed).toBe(0);
  });

  it('fails closed when a mission id is set but consent is missing', async () => {
    delete process.env.KYBERION_SUDO;
    await expect(
      startRealtimeVoiceLoop({
        recordingDir: testDir,
        mic: {
          command: [process.execPath, '-e', 'process.stdout.write(Buffer.alloc(3200))'],
          sampleRateHz: 16000,
        },
        consent: { missionId: 'MSN-REALTIME-VOICE-CONSENT-TEST' },
        transcribe: async () => 'unused',
        reply: async () => 'unused',
        synthesizeSegment: async () => '/tmp/fake.wav',
      })
    ).rejects.toThrow(/recording consent missing/);
  });

  it('fails closed for microphone recording when no mission is supplied', async () => {
    const previousSudo = process.env.KYBERION_SUDO;
    delete process.env.KYBERION_SUDO;
    try {
      await expect(
        startRealtimeVoiceLoop({
          recordingDir: testDir,
          mic: { command: [process.execPath, '-e', 'process.stdout.write(Buffer.alloc(3200))'] },
          transcribe: async () => 'unused',
          reply: async () => 'unused',
          synthesizeSegment: async () => '/tmp/fake.wav',
        })
      ).rejects.toThrow(/mission_id/);
    } finally {
      if (previousSudo === undefined) delete process.env.KYBERION_SUDO;
      else process.env.KYBERION_SUDO = previousSudo;
    }
  });

  it('rejects a recording directory outside the repository', async () => {
    await expect(
      startRealtimeVoiceLoop({
        recordingDir: '/tmp/kyberion-realtime-recordings',
        consent: { requireRecordingConsent: false },
        transcribe: async () => 'unused',
        reply: async () => 'unused',
        synthesizeSegment: async () => '/tmp/fake.wav',
      })
    ).rejects.toThrow(/outside the repository root/);
  });
});
