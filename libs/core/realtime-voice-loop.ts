/**
 * Realtime voice loop — the full-duplex conversation state machine:
 *
 *   LISTENING → (VAD endpoint) → THINKING → SPEAKING → LISTENING
 *
 * One continuous microphone session feeds a `VadTurnSegmenter`. When an
 * utterance endpoint fires, the turn is transcribed (streaming STT when
 * a bridge is provided — transcription overlaps the user's speech — or
 * batch STT on the flushed WAV), the reply callback produces assistant
 * text, and `speakSegmented` speaks it sentence-by-sentence with a
 * cancellable playback handle.
 *
 * Barge-in (opt-in): while SPEAKING the loop keeps watching the mic
 * with a second, deliberately less sensitive energy VAD (threshold ×
 * multiplier + a sustained-speech debounce so speaker echo does not
 * self-interrupt). Sustained user speech stops playback, discards
 * pending synthesis, and replays the interrupting audio into the
 * segmenter so the barged utterance is not lost. Default is
 * half-duplex: mic input is ignored while the assistant speaks.
 *
 * Governance mirrors MeetingParticipationCoordinator: recording consent
 * is fail-closed whenever a mission id is supplied, and every state
 * transition lands on the optional TraceContext with per-turn latency
 * metrics (listen/stt/llm/first-audio/speak).
 */

import * as path from 'node:path';
import { logger } from './core.js';
import { checkMeetingParticipationConsent } from './meeting-participation-coordinator.js';
import { startMicCapture, type MicCaptureOptions } from './mic-capture.js';
import { pcmToWav } from './pcm-wav.js';
import { playAudioFile, type PlaybackHandle } from './audio-playback.js';
import { safeMkdir, safeWriteFile } from './secure-io.js';
import {
  speakSegmented,
  type SegmentedSpeechController,
  DEFAULT_SPEECH_SEGMENT_CHARS,
} from './segmented-voice-playback.js';
import { VadTurnSegmenter, type VadTurnSegmenterOptions } from './vad-turn-recorder.js';
import { EnergyVad, computeChunkDurationMs } from './voice-activity-detector.js';
import type { TraceContext } from './src/trace.js';
import type { StreamingSpeechToTextBridge } from './streaming-stt-bridge.js';
import type { AudioChunk, AudioFormat } from './meeting-session-types.js';

export type RealtimeVoiceLoopState = 'listening' | 'thinking' | 'speaking';

export interface RealtimeVoiceTurnMetrics {
  /** Utterance length (onset → endpoint, incl. pre-roll + trailing silence). */
  listen_ms: number;
  stt_ms: number;
  llm_ms: number;
  /** ms from reply text ready until the first audio began playing. */
  tts_first_audio_ms: number | null;
  speak_ms: number;
}

export interface RealtimeVoiceLoopTurnResult {
  turn: number;
  user_text: string;
  assistant_text: string;
  audio_path: string;
  /** True when barge-in cut the assistant reply short. */
  interrupted: boolean;
  /** 'streaming' when the streaming STT produced the transcript. */
  stt_mode: 'streaming' | 'batch';
  metrics: RealtimeVoiceTurnMetrics;
}

export type RealtimeVoiceLoopEvent =
  | { kind: 'state'; state: RealtimeVoiceLoopState | 'calibrating' }
  | { kind: 'utterance_captured'; turn: number; duration_ms: number; endpointed: boolean }
  | { kind: 'barge_in'; turn: number }
  | { kind: 'degraded'; what: string; reason: string };

