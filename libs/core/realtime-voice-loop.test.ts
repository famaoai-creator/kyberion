import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  describeRealtimeVoiceLoopEvent,
  resolveRealtimeVoiceBargeInMode,
  startRealtimeVoiceLoop,
  type RealtimeVoiceLoopEvent,
  type RealtimeVoiceLoopTurnResult,
} from './realtime-voice-loop.js';
import {
  StubStreamingSpeechToTextBridge,
  type StreamingSpeechToTextBridge,
} from './streaming-stt-bridge.js';
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

type MicStep =
  | { speech: number }
  | { silence: number }
  | { wait: number }
  | { pacedSpeech: number }
  | { pacedSilence: number };

/**
 * Mic fixture from steps. `paced*` steps are written in 100ms chunks at real
 * time so wall-clock timers inside the loop (two-stage grace, EOT hold) see
 * the audio as it would arrive from a live microphone.
 */
function micCommand(steps: MicStep[]): string[] {
  const body = steps
    .map((step) => {
      if ('speech' in step) return `await w(sp(${step.speech}));`;
      if ('silence' in step) return `await w(sil(${step.silence}));`;
      if ('wait' in step) return `await new Promise(r=>setTimeout(r,${step.wait}));`;
      if ('pacedSpeech' in step) return `await pace(sp(${step.pacedSpeech}));`;
      return `await pace(sil(${step.pacedSilence}));`;
    })
    .join('');
  return [
    process.execPath,
    '-e',
    [
      'const sp=(ms)=>{const b=Buffer.alloc(ms*32);for(let i=0;i<b.length;i+=2)b.writeInt16LE(((i%64)-32)*900,i);return b};',
      'const sil=(ms)=>Buffer.alloc(ms*32);',
      'const w=(b)=>new Promise(r=>process.stdout.write(b,r));',
      'const pace=async(b)=>{for(let i=0;i<b.length;i+=3200){await w(b.subarray(i,i+3200));await new Promise(r=>setTimeout(r,100));}};',
      `(async()=>{${body}})();`,
    ].join(''),
  ];
}

/** Streaming STT double: `partial` on every chunk, `final` when the feed ends. */
function scriptedStreamingStt(partial: string | null, final: string): StreamingSpeechToTextBridge {
  return {
    bridge_id: 'scripted',
    async *transcribeStream(audio) {
      for await (const _chunk of audio) {
        if (partial) {
          yield { utterance_id: 'u', is_final: false, text: partial, emitted_at: '' };
        }
      }
      yield { utterance_id: 'u', is_final: true, text: final, emitted_at: '' };
    },
  };
}

