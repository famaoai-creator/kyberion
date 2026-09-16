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

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { logger } from './core.js';
import { nowIso } from './foundation/time.js';
import { checkMeetingParticipationConsent } from './meeting-participation-coordinator.js';
import { startMicCapture, type MicCaptureOptions } from './mic-capture.js';
import { pcmToWav } from './pcm-wav.js';
import { playAudioFile, type PlaybackHandle } from './audio-playback.js';
import { assertSafeRepositoryPath, safeMkdir, safeWriteFile } from './secure-io.js';
import { speakSegmented, type SegmentedSpeechController } from './segmented-voice-playback.js';
import {
  streamVoicePlayback,
  streamTtsAudioPlayback,
  type StreamingVoicePlaybackController,
} from './streaming-voice-playback.js';
import type { StreamingTextToSpeechBridge } from './streaming-tts-bridge.js';
import { VadTurnSegmenter, type VadTurnSegmenterOptions } from './vad-turn-recorder.js';
import { BargeInController } from './barge-in-controller.js';
import type { TraceContext } from './src/trace.js';
import type { StreamingSpeechToTextBridge } from './streaming-stt-bridge.js';
import type { AudioChunk, AudioFormat } from './meeting-session-types.js';
import {
  MediaEventBuffer,
  transcriptChunkToMediaEvent,
  type MediaEvent,
} from './realtime-media-session.js';

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
  /** Artifacts returned by the governed voice actuator for this reply. */
  assistant_audio_paths: string[];
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
  /** Optional provider-native reply stream. Text segments are sent to TTS immediately. */
  streamReply?: (
    userText: string,
    turn: number,
    onSegment: (segment: string) => void | Promise<void>,
    signal?: AbortSignal
  ) => Promise<string>;
  /** Synthesize one reply segment to an audio file (sentence-level). */
  synthesizeSegment: (
    segment: string,
    segmentIndex: number,
    turn: number,
    signal?: AbortSignal
  ) => Promise<string>;
  /** Optional direct PCM stream synthesis; artifact synthesis remains the fallback. */
  synthesizeAudioStream?: (
    segment: string,
    segmentIndex: number,
    turn: number,
    signal?: AbortSignal
  ) => Promise<AsyncIterable<AudioChunk>>;
  /** Existing governed streaming-TTS bridge for direct PCM output. */
  streamingTts?: StreamingTextToSpeechBridge;
  voiceProfileId?: string;
  playAudioStream?: (audio: AsyncIterable<AudioChunk>, index: number) => PlaybackHandle;
  /** Play an audio file (default: platform player). */
  play?: (audioPath: string, segmentIndex: number) => PlaybackHandle;
  maxSegmentChars?: number;
  onEvent?: (event: RealtimeVoiceLoopEvent) => void;
  onTurn?: (turn: RealtimeVoiceLoopTurnResult) => void | Promise<void>;
  /** Optional canonical event buffer factory for live projections. */
  mediaEventBufferFactory?: (sessionId: string) => MediaEventBuffer;
  /** Stable session id for the canonical event stream; generated when omitted. */
  sessionId?: string;
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
  const recordingDir = assertSafeRepositoryPath(options.recordingDir, { allowMissingLeaf: true });
  safeMkdir(recordingDir, { recursive: true });

  const segmenter = new VadTurnSegmenter({
    ...options.vad,
  });
  const bargeInEnabled = options.bargeIn?.enabled ?? false;
  const bargeInMultiplier = options.bargeIn?.thresholdMultiplier ?? 2;
  const bargeInMinSpeechMs = options.bargeIn?.minSpeechMs ?? 250;
  const idleTimeoutMs = options.idleTimeoutMs ?? 120_000;
  const play = options.play ?? ((audioPath: string) => playAudioFile(audioPath));
  const trace = options.trace;
  const sessionId = options.sessionId?.trim() || `realtime-voice-${randomUUID()}`;
  const mediaEventBuffer = options.mediaEventBufferFactory?.(sessionId);
  const publishMediaEvent = (event: MediaEvent): void => {
    try {
      mediaEventBuffer?.append(event);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(`[realtime-voice-loop] media event observer failed: ${reason}`);
      trace?.addEvent('realtime_voice.media_event_failed', { reason });
    }
  };

  const mic = await startMicCapture({ ...options.mic, sampleRateHz });
  const loopStartedAt = Date.now();
  publishMediaEvent({
    event_id: `${sessionId}:started`,
    session_id: sessionId,
    type: 'session_started',
    at_ms: 0,
    emitted_at: nowIso(),
    source: 'realtime-voice-loop',
  });
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
  let segmentsCaptured = 0;
  let interruptions = 0;
  let endedBy: RealtimeVoiceLoopReport['ended_by'] = 'stream_end';
  let loopError: string | undefined;

  let speech: (SegmentedSpeechController | StreamingVoicePlaybackController) | null = null;
  let pendingTurn: Promise<void> | null = null;
  let sttFeed: SttFeed | null = null;
  let bargedDuringTurn = false;

  const observeAudioStream = (
    audio: AsyncIterable<AudioChunk>,
    turnIndex: number,
    source: string
  ): AsyncIterable<AudioChunk> =>
    (async function* (): AsyncGenerator<AudioChunk> {
      let chunkIndex = 0;
      for await (const chunk of audio) {
        publishMediaEvent({
          event_id: `${sessionId}:audio-output:${turnIndex + 1}:${chunkIndex++}`,
          session_id: sessionId,
          type: 'audio_output_delta',
          at_ms: Math.max(0, Date.now() - loopStartedAt),
          emitted_at: nowIso(),
          source,
          track_id: `${sessionId}:assistant:${turnIndex + 1}`,
          chunk,
          direction: 'output',
        });
        yield chunk;
      }
    })();

  // Barge-in detector state (only while SPEAKING).
  let bargeController: BargeInController | null = null;

  const armBargeVad = (): void => {
    const base = segmenter.rmsThreshold > 0 ? segmenter.rmsThreshold : 800;
    bargeController = new BargeInController({
      base_rms_threshold: base,
      threshold_multiplier: bargeInMultiplier,
      min_speech_ms: bargeInMinSpeechMs,
    });
  };

  const processTurn = async (turnIndex: number, feed: SttFeed | null) => {
    const turnLabel = String(turnIndex + 1).padStart(2, '0');
    const audioPath = assertSafeRepositoryPath(path.join(recordingDir, `turn-${turnLabel}.wav`), {
      allowMissingLeaf: true,
    });
    const segment = segmenter.takeSegment();
    safeWriteFile(audioPath, pcmToWav(segment.pcm, sampleRateHz));
    publishMediaEvent({
      event_id: `${sessionId}:speech-ended:${turnIndex + 1}`,
      session_id: sessionId,
      type: 'speech_ended',
      at_ms: Math.max(0, Date.now() - loopStartedAt),
      emitted_at: nowIso(),
      source: 'realtime-voice-loop',
      segment_id: `${sessionId}:segment:${turnIndex + 1}`,
      duration_ms: segment.durationMs,
    });
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
    publishMediaEvent(
      transcriptChunkToMediaEvent({
        session_id: sessionId,
        event_id: `${sessionId}:transcript:${turnIndex + 1}`,
        segment_id: `${sessionId}:segment:${turnIndex + 1}`,
        source:
          sttMode === 'streaming'
            ? options.streamingStt?.bridge_id || 'streaming-stt'
            : 'batch-stt',
        at_ms: Math.max(0, Date.now() - loopStartedAt),
        chunk: {
          utterance_id: `${sessionId}:utterance:${turnIndex + 1}`,
          is_final: true,
          text: userText,
          emitted_at: nowIso(),
          speaker_source: 'unknown',
        },
      })
    );

    // 2. Assistant reply.
    const llmStartedAt = Date.now();
    let assistantText = '';
    let speechResult: Awaited<SegmentedSpeechController['done']> | null = null;
    if (options.streamReply) {
      const streamedSegments: string[] = [];
      let assistantDeltaIndex = 0;
      const streamingSpeech =
        options.streamingTts && options.voiceProfileId
          ? streamTtsAudioPlayback({
              voiceProfileId: options.voiceProfileId,
              synthesizeStream: (segments, profileId) =>
                observeAudioStream(
                  options.streamingTts!.synthesizeStream(segments, profileId),
                  turnIndex,
                  `streaming-tts:${options.streamingTts!.bridge_id}`
                ),
              ...(options.playAudioStream ? { playStream: options.playAudioStream } : {}),
            })
          : streamVoicePlayback({
              synthesize: async (segment, index, signal) => {
                if (options.synthesizeAudioStream) {
                  return observeAudioStream(
                    await options.synthesizeAudioStream(segment, index, turnIndex, signal),
                    turnIndex,
                    'voice-actuator-stream'
                  );
                }
                return options.synthesizeSegment(segment, index, turnIndex, signal);
              },
              play,
            });
      speech = streamingSpeech;
      bargedDuringTurn = false;
      if (bargeInEnabled) armBargeVad();
      state = 'speaking';
      emitState(state);
      try {
        assistantText = (
          await options.streamReply(
            userText,
            turnIndex,
            (segment) => {
              streamedSegments.push(segment);
              publishMediaEvent({
                event_id: `${sessionId}:assistant:${turnIndex + 1}:delta:${assistantDeltaIndex++}`,
                session_id: sessionId,
                type: 'assistant_text_delta',
                at_ms: Math.max(0, Date.now() - loopStartedAt),
                emitted_at: nowIso(),
                source: 'realtime-voice-loop',
                text: segment,
                is_final: false,
                turn_id: `${sessionId}:turn:${turnIndex + 1}`,
              });
              streamingSpeech.push(segment);
            },
            streamingSpeech.signal
          )
        ).trim();
      } catch (err) {
        if (!streamingSpeech.signal.aborted) throw err;
        assistantText = streamedSegments.join(' ').trim();
      } finally {
        streamingSpeech.end();
      }
      speechResult = await streamingSpeech.done;
      speech = null;
      if (!assistantText) assistantText = streamedSegments.join(' ').trim();
    } else {
      assistantText = (await options.reply(userText, turnIndex)).trim();
    }
    const llmMs = Date.now() - llmStartedAt;
    if (!assistantText) {
      logger.warn(`[realtime-voice-loop] empty reply for turn ${turnIndex + 1}; skipping speech`);
      state = 'listening';
      emitState(state);
      return;
    }
    publishMediaEvent({
      event_id: `${sessionId}:assistant:${turnIndex + 1}`,
      session_id: sessionId,
      type: 'assistant_text_delta',
      at_ms: Math.max(0, Date.now() - loopStartedAt),
      emitted_at: nowIso(),
      source: 'realtime-voice-loop',
      text: assistantText,
      is_final: true,
      turn_id: `${sessionId}:turn:${turnIndex + 1}`,
    });

    // 3. Speak, sentence-pipelined; barge-in watches the mic meanwhile.
    if (!speechResult) {
      bargedDuringTurn = false;
      if (bargeInEnabled) armBargeVad();
      state = 'speaking';
      emitState(state);
      speech = speakSegmented({
        text: assistantText,
        ...(options.maxSegmentChars ? { maxSegmentChars: options.maxSegmentChars } : {}),
        synthesize: (seg, index, signal) =>
          options.synthesizeSegment(seg, index, turnIndex, signal),
        play,
      });
      speechResult = await speech.done;
      speech = null;
    }
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
      assistant_audio_paths: [...speechResult.audioPaths],
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
    publishMediaEvent({
      event_id: `${sessionId}:turn-completed:${turnIndex + 1}`,
      session_id: sessionId,
      type: 'turn_completed',
      at_ms: Math.max(0, Date.now() - loopStartedAt),
      emitted_at: nowIso(),
      source: 'realtime-voice-loop',
      turn_id: `${sessionId}:turn:${turnIndex + 1}`,
      interrupted: speechResult.interrupted,
    });
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
          if (result.onset) {
            publishMediaEvent({
              event_id: `${sessionId}:speech-started:${segmentsCaptured + 1}`,
              session_id: sessionId,
              type: 'speech_started',
              at_ms: Math.max(0, Date.now() - loopStartedAt),
              emitted_at: nowIso(),
              source: 'realtime-voice-loop',
              segment_id: `${sessionId}:segment:${turnsCompleted + 1}`,
            });
          }
          if (result.endpoint || result.capped) {
            state = 'thinking';
            emitState(state);
            const feed = sttFeed;
            sttFeed = null;
            const turnIndex = segmentsCaptured;
            segmentsCaptured += 1;
            pendingTurn = processTurn(turnIndex, feed)
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

        if (state === 'speaking' && bargeInEnabled && bargeController) {
          const observation = bargeController.observe(chunk);
          if (observation.triggered && speech) {
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
            const replay = observation.buffered_chunks;
            bargeController = null;
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
      publishMediaEvent({
        event_id: `${sessionId}:ended`,
        session_id: sessionId,
        type: 'session_ended',
        at_ms: Math.max(0, Date.now() - loopStartedAt),
        emitted_at: nowIso(),
        source: 'realtime-voice-loop',
        reason: endedBy,
      });
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