export interface RealtimeVoiceLoopOptions {
  /** Directory for per-turn user WAVs (created if missing). */
  recordingDir: string;
  mic?: MicCaptureOptions;
  /** Segmenter tuning (threshold, endpoint, calibration, pre-roll, cap). */
  vad?: Omit<VadTurnSegmenterOptions, 'maxUtteranceMs'> & { maxUtteranceMs?: number };
  /**
   * Enable barge-in. `thresholdMultiplier` scales the speech threshold while
   * the assistant is speaking (default 2), `minSpeechMs` is the sustained
   * speech debounce (default 250ms).
   */
  bargeIn?: { enabled: boolean; thresholdMultiplier?: number; minSpeechMs?: number };
  /** Half-duplex self-audio suppression while output returns through BlackHole. */
  selfAudioSuppressionMs?: number;
  /** Additional drain window after playback finishes. */
  postPlaybackDrainMs?: number;
  /** End the loop after this many completed turns. */
  maxTurns?: number;
  /** End the loop after this much continuous listening silence (default 120s). */
  idleTimeoutMs?: number;
  /** Recording consent, coordinator-style: fail closed when missionId is set. */
  consent?: {
    missionId?: string;
    tenantSlug?: string;
    /** Default: Boolean(missionId). */
    requireRecordingConsent?: boolean;
  };
  trace?: TraceContext;
  /** Streaming STT bridge; when set, transcription overlaps the utterance. */
  streamingStt?: StreamingSpeechToTextBridge;
  /** Batch STT fallback over the flushed WAV. */
  transcribe: (audioPath: string) => Promise<string>;
  /** Produce the assistant reply for a final user utterance. */
  reply: (userText: string, turn: number) => Promise<string>;
  /** Synthesize one reply segment to an audio file (sentence-level). */
  synthesizeSegment: (
    segment: string,
    segmentIndex: number,
    turn: number,
    signal?: AbortSignal
  ) => Promise<string>;
  /** Play an audio file (default: platform player). */
  play?: (audioPath: string, segmentIndex: number) => PlaybackHandle;
  maxSegmentChars?: number;
  onEvent?: (event: RealtimeVoiceLoopEvent) => void;
  onTurn?: (turn: RealtimeVoiceLoopTurnResult) => void | Promise<void>;
}

export interface RealtimeVoiceLoopReport {
  turns_completed: number;
  interruptions: number;
  ended_by: 'max_turns' | 'stream_end' | 'stopped' | 'idle_timeout' | 'error';
  error?: string;
}

export interface RealtimeVoiceLoopHandle {
  done: Promise<RealtimeVoiceLoopReport>;
  stop(): Promise<RealtimeVoiceLoopReport>;
}

/* ------------------------------------------------------------------ *
 * Per-turn streaming STT feed: a push-driven AsyncIterable the bridge
 * consumes while the segmenter is still assembling the utterance.
 * ------------------------------------------------------------------ */

interface SttFeed {
  push(chunk: AudioChunk): void;
  end(): void;
  finals: Promise<string>;
}