/** Playback that runs for `ms` of real time unless stopped. */
function timedHandle(ms: number, onStop?: () => void): PlaybackHandle {
  let resolveDone: (r: PlaybackResult) => void = () => undefined;
  const done = new Promise<PlaybackResult>((resolve) => {
    resolveDone = resolve;
  });
  const timer = setTimeout(() => resolveDone({ ok: true, interrupted: false }), ms);
  return {
    done,
    stop: async () => {
      clearTimeout(timer);
      onStop?.();
      resolveDone({ ok: true, interrupted: true });
      return done;
    },
  };
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

  it(
    'two_stage barge-in pauses on noise and resumes when no words arrive',
    { timeout: 60_000 },
    async () => {
      const events: RealtimeVoiceLoopEvent[] = [];
      const turns: RealtimeVoiceLoopTurnResult[] = [];
      const handle = await startRealtimeVoiceLoop({
        recordingDir: testDir,
        consent: { requireRecordingConsent: false },
        mic: {
          command: micCommand([
            { speech: 400 },
            { silence: 900 },
            { wait: 600 },
            { pacedSpeech: 300 },
            { pacedSilence: 1000 },
            { wait: 3000 },
          ]),
          sampleRateHz: 16000,
          chunkMs: 100,
        },
        vad: { rmsThreshold: 800, endpointMs: 700 },
        bargeIn: { mode: 'two_stage', provisionalSpeechMs: 150, wordsGraceMs: 300 },
        streamingStt: scriptedStreamingStt(null, 'ユーザー発話'),
        maxTurns: 1,
        transcribe: async () => 'batch-unused',
        reply: async () => 'とても長い返答をしているところです。',
        synthesizeSegment: async () => '/tmp/fake.wav',
        play: () => timedHandle(2500),
        onEvent: (event) => events.push(event),
        onTurn: (turn) => {
          turns.push(turn);
        },
      });

      const report = await handle.done;
      const kinds = events.map((event) => event.kind);
      expect(kinds).toContain('barge_in_provisional');
      expect(events).toContainEqual({ kind: 'barge_in_resumed', turn: 0, reason: 'no_words' });
      expect(kinds.indexOf('barge_in_resumed')).toBeGreaterThan(
        kinds.indexOf('barge_in_provisional')
      );
      expect(kinds).not.toContain('barge_in');
      expect(kinds).not.toContain('turn_cancelled');
      expect(report.interruptions).toBe(0);
      expect(turns[0]?.interrupted).toBe(false);
    }
  );

  it(
    'two_stage hard stop aborts the reasoning call with reason barge_in',
    { timeout: 60_000 },
    async () => {
      const events: RealtimeVoiceLoopEvent[] = [];
      const turns: RealtimeVoiceLoopTurnResult[] = [];
      let replyCalls = 0;
      let firstSignalAborted = false;
      let playCalls = 0;

      const handle = await startRealtimeVoiceLoop({
        recordingDir: testDir,
        consent: { requireRecordingConsent: false },
        mic: {
          command: micCommand([
            { speech: 400 },
            { silence: 900 },
            { wait: 600 },
            { pacedSpeech: 600 },
            { pacedSilence: 1000 },
            { wait: 2000 },
          ]),
          sampleRateHz: 16000,
          chunkMs: 100,
        },
        vad: { rmsThreshold: 800, endpointMs: 700 },
        bargeIn: { mode: 'two_stage', provisionalSpeechMs: 150, wordsGraceMs: 2000 },
        streamingStt: scriptedStreamingStt('ちょっと待って', '待ってください'),
        maxTurns: 2,
        transcribe: async () => 'batch-unused',
        reply: async () => 'unused',
        streamReply: async (_text, _turn, onSegment, signal) => {
          replyCalls += 1;
          if (replyCalls > 1) {
            await onSegment('了解です。');
            return '了解です。';
          }
          await onSegment('最初の文です。');
          await new Promise<void>((resolve) => {
            if (signal?.aborted) resolve();
            signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          firstSignalAborted = Boolean(signal?.aborted);
          throw new Error('reasoning aborted');
        },
        synthesizeSegment: async () => '/tmp/fake.wav',
        play: () => {
          playCalls += 1;
          return playCalls === 1 ? timedHandle(30_000) : immediateHandle();
        },
        onEvent: (event) => events.push(event),
        onTurn: (turn) => {
          turns.push(turn);
        },
      });

      const report = await handle.done;
      expect(firstSignalAborted).toBe(true);
      expect(events).toContainEqual({ kind: 'turn_cancelled', turn: 0, reason: 'barge_in' });
      const kinds = events.map((event) => event.kind);
      expect(kinds.indexOf('barge_in_provisional')).toBeLessThan(kinds.indexOf('barge_in'));
      expect(report.interruptions).toBe(1);
      expect(report.turns_completed).toBe(2);
      expect(turns[0].interrupted).toBe(true);
      expect(turns[0].assistant_text).toBe('最初の文です。');
      expect(turns[1].user_text).toBe('待ってください');
    }
  );

  it('EOT hold joins a trailing-off utterance with the next one', { timeout: 60_000 }, async () => {
    const replies: string[] = [];
    const turns: RealtimeVoiceLoopTurnResult[] = [];
    const transcripts = ['明日の会議ですが', '場所を教えてください'];
    const handle = await startRealtimeVoiceLoop({
      recordingDir: testDir,
      consent: { requireRecordingConsent: false },
      mic: { command: twoUtteranceCommand(), sampleRateHz: 16000, chunkMs: 100 },
      vad: { rmsThreshold: 800, endpointMs: 700 },
      eotHold: { enabled: true, maxHoldMs: 10_000 },
      maxTurns: 1,
      transcribe: async () => transcripts.shift() ?? '',
      reply: async (userText) => {
        replies.push(userText);
        return '会議室Aです。';
      },
      synthesizeSegment: async () => '/tmp/fake.wav',
      play: () => immediateHandle(),
      onTurn: (turn) => {
        turns.push(turn);
      },
    });

    const report = await handle.done;
    expect(report.turns_completed).toBe(1);
    expect(replies).toEqual(['明日の会議ですが場所を教えてください']);
    expect(turns[0].user_text).toBe('明日の会議ですが場所を教えてください');
    expect(turns[0].audio_path).toBe(path.join(testDir, 'turn-02.wav'));
  });

  it('EOT hold commits a held turn after maxHoldMs of silence', { timeout: 60_000 }, async () => {
    const replies: string[] = [];
    const handle = await startRealtimeVoiceLoop({
      recordingDir: testDir,
      consent: { requireRecordingConsent: false },
      mic: {
        command: micCommand([{ speech: 400 }, { silence: 900 }, { pacedSilence: 1500 }]),
        sampleRateHz: 16000,
        chunkMs: 100,
      },
      vad: { rmsThreshold: 800, endpointMs: 700 },
      eotHold: { enabled: true, maxHoldMs: 300 },
      maxTurns: 1,
      transcribe: async () => '資料を見て',
      reply: async (userText) => {
        replies.push(userText);
        return 'はい。';
      },
      synthesizeSegment: async () => '/tmp/fake.wav',
      play: () => immediateHandle(),
    });

    const report = await handle.done;
    expect(report.ended_by).toBe('max_turns');
    expect(replies).toEqual(['資料を見て']);
  });

  it('respond gate drops own-TTS echo without calling reasoning', { timeout: 60_000 }, async () => {
    const events: RealtimeVoiceLoopEvent[] = [];
    const transcripts = ['こんにちは', 'とても長い返答をしているところです'];
    let replyCalls = 0;
    const handle = await startRealtimeVoiceLoop({
      recordingDir: testDir,
      consent: { requireRecordingConsent: false },
      mic: { command: twoUtteranceCommand(), sampleRateHz: 16000, chunkMs: 100 },
      vad: { rmsThreshold: 800, endpointMs: 700 },
      bargeIn: { mode: 'two_stage' },
      respondGate: { enabled: true },
      transcribe: async () => transcripts.shift() ?? '',
      reply: async () => {
        replyCalls += 1;
        return 'とても長い返答をしているところです。';
      },
      synthesizeSegment: async () => '/tmp/fake.wav',
      play: () => immediateHandle(),
      onEvent: (event) => events.push(event),
    });

    const report = await handle.done;
    expect(replyCalls).toBe(1);
    expect(report.turns_completed).toBe(1);
    expect(events).toContainEqual({ kind: 'degraded', what: 'respond_gate', reason: 'echo' });
  });

  it('handle.stop() cancels the live turn as external', { timeout: 60_000 }, async () => {
    const events: RealtimeVoiceLoopEvent[] = [];
    let handleRef: { stop(): Promise<unknown> } | null = null;
    const handle = await startRealtimeVoiceLoop({
      recordingDir: testDir,
      consent: { requireRecordingConsent: false },
      mic: {
        command: micCommand([{ speech: 400 }, { silence: 900 }, { wait: 5000 }]),
        sampleRateHz: 16000,
        chunkMs: 100,
      },
      vad: { rmsThreshold: 800, endpointMs: 700 },
      transcribe: async () => 'こんにちは',
      reply: async () => '返答です。',
      synthesizeSegment: async () => '/tmp/fake.wav',
      play: () => {
        setTimeout(() => void handleRef?.stop(), 50);
        return timedHandle(30_000);
      },
      onEvent: (event) => events.push(event),
    });
    handleRef = handle;

    const report = await handle.done;
    expect(report.ended_by).toBe('stopped');
    expect(events).toContainEqual({ kind: 'turn_cancelled', turn: 0, reason: 'external' });
  });

  it(
    'speculative reply buffers during tentative silence and is adopted on a matching final',
    { timeout: 60_000 },
    async () => {
      const replyInputs: string[] = [];
      const synthesized: string[] = [];
      const turns: RealtimeVoiceLoopTurnResult[] = [];
      const handle = await startRealtimeVoiceLoop({
        recordingDir: testDir,
        consent: { requireRecordingConsent: false },
        mic: {
          command: micCommand([{ speech: 400 }, { silence: 900 }, { wait: 2000 }]),
          sampleRateHz: 16000,
          chunkMs: 100,
        },
        vad: { rmsThreshold: 800, endpointMs: 700 },
        streamingStt: scriptedStreamingStt('こんにちは元気です', 'こんにちは、元気です。'),
        speculativeReply: { enabled: true, powerSource: 'ac', costTier: 'free' },
        maxTurns: 1,
        transcribe: async () => 'batch-unused',
        reply: async () => 'unused',
        streamReply: async (userText, _turn, onSegment) => {
          replyInputs.push(userText);
          await onSegment('はい、元気です。');
          return 'はい、元気です。';
        },
        synthesizeSegment: async (segment) => {
          synthesized.push(segment);
          return '/tmp/fake.wav';
        },
        play: () => immediateHandle(),
        onTurn: (turn) => {
          turns.push(turn);
        },
      });

      const report = await handle.done;
      expect(report.turns_completed).toBe(1);
      expect(replyInputs).toEqual(['こんにちは元気です']);
      expect(synthesized).toEqual(['はい、元気です。']);
      expect(turns[0].user_text).toBe('こんにちは、元気です。');
      expect(turns[0].assistant_text).toBe('はい、元気です。');
    }
  );

  it(
    'speculative reply is revoked when speech resumes and never spoken',
    { timeout: 60_000 },
    async () => {
      const replyInputs: string[] = [];
      const synthesized: string[] = [];
      const turns: RealtimeVoiceLoopTurnResult[] = [];
      let firstAborted = false;
      const handle = await startRealtimeVoiceLoop({
        recordingDir: testDir,
        consent: { requireRecordingConsent: false },
        mic: {
          command: micCommand([
            { speech: 400 },
            { silence: 400 },
            { speech: 300 },
            { silence: 900 },
            { wait: 2000 },
          ]),
          sampleRateHz: 16000,
          chunkMs: 100,
        },
        vad: { rmsThreshold: 800, endpointMs: 700 },
        streamingStt: scriptedStreamingStt('明日の予定', '明日の予定を教えて'),
        speculativeReply: { enabled: true, powerSource: 'ac', costTier: 'free' },
        maxTurns: 1,
        transcribe: async () => 'batch-unused',
        reply: async () => 'unused',
        streamReply: async (userText, _turn, onSegment, signal) => {
          replyInputs.push(userText);
          if (replyInputs.length === 1) {
            await onSegment('古い推測の返答です。');
            await new Promise<void>((resolve) => {
              if (signal?.aborted) resolve();
              signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            firstAborted = Boolean(signal?.aborted);
            throw new Error('speculation aborted');
          }
          await onSegment('十時から会議です。');
          return '十時から会議です。';
        },
        synthesizeSegment: async (segment) => {
          synthesized.push(segment);
          return '/tmp/fake.wav';
        },
        play: () => immediateHandle(),
        onTurn: (turn) => {
          turns.push(turn);
        },
      });

      const report = await handle.done;
      expect(report.turns_completed).toBe(1);
      expect(firstAborted).toBe(true);
      expect(replyInputs[0]).toBe('明日の予定');
      expect(replyInputs.at(-1)).toBe('明日の予定を教えて');
      expect(synthesized).toEqual(['十時から会議です。']);
      expect(turns[0].assistant_text).toBe('十時から会議です。');
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

  it('reports the metered guard when a requested speculative reply is disabled', async () => {
    const events: RealtimeVoiceLoopEvent[] = [];
    const handle = await startRealtimeVoiceLoop({
      recordingDir: testDir,
      consent: { requireRecordingConsent: false },
      mic: {
        command: [process.execPath, '-e', 'process.stdout.write(Buffer.alloc(3200))'],
        sampleRateHz: 16000,
        chunkMs: 100,
      },
      vad: { rmsThreshold: 800, endpointMs: 700 },
      streamingStt: scriptedStreamingStt(null, 'unused'),
      speculativeReply: { enabled: true, powerSource: 'ac', costTier: 'metered' },
      transcribe: async () => 'unused',
      reply: async () => 'unused',
      streamReply: async () => 'unused',
      synthesizeSegment: async () => '/tmp/fake.wav',
      play: () => immediateHandle(),
      onEvent: (event) => events.push(event),
    });
    await handle.done;
    expect(events).toContainEqual({
      kind: 'degraded',
      what: 'speculative_reply',
      reason: 'metered guard; disabled',
    });
  });

  it('fails closed (not open) when a caller requests speculation without wiring powerSource/costTier (N8)', async () => {
    const events: RealtimeVoiceLoopEvent[] = [];
    const handle = await startRealtimeVoiceLoop({
      recordingDir: testDir,
      consent: { requireRecordingConsent: false },
      mic: {
        command: [process.execPath, '-e', 'process.stdout.write(Buffer.alloc(3200))'],
        sampleRateHz: 16000,
        chunkMs: 100,
      },
      vad: { rmsThreshold: 800, endpointMs: 700 },
      streamingStt: scriptedStreamingStt(null, 'unused'),
      // No powerSource/costTier: a caller of the library that merely flips
      // `enabled: true` must not get speculation on by default.
      speculativeReply: { enabled: true },
      transcribe: async () => 'unused',
      reply: async () => 'unused',
      streamReply: async () => 'unused',
      synthesizeSegment: async () => '/tmp/fake.wav',
      play: () => immediateHandle(),
      onEvent: (event) => events.push(event),
    });
    await handle.done;
    expect(events).toContainEqual({
      kind: 'degraded',
      what: 'speculative_reply',
      reason: 'metered guard; disabled',
    });
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

describe('realtime voice loop helpers', () => {
  it('resolves the barge-in mode from env, option, then legacy enabled flag', () => {
    expect(resolveRealtimeVoiceBargeInMode(undefined, {})).toBe('off');
    expect(resolveRealtimeVoiceBargeInMode({ enabled: true }, {})).toBe('legacy');
    expect(resolveRealtimeVoiceBargeInMode({ enabled: true, mode: 'two_stage' }, {})).toBe(
      'two_stage'
    );
    expect(
      resolveRealtimeVoiceBargeInMode(
        { mode: 'two_stage' },
        { KYBERION_VOICE_BARGE_IN_MODE: 'off' }
      )
    ).toBe('off');
    expect(
      resolveRealtimeVoiceBargeInMode({ mode: 'legacy' }, { KYBERION_VOICE_BARGE_IN_MODE: 'bogus' })
    ).toBe('legacy');
  });

  it('describes loop events from the vocabulary catalog in en and ja', () => {
    expect(describeRealtimeVoiceLoopEvent({ kind: 'state', state: 'thinking' }, 'ja')).toBe(
      '💭 応答を生成中…'
    );
    expect(describeRealtimeVoiceLoopEvent({ kind: 'state', state: 'thinking' }, 'en')).toBe(
      '💭 Generating a reply…'
    );
    expect(
      describeRealtimeVoiceLoopEvent({ kind: 'turn_cancelled', turn: 1, reason: 'barge_in' }, 'en')
    ).toBe('⏹  Turn 2 cancelled (barge_in)');
    expect(
      describeRealtimeVoiceLoopEvent(
        { kind: 'utterance_captured', turn: 0, duration_ms: 1234, endpointed: true },
        'en'
      )
    ).toBe('   (1.2s captured, endpoint)');
  });
});