function startSttFeed(bridge: StreamingSpeechToTextBridge, format: AudioFormat): SttFeed {
  const queue: AudioChunk[] = [];
  let notify: (() => void) | null = null;
  let ended = false;

  async function* iterate(): AsyncIterable<AudioChunk> {
    for (;;) {
      if (queue.length > 0) {
        yield queue.shift() as AudioChunk;
        continue;
      }
      if (ended) return;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
  }

  const finals = (async () => {
    const texts: string[] = [];
    try {
      for await (const chunk of bridge.transcribeStream(iterate())) {
        if (chunk.is_final && chunk.text.trim()) texts.push(chunk.text.trim());
      }
    } catch (err) {
      logger.warn(
        `[realtime-voice-loop] streaming STT failed mid-turn: ${err instanceof Error ? err.message : err}`
      );
    }
    return texts.join(' ');
  })();

  const wake = (): void => {
    notify?.();
    notify = null;
  };

  return {
    push: (chunk) => {
      if (ended) return;
      queue.push({ ...chunk, format });
      wake();
    },
    end: () => {
      ended = true;
      wake();
    },
    finals,
  };
}

const STREAMING_STT_FLUSH_TIMEOUT_MS = 5000;

export async function startRealtimeVoiceLoop(
  options: RealtimeVoiceLoopOptions
): Promise<RealtimeVoiceLoopHandle> {
  const requireConsent = options.consent?.requireRecordingConsent ?? true;
  if (requireConsent) {
    const consent = checkMeetingParticipationConsent({
      ...(options.consent?.missionId ? { mission_id: options.consent.missionId } : {}),
      ...(options.consent?.tenantSlug ? { tenant_slug: options.consent.tenantSlug } : {}),
      purpose: 'recording',
    });
    if (!consent.allowed) {
      throw new Error(`[realtime-voice-loop] recording consent missing: ${consent.reason}`);
    }
  }

  const sampleRateHz = options.mic?.sampleRateHz ?? 16_000;
  const format: AudioFormat = { encoding: 'pcm_s16le', sample_rate_hz: sampleRateHz, channels: 1 };
  safeMkdir(options.recordingDir, { recursive: true });

  const segmenter = new VadTurnSegmenter({
    ...options.vad,
  });
  const bargeInEnabled = options.bargeIn?.enabled ?? false;
  const bargeInMultiplier = options.bargeIn?.thresholdMultiplier ?? 2;
  const bargeInMinSpeechMs = options.bargeIn?.minSpeechMs ?? 250;
  const idleTimeoutMs = options.idleTimeoutMs ?? 120_000;
  const play = options.play ?? ((audioPath: string) => playAudioFile(audioPath));

  const mic = await startMicCapture({ ...options.mic, sampleRateHz });
  const trace = options.trace;
  trace?.addEvent('realtime_voice.loop_start', {
    barge_in: bargeInEnabled,
    streaming_stt: Boolean(options.streamingStt),
  });

  let state: RealtimeVoiceLoopState = 'listening';
  let selfAudioSuppressionUntilMs = 0;
  let lastEmittedState: string | null = null;
  const emitState = (value: RealtimeVoiceLoopState | 'calibrating'): void => {
    if (value === lastEmittedState) return;
    lastEmittedState = value;
    options.onEvent?.({ kind: 'state', state: value });
  };

  let stopping = false;
  let turnsCompleted = 0;
  let interruptions = 0;
  let endedBy: RealtimeVoiceLoopReport['ended_by'] = 'stream_end';
  let loopError: string | undefined;

  let speech: SegmentedSpeechController | null = null;
  let pendingTurn: Promise<void> | null = null;
  let sttFeed: SttFeed | null = null;
  let bargedDuringTurn = false;

  // Barge-in detector state (only while SPEAKING).
  let bargeVad: EnergyVad | null = null;
  let bargeSpeechMs = 0;
  let bargeChunks: AudioChunk[] = [];

  const armBargeVad = (): void => {
    const base = segmenter.rmsThreshold > 0 ? segmenter.rmsThreshold : 800;
    bargeVad = new EnergyVad({
      rms_threshold: Math.round(base * bargeInMultiplier),
      endpoint_ms: 10 ** 9, // endpoint never fires; we only use `speaking`
    });
    bargeSpeechMs = 0;
    bargeChunks = [];
  };

  const processTurn = async (turnIndex: number, feed: SttFeed | null) => {
    const turnLabel = String(turnIndex + 1).padStart(2, '0');
    const audioPath = path.join(options.recordingDir, `turn-${turnLabel}.wav`);
    const segment = segmenter.takeSegment();
    safeWriteFile(audioPath, pcmToWav(segment.pcm, sampleRateHz));
    options.onEvent?.({
      kind: 'utterance_captured',
      turn: turnIndex,
      duration_ms: segment.durationMs,
      endpointed: segment.endpointed,
    });
    trace?.addEvent('realtime_voice.utterance', {
      turn: turnIndex,
      duration_ms: segment.durationMs,
      endpointed: segment.endpointed,
    });

    // 1. Transcript: streaming finals first, batch fallback.
    const sttStartedAt = Date.now();
    let userText = '';
    let sttMode: 'streaming' | 'batch' = 'batch';
    if (feed) {
      feed.end();
      const flushed = await Promise.race([
        feed.finals,
        new Promise<null>((resolve) => setTimeout(resolve, STREAMING_STT_FLUSH_TIMEOUT_MS, null)),
      ]);
      if (flushed) {
        userText = flushed;
        sttMode = 'streaming';
      } else if (flushed === null) {
        options.onEvent?.({
          kind: 'degraded',
          what: 'streaming-stt',
          reason: `no final transcript within ${STREAMING_STT_FLUSH_TIMEOUT_MS}ms; batch fallback`,
        });
      }
    }
    if (!userText) {
      userText = (await options.transcribe(audioPath)).trim();
      sttMode = 'batch';
    }
    const sttMs = Date.now() - sttStartedAt;
    if (!userText) {
      logger.warn(`[realtime-voice-loop] empty transcript for turn ${turnIndex + 1}; skipping`);
      state = 'listening';
      emitState(state);
      return;
    }

    // 2. Assistant reply.
    const llmStartedAt = Date.now();
    const assistantText = (await options.reply(userText, turnIndex)).trim();
    const llmMs = Date.now() - llmStartedAt;
    if (!assistantText) {
      logger.warn(`[realtime-voice-loop] empty reply for turn ${turnIndex + 1}; skipping speech`);
      state = 'listening';
      emitState(state);
      return;
    }

    // 3. Speak, sentence-pipelined; barge-in watches the mic meanwhile.
    bargedDuringTurn = false;
    if (bargeInEnabled) armBargeVad();
    state = 'speaking';
    emitState(state);
    speech = speakSegmented({
      text: assistantText,
      ...(options.maxSegmentChars ? { maxSegmentChars: options.maxSegmentChars } : {}),
      synthesize: (seg, index, signal) => options.synthesizeSegment(seg, index, turnIndex, signal),
      play,
    });
    const speechResult = await speech.done;
    speech = null;
    selfAudioSuppressionUntilMs = speechResult.interrupted
      ? 0
      : Date.now() +
        Math.max(0, options.selfAudioSuppressionMs ?? 0, options.postPlaybackDrainMs ?? 400);
    if (speechResult.error) {
      options.onEvent?.({ kind: 'degraded', what: 'playback', reason: speechResult.error });
    }

    const result: RealtimeVoiceLoopTurnResult = {
      turn: turnIndex,
      user_text: userText,
      assistant_text: assistantText,
      audio_path: audioPath,
      interrupted: speechResult.interrupted,
      stt_mode: sttMode,
      metrics: {
        listen_ms: segment.durationMs,
        stt_ms: sttMs,
        llm_ms: llmMs,
        tts_first_audio_ms: speechResult.metrics.first_audio_ms,
        speak_ms: speechResult.metrics.total_ms,
      },
    };
    trace?.addEvent('realtime_voice.turn', {
      turn: turnIndex,
      stt_mode: sttMode,
      interrupted: speechResult.interrupted,
      ...result.metrics,
    });
    turnsCompleted += 1;
    await options.onTurn?.(result);

    if (!bargedDuringTurn) {
      segmenter.reset();
      state = 'listening';
      emitState(state);
    }
    if (options.maxTurns !== undefined && turnsCompleted >= options.maxTurns) {
      endedBy = 'max_turns';
      stopping = true;
      await mic.stop();
    }
  };

  const run = async (): Promise<RealtimeVoiceLoopReport> => {
    emitState(segmenter.state === 'calibrating' ? 'calibrating' : 'listening');
    try {
      for await (const chunk of mic.chunks() as AsyncIterable<AudioChunk>) {
        if (stopping) break;

        if (state === 'listening' && Date.now() < selfAudioSuppressionUntilMs) {
          options.onEvent?.({
            kind: 'degraded',
            what: 'self_audio_suppressed',
            reason: 'post-playback drain window',
          });
          trace?.addEvent('realtime_voice.self_audio_suppressed', {
            reason: 'post_playback_drain',
          });
          continue;
        }

        if (state === 'listening') {
          const result = segmenter.push(chunk);
          emitState(result.state === 'calibrating' ? 'calibrating' : 'listening');
          if (result.onset && options.streamingStt) {
            sttFeed = startSttFeed(options.streamingStt, format);
            if (result.onsetPreroll?.length) {
              sttFeed.push({
                format,
                payload: new Uint8Array(result.onsetPreroll),
                ts_ms: chunk.ts_ms,
              });
            }
            sttFeed.push(chunk);
          } else if (result.state === 'recording' && !result.onset) {
            sttFeed?.push(chunk);
          }
          if (result.endpoint || result.capped) {
            state = 'thinking';
            emitState(state);
            const feed = sttFeed;
            sttFeed = null;
            pendingTurn = processTurn(turnsCompleted, feed)
              .catch((err) => {
                loopError = err instanceof Error ? err.message : String(err);
                endedBy = 'error';
                stopping = true;
              })
              .finally(() => {
                pendingTurn = null;
              });
          } else if (result.state === 'listening' && segmenter.listenedMs >= idleTimeoutMs) {
            endedBy = 'idle_timeout';
            break;
          }
          continue;
        }

        if (state === 'speaking' && bargeInEnabled && bargeVad) {
          const vadState = bargeVad.ingest(chunk);
          if (vadState.speaking) {
            bargeSpeechMs += computeChunkDurationMs(chunk);
            bargeChunks.push(chunk);
            if (bargeSpeechMs >= bargeInMinSpeechMs && speech) {
              bargedDuringTurn = true;
              interruptions += 1;
              options.onEvent?.({ kind: 'barge_in', turn: turnsCompleted });
              trace?.addEvent('realtime_voice.barge_in', { turn: turnsCompleted });
              const controller = speech;
              const interruptedTurn = pendingTurn;
              await controller.stop();
              // The old processTurn owns the current turn's counters and
              // callbacks. Finish it before accepting a new endpoint so a
              // barged turn cannot race with the interrupted turn.
              if (interruptedTurn) await interruptedTurn;
              // Re-arm listening and replay the interrupting audio so the
              // barged utterance keeps its first syllables.
              segmenter.reset();
              state = 'listening';
              emitState(state);
              const replay = bargeChunks;
              bargeChunks = [];
              bargeVad = null;
              for (const replayChunk of replay) {
                const replayResult = segmenter.push(replayChunk);
                if (replayResult.onset && options.streamingStt) {
                  sttFeed = startSttFeed(options.streamingStt, format);
                  if (replayResult.onsetPreroll?.length) {
                    sttFeed.push({
                      format,
                      payload: new Uint8Array(replayResult.onsetPreroll),
                      ts_ms: replayChunk.ts_ms,
                    });
                  }
                  sttFeed.push(replayChunk);
                } else if (replayResult.state === 'recording' && !replayResult.onset) {
                  sttFeed?.push(replayChunk);
                }
              }
            }
          } else {
            bargeSpeechMs = 0;
            bargeChunks = [];
          }
          continue;
        }

        // 'thinking', or 'speaking' without barge-in: half-duplex, drop the chunk.
      }
    } catch (err) {
      loopError = err instanceof Error ? err.message : String(err);
      endedBy = 'error';
    } finally {
      await mic.stop();
      // Stop speech BEFORE awaiting the pending turn: the turn promise
      // awaits speech.done, so the reverse order would wait out the
      // whole remaining audio instead of cutting it.
      if (speech) await speech.stop();
      if (pendingTurn) await pendingTurn;
      await segmenter.dispose();
    }
    if (stopping && endedBy === 'stream_end') endedBy = 'stopped';
    trace?.addEvent('realtime_voice.loop_end', {
      turns: turnsCompleted,
      interruptions,
      ended_by: endedBy,
    });
    return {
      turns_completed: turnsCompleted,
      interruptions,
      ended_by: endedBy,
      ...(loopError ? { error: loopError } : {}),
    };
  };

  const done = run();

  return {
    done,
    stop: async () => {
      stopping = true;
      endedBy = 'stopped';
      await mic.stop();
      return done;
    },
  };
}
