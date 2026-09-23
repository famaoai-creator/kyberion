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
 * Barge-in (opt-in, `bargeIn.mode`): while SPEAKING the loop keeps
 * watching the mic with a second, deliberately less sensitive energy VAD
 * (threshold × multiplier + a sustained-speech debounce so speaker echo
 * does not self-interrupt). 'legacy' stops playback on sustained speech;
 * 'two_stage' only pauses playback, confirms the interruption with a
 * streaming-STT partial that contains words, and otherwise resumes. A
 * confirmed barge-in aborts the turn token and replays the interrupting
 * audio into the segmenter so the barged utterance is not lost. Default
 * is half-duplex: mic input is ignored while the assistant speaks.
 *
 * Turn-taking contract (see realtime-media-session-architecture §13):
 * every reply turn owns one cancellation token that fans out to the
 * reasoning call, playback and trace; finals that trail off are held and
 * joined with the next utterance (`eotHold`); fillers and own-TTS echo
 * never reach reasoning (`respondGate`).
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
import { computeChunkDurationMs } from './voice-activity-detector.js';
import { TwoStageBargeIn, type BargeInAction } from './two-stage-barge-in.js';
import { EotHoldAggregator } from './voice-eot-scorer.js';
import {
  isOwnTtsEcho,
  shouldRespondToVoiceTurn,
  type OwnTtsEchoContext,
} from './voice-respond-gate.js';
import {
  VoiceTurnCancellationCoordinator,
  type VoiceTurnCancelReason,
  type VoiceTurnCancellationToken,
} from './voice-turn-cancellation.js';
import {
  resolveSpeculativePolicy,
  transcriptsMatchForSpeculation,
  type ResolveSpeculativePolicyInput,
} from './voice-speculative-policy.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { t } from './t.js';
import type { SupportedLocale } from './locale.js';
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
  /** two_stage: sustained speech paused playback; words have not confirmed it yet. */
  | { kind: 'barge_in_provisional'; turn: number }
  /** two_stage: the provisional pause was echo or word-less noise; playback resumed. */
  | { kind: 'barge_in_resumed'; turn: number; reason: 'no_words' | 'echo' }
  | { kind: 'turn_cancelled'; turn: number; reason: VoiceTurnCancelReason }
  | { kind: 'degraded'; what: string; reason: string };

export type RealtimeVoiceBargeInMode = 'off' | 'legacy' | 'two_stage';

export const VOICE_BARGE_IN_MODE_ENV = 'KYBERION_VOICE_BARGE_IN_MODE';

const BARGE_IN_MODES: readonly RealtimeVoiceBargeInMode[] = ['off', 'legacy', 'two_stage'];

function isBargeInMode(value: string): value is RealtimeVoiceBargeInMode {
  return (BARGE_IN_MODES as readonly string[]).includes(value);
}

/**
 * Effective barge-in mode: a valid `KYBERION_VOICE_BARGE_IN_MODE` overrides
 * the option, then `mode`, then the historical `enabled: true` ⇒ 'legacy'.
 */
export function resolveRealtimeVoiceBargeInMode(
  bargeIn?: { enabled?: boolean; mode?: RealtimeVoiceBargeInMode },
  env?: Record<string, string | undefined>
): RealtimeVoiceBargeInMode {
  const override = getRegisteredEnvText(VOICE_BARGE_IN_MODE_ENV, env ? { env } : {})?.trim();
  if (override) {
    if (isBargeInMode(override)) return override;
    logger.warn(
      `[realtime-voice-loop] ignoring ${VOICE_BARGE_IN_MODE_ENV}=${override} (expected ${BARGE_IN_MODES.join('|')})`
    );
  }
  if (bargeIn?.mode) return bargeIn.mode;
  return bargeIn?.enabled ? 'legacy' : 'off';
}

/** Localized one-line operator text for a loop event (null = not worth printing). */
export function describeRealtimeVoiceLoopEvent(
  event: RealtimeVoiceLoopEvent,
  locale?: SupportedLocale
): string | null {
  switch (event.kind) {
    case 'state':
      switch (event.state) {
        case 'calibrating':
          return t('voice:loop_state_calibrating', undefined, locale);
        case 'listening':
          return t('voice:loop_state_listening', undefined, locale);
        case 'thinking':
          return t('voice:loop_state_thinking', undefined, locale);
        case 'speaking':
          return t('voice:loop_state_speaking', undefined, locale);
        default:
          return null;
      }
    case 'barge_in':
      return t('voice:loop_barge_in', undefined, locale);
    case 'barge_in_provisional':
      return t('voice:loop_barge_in_provisional', undefined, locale);
    case 'barge_in_resumed':
      return t('voice:loop_barge_in_resumed', { reason: event.reason }, locale);
    case 'turn_cancelled':
      return t('voice:loop_turn_cancelled', { turn: event.turn + 1, reason: event.reason }, locale);
    case 'utterance_captured':
      return t(
        event.endpointed ? 'voice:loop_utterance_endpoint' : 'voice:loop_utterance_cap',
        { seconds: (event.duration_ms / 1000).toFixed(1) },
        locale
      );
    case 'degraded':
      return t('voice:loop_degraded', { what: event.what, reason: event.reason }, locale);
    default:
      return null;
  }
}

export interface RealtimeVoiceLoopOptions {
  /** Directory for per-turn user WAVs (created if missing). */
  recordingDir: string;
  mic?: MicCaptureOptions;
  /** Segmenter tuning (threshold, endpoint, calibration, pre-roll, cap). */
  vad?: Omit<VadTurnSegmenterOptions, 'maxUtteranceMs'> & { maxUtteranceMs?: number };
  /**
   * Barge-in. `mode` selects 'off' | 'legacy' | 'two_stage'; `enabled: true`
   * without a mode keeps the legacy stop-on-sustained-speech behaviour.
   * `thresholdMultiplier` scales the speech threshold while the assistant is
   * speaking (default 2), `minSpeechMs` is the legacy sustained-speech
   * debounce (default 250ms). The two_stage timings default to 150ms
   * provisional speech, 600ms words grace and a 700ms no-STT fallback.
   * `KYBERION_VOICE_BARGE_IN_MODE` overrides the mode.
   */
  bargeIn?: {
    enabled?: boolean;
    mode?: RealtimeVoiceBargeInMode;
    thresholdMultiplier?: number;
    minSpeechMs?: number;
    provisionalSpeechMs?: number;
    wordsGraceMs?: number;
    fallbackHardStopSpeechMs?: number;
  };
  /**
   * Hold a final transcript that trails off (Japanese continuation particle,
   * filler, English conjunction) and join it with the next utterance; a held
   * turn commits after `maxHoldMs` (default 1500) of listening silence.
   */
  eotHold?: { enabled: boolean; maxHoldMs?: number; commitThreshold?: number };
  /**
   * Skip reasoning for filler-only turns and — when the mic is open during
   * playback (barge-in not 'off') — for the assistant's own TTS echo.
   */
  respondGate?: { enabled: boolean };
  /**
   * Speculative reply (explicit opt-in; `KYBERION_VOICE_SPECULATIVE_REPLY=1`
   * when `enabled` is unset). After a tentative silence inside an utterance
   * the loop starts `streamReply` on the streaming-STT partial and only
   * buffers its segments; nothing is spoken or published before the final
   * transcript matches. Resumed speech or a mismatch aborts it
   * ('eot_revoked'). Forced off on battery / metered backends. Needs
   * `streamReply` and `streamingStt`.
   */
  speculativeReply?: { enabled?: boolean } & Omit<ResolveSpeculativePolicyInput, 'option' | 'env'>;
  /** Upstream abort: cancels the live turn ('external') and stops the loop. */
  signal?: AbortSignal;
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
  reply: (userText: string, turn: number, signal?: AbortSignal) => Promise<string>;
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

function startSttFeed(
  bridge: StreamingSpeechToTextBridge,
  format: AudioFormat,
  onText?: (text: string, isFinal: boolean) => void
): SttFeed {
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
        if (chunk.text.trim()) onText?.(chunk.text.trim(), chunk.is_final);
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
  const bargeInMode = resolveRealtimeVoiceBargeInMode(options.bargeIn);
  const bargeInMultiplier = options.bargeIn?.thresholdMultiplier ?? 2;
  const bargeInMinSpeechMs = options.bargeIn?.minSpeechMs ?? 250;
  const eot = options.eotHold?.enabled
    ? new EotHoldAggregator({
        ...(options.eotHold.maxHoldMs !== undefined
          ? { maxHoldMs: options.eotHold.maxHoldMs }
          : {}),
        ...(options.eotHold.commitThreshold !== undefined
          ? { commitThreshold: options.eotHold.commitThreshold }
          : {}),
      })
    : null;
  const respondGateEnabled = options.respondGate?.enabled ?? false;
  const speculativePolicy = resolveSpeculativePolicy({
    ...(options.speculativeReply ?? {}),
    option: options.speculativeReply?.enabled,
  });
  const speculationEnabled =
    speculativePolicy.enabled && Boolean(options.streamReply && options.streamingStt);
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
    barge_in: bargeInMode !== 'off',
    barge_in_mode: bargeInMode,
    eot_hold: Boolean(eot),
    respond_gate: respondGateEnabled,
    speculative_reply: speculationEnabled,
    streaming_stt: Boolean(options.streamingStt),
  });
  if (speculativePolicy.enabled && !speculationEnabled) {
    options.onEvent?.({
      kind: 'degraded',
      what: 'speculative_reply',
      reason: 'requires streamReply and streaming STT; disabled',
    });
  }

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
  let speechStop: Promise<unknown> | null = null;
  let pendingTurn: Promise<void> | null = null;
  let sttFeed: SttFeed | null = null;
  let bargedDuringTurn = false;
  let activeTurnIndex = 0;
  let spokenText = '';
  let lastAssistant: { text: string; endedAt: number } | null = null;

  const setSpeech = (
    controller: SegmentedSpeechController | StreamingVoicePlaybackController | null
  ): void => {
    speech = controller;
    speechStop = null;
  };
  // Memoized so token listeners and barge-in paths share one stop() call.
  const stopSpeech = async (): Promise<void> => {
    const controller = speech;
    if (!controller) return;
    speechStop ??= controller.stop();
    await speechStop;
  };

  // Barge-in detector state (only while SPEAKING).
  let bargeController: BargeInController | null = null;
  let twoStage: TwoStageBargeIn | null = null;
  let bargeFeed: SttFeed | null = null;
  let bargePartials: string[] = [];

  const closeBargeFeed = (): void => {
    bargeFeed?.end();
    bargeFeed = null;
    bargePartials = [];
  };

  // One cancellation token per reply turn; handle.stop() and the upstream
  // signal abort whichever turn is live as 'external'.
  const cancellation = new VoiceTurnCancellationCoordinator();
  const externalAbort = new AbortController();
  // Speculative inference has its own token: it is not a turn until adopted.
  const speculation = new VoiceTurnCancellationCoordinator();
  const unbindExternal = [
    cancellation.bindExternal(externalAbort.signal),
    speculation.bindExternal(externalAbort.signal),
  ];
  if (options.signal) {
    unbindExternal.push(
      cancellation.bindExternal(options.signal),
      speculation.bindExternal(options.signal)
    );
  }

  interface SpeculativeReply {
    partial: string;
    token: VoiceTurnCancellationToken;
    result: Promise<string>;
    buffer: string[];
    sink: ((segment: string) => void) | null;
  }
  let speculative: SpeculativeReply | null = null;
  let transcriptFinals: string[] = [];
  let transcriptPartial = '';
  let recordingSilenceMs = 0;

  const startSpeculation = (partial: string, turnIndex: number): void => {
    const token = speculation.arm(`${sessionId}:speculative:${turnIndex + 1}`);
    const spec: SpeculativeReply = {
      partial,
      token,
      buffer: [],
      sink: null,
      result: Promise.resolve(''),
    };
    // Buffer only: segments reach playback and the media stream after adoption.
    spec.result = options.streamReply!(
      partial,
      turnIndex,
      (segment) => {
        if (token.aborted) return;
        if (spec.sink) spec.sink(segment);
        else spec.buffer.push(segment);
      },
      token.signal
    );
    spec.result.catch(() => undefined);
    speculative = spec;
    trace?.addEvent('realtime_voice.speculative_started', { turn: turnIndex });
  };

  const abortSpeculation = (reason: VoiceTurnCancelReason): void => {
    if (!speculative) return;
    speculative.token.abort(reason);
    speculative = null;
    trace?.addEvent('realtime_voice.speculative_aborted', { reason });
  };

  /** The live speculation when it was based on `userText`; otherwise it is revoked. */
  const takeSpeculation = (userText: string): SpeculativeReply | null => {
    const spec = speculative;
    if (!spec) return null;
    speculative = null;
    if (transcriptsMatchForSpeculation(spec.partial, userText)) {
      trace?.addEvent('realtime_voice.speculative_adopted', {});
      return spec;
    }
    spec.token.abort('eot_revoked');
    trace?.addEvent('realtime_voice.speculative_aborted', { reason: 'eot_revoked' });
    return null;
  };

  /** Speculation bookkeeping for one listening chunk of the current utterance. */
  const observeSpeculation = (
    result: { state: string; onset: boolean; speaking: boolean },
    chunk: AudioChunk
  ): void => {
    if (result.onset) {
      transcriptFinals = [];
      transcriptPartial = '';
      recordingSilenceMs = 0;
      return;
    }
    if (result.state !== 'recording') return;
    if (result.speaking) {
      recordingSilenceMs = 0;
      abortSpeculation('eot_revoked');
      return;
    }
    recordingSilenceMs += computeChunkDurationMs(chunk);
    const soFar = [...transcriptFinals, transcriptPartial].filter(Boolean).join(' ').trim();
    if (
      !speculative &&
      recordingSilenceMs >= speculativePolicy.tentativeSilenceMs &&
      soFar.length >= speculativePolicy.minPartialChars
    ) {
      startSpeculation(soFar, segmentsCaptured);
    }
  };

  const onTranscriptText = (text: string, isFinal: boolean): void => {
    if (isFinal) {
      transcriptFinals.push(text);
      transcriptPartial = '';
    } else {
      transcriptPartial = text;
    }
  };

  const armTurnToken = (
    turnIndex: number
  ): { token: VoiceTurnCancellationToken; release: () => void } => {
    // arm() does not cancel the previous turn; a still-live one is superseded.
    cancellation.abortCurrent('barge_in');
    const token = cancellation.arm(`${sessionId}:turn:${turnIndex + 1}`);
    const release = token.onAbort((reason) => {
      options.onEvent?.({ kind: 'turn_cancelled', turn: turnIndex, reason });
      trace?.addEvent('realtime_voice.turn_cancelled', { turn: turnIndex, reason });
      closeBargeFeed();
      void stopSpeech();
    });
    return { token, release };
  };

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

  const armBargeIn = (): void => {
    const base = segmenter.rmsThreshold > 0 ? segmenter.rmsThreshold : 800;
    bargeController = null;
    twoStage = null;
    closeBargeFeed();
    if (bargeInMode === 'legacy') {
      bargeController = new BargeInController({
        base_rms_threshold: base,
        threshold_multiplier: bargeInMultiplier,
        min_speech_ms: bargeInMinSpeechMs,
      });
    } else if (bargeInMode === 'two_stage') {
      twoStage = new TwoStageBargeIn({
        base_rms_threshold: base,
        threshold_multiplier: bargeInMultiplier,
        ...(options.bargeIn?.provisionalSpeechMs !== undefined
          ? { provisional_speech_ms: options.bargeIn.provisionalSpeechMs }
          : {}),
        ...(options.bargeIn?.wordsGraceMs !== undefined
          ? { words_grace_ms: options.bargeIn.wordsGraceMs }
          : {}),
        ...(options.bargeIn?.fallbackHardStopSpeechMs !== undefined
          ? { fallback_hard_stop_speech_ms: options.bargeIn.fallbackHardStopSpeechMs }
          : {}),
        streaming_stt: Boolean(options.streamingStt),
        isEcho: (partial) =>
          isOwnTtsEcho(partial, { recentAssistantText: spokenText, speaking: true }),
      });
    }
  };

  /** Feed replayed chunks into the segmenter (and a fresh STT feed on onset). */
  const replayIntoSegmenter = (replay: AudioChunk[]): void => {
    for (const replayChunk of replay) {
      const replayResult = segmenter.push(replayChunk);
      if (speculationEnabled) observeSpeculation(replayResult, replayChunk);
      if (replayResult.onset && options.streamingStt) {
        sttFeed = startSttFeed(
          options.streamingStt,
          format,
          speculationEnabled ? onTranscriptText : undefined
        );
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
  };

  /** Mic-open own-TTS echo context; half-duplex already suppresses self audio. */
  const echoContext = (): OwnTtsEchoContext =>
    bargeInMode === 'off' || !lastAssistant
      ? {}
      : {
          recentAssistantText: lastAssistant.text,
          ageMs: Date.now() - lastAssistant.endedAt,
          speaking: false,
        };

  interface CapturedUtterance {
    turnIndex: number;
    audioPath: string;
    userText: string;
    sttMode: 'streaming' | 'batch';
    sttMs: number;
    listenMs: number;
  }
  let heldUtterance: CapturedUtterance | null = null;

  const captureUtterance = async (
    turnIndex: number,
    feed: SttFeed | null
  ): Promise<CapturedUtterance | null> => {
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
      abortSpeculation('eot_revoked');
      state = 'listening';
      emitState(state);
      return null;
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
    return { turnIndex, audioPath, userText, sttMode, sttMs, listenMs: segment.durationMs };
  };

  const backToListening = (): void => {
    segmenter.reset();
    state = 'listening';
    emitState(state);
  };

  const respondTo = async (utterance: CapturedUtterance): Promise<void> => {
    const { turnIndex, userText } = utterance;
    if (respondGateEnabled) {
      const gate = shouldRespondToVoiceTurn(userText, echoContext());
      if (!gate.respond) {
        const reason = gate.reason ?? 'not_addressed';
        abortSpeculation('external');
        options.onEvent?.({ kind: 'degraded', what: 'respond_gate', reason });
        trace?.addEvent('realtime_voice.respond_gate_dropped', { turn: turnIndex, reason });
        backToListening();
        return;
      }
    }
    const { token, release } = armTurnToken(turnIndex);
    activeTurnIndex = turnIndex;
    try {
      await replyAndSpeak(utterance, token);
    } finally {
      // Released before any loop shutdown so a finished turn is never reported cancelled.
      release();
    }
    if (options.maxTurns !== undefined && turnsCompleted >= options.maxTurns) {
      endedBy = 'max_turns';
      stopping = true;
      await mic.stop();
    }
  };

  const replyAndSpeak = async (
    utterance: CapturedUtterance,
    token: VoiceTurnCancellationToken
  ): Promise<void> => {
    const { turnIndex, audioPath, userText, sttMode, sttMs } = utterance;
    // 2. Assistant reply.
    const llmStartedAt = Date.now();
    let assistantText = '';
    let speechResult: Awaited<SegmentedSpeechController['done']> | null = null;
    spokenText = '';
    const adopted = takeSpeculation(userText);
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
      setSpeech(streamingSpeech);
      bargedDuringTurn = false;
      armBargeIn();
      state = 'speaking';
      emitState(state);
      const onSegment = (segment: string): void => {
        streamedSegments.push(segment);
        spokenText = streamedSegments.join(' ');
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
      };
      let unlinkSpeculation: (() => void) | null = null;
      try {
        if (adopted) {
          // The turn token now owns the speculative inference.
          unlinkSpeculation = token.onAbort((reason) => adopted.token.abort(reason));
          for (const segment of adopted.buffer.splice(0)) onSegment(segment);
          adopted.sink = onSegment;
          assistantText = (await adopted.result).trim();
        } else {
          assistantText = (
            await options.streamReply(userText, turnIndex, onSegment, token.signal)
          ).trim();
        }
      } catch (err) {
        if (!token.aborted) throw err;
        assistantText = streamedSegments.join(' ').trim();
      } finally {
        unlinkSpeculation?.();
        streamingSpeech.end();
      }
      speechResult = await streamingSpeech.done;
      setSpeech(null);
      if (!assistantText) assistantText = streamedSegments.join(' ').trim();
    } else {
      assistantText = (await options.reply(userText, turnIndex, token.signal)).trim();
    }
    const llmMs = Date.now() - llmStartedAt;
    if (!assistantText || (!speechResult && token.aborted)) {
      if (!assistantText) {
        logger.warn(`[realtime-voice-loop] empty reply for turn ${turnIndex + 1}; skipping speech`);
      }
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
      spokenText = assistantText;
      armBargeIn();
      state = 'speaking';
      emitState(state);
      const segmented = speakSegmented({
        text: assistantText,
        ...(options.maxSegmentChars ? { maxSegmentChars: options.maxSegmentChars } : {}),
        synthesize: (seg, index, signal) =>
          options.synthesizeSegment(seg, index, turnIndex, signal),
        play,
      });
      setSpeech(segmented);
      speechResult = await segmented.done;
      setSpeech(null);
    }
    // A provisional pause still open when playback ended: keep the user's audio.
    const pausedAudio = twoStage?.state === 'paused' ? twoStage.bufferedChunks() : [];
    twoStage = null;
    bargeController = null;
    closeBargeFeed();
    lastAssistant = { text: assistantText, endedAt: Date.now() };
    selfAudioSuppressionUntilMs =
      speechResult.interrupted || pausedAudio.length
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
        listen_ms: utterance.listenMs,
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
      backToListening();
      if (pausedAudio.length) replayIntoSegmenter(pausedAudio);
    }
  };

  const processUtterance = async (turnIndex: number, feed: SttFeed | null): Promise<void> => {
    const captured = await captureUtterance(turnIndex, feed);
    if (!captured) return;
    if (!eot) {
      await respondTo(captured);
      return;
    }
    const held = eot.offer(captured.userText);
    const merged: CapturedUtterance = heldUtterance
      ? {
          ...captured,
          userText: held.text,
          sttMs: heldUtterance.sttMs + captured.sttMs,
          listenMs: heldUtterance.listenMs + captured.listenMs,
        }
      : { ...captured, userText: held.text };
    if (!held.commit) {
      abortSpeculation('eot_revoked');
      heldUtterance = merged;
      trace?.addEvent('realtime_voice.eot_hold', { turn: turnIndex, chars: held.text.length });
      backToListening();
      return;
    }
    heldUtterance = null;
    await respondTo(merged);
  };

  const trackTurn = (work: Promise<void>): void => {
    pendingTurn = work
      .catch((err) => {
        loopError = err instanceof Error ? err.message : String(err);
        endedBy = 'error';
        stopping = true;
      })
      .finally(() => {
        pendingTurn = null;
      });
  };

  /** Apply two-stage decisions; returns the chunks to replay after a hard stop. */
  const applyBargeInActions = (actions: BargeInAction[]): AudioChunk[] | null => {
    for (const action of actions) {
      if (action.type === 'pause_tts') {
        speech?.pause?.();
        options.onEvent?.({ kind: 'barge_in_provisional', turn: activeTurnIndex });
        trace?.addEvent('realtime_voice.barge_in_provisional', { turn: activeTurnIndex });
        if (options.streamingStt && twoStage) {
          bargeFeed = startSttFeed(options.streamingStt, format, (text) => {
            bargePartials.push(text);
          });
          for (const buffered of twoStage.bufferedChunks()) bargeFeed.push(buffered);
        }
      } else if (action.type === 'resume_tts') {
        closeBargeFeed();
        speech?.resume?.();
        options.onEvent?.({
          kind: 'barge_in_resumed',
          turn: activeTurnIndex,
          reason: action.reason,
        });
        trace?.addEvent('realtime_voice.barge_in_resumed', {
          turn: activeTurnIndex,
          reason: action.reason,
        });
      } else if (action.type === 'hard_stop') {
        const replay = twoStage?.bufferedChunks() ?? [];
        closeBargeFeed();
        twoStage = null;
        return replay;
      }
    }
    return null;
  };

  /** Confirmed barge-in: cancel the turn, wait for it, then replay the user's audio. */
  const confirmBargeIn = async (replay: AudioChunk[], mode: RealtimeVoiceBargeInMode) => {
    bargedDuringTurn = true;
    interruptions += 1;
    options.onEvent?.({ kind: 'barge_in', turn: turnsCompleted });
    trace?.addEvent('realtime_voice.barge_in', { turn: turnsCompleted, mode });
    const interruptedTurn = pendingTurn;
    cancellation.abortCurrent('barge_in');
    await stopSpeech();
    // The old turn owns the current turn's counters and callbacks. Finish
    // it before accepting a new endpoint so a barged turn cannot race with
    // the interrupted turn.
    if (interruptedTurn) await interruptedTurn;
    // Re-arm listening and replay the interrupting audio so the barged
    // utterance keeps its first syllables.
    backToListening();
    bargeController = null;
    replayIntoSegmenter(replay);
  };

  const stopLoop = async (): Promise<void> => {
    stopping = true;
    endedBy = 'stopped';
    externalAbort.abort();
    await mic.stop();
  };
  const onUpstreamAbort = (): void => {
    void stopLoop();
  };
  if (options.signal?.aborted) onUpstreamAbort();
  else options.signal?.addEventListener('abort', onUpstreamAbort, { once: true });

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
          if (speculationEnabled) observeSpeculation(result, chunk);
          if (result.onset && options.streamingStt) {
            sttFeed = startSttFeed(
              options.streamingStt,
              format,
              speculationEnabled ? onTranscriptText : undefined
            );
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
            trackTurn(processUtterance(turnIndex, feed));
          } else if (result.state === 'listening' && eot && heldUtterance) {
            // A held turn commits once the speaker stays silent past maxHoldMs.
            const forced = eot.tick();
            if (forced?.commit) {
              const utterance = { ...heldUtterance, userText: forced.text };
              heldUtterance = null;
              state = 'thinking';
              emitState(state);
              trackTurn(respondTo(utterance));
            }
          } else if (result.state === 'listening' && segmenter.listenedMs >= idleTimeoutMs) {
            endedBy = 'idle_timeout';
            break;
          }
          continue;
        }

        if (state === 'speaking' && bargeInMode === 'two_stage' && twoStage) {
          const feedBefore = bargeFeed;
          const actions = twoStage.observeAudio(chunk);
          if (feedBefore && twoStage.state === 'paused') feedBefore.push(chunk);
          for (const partial of bargePartials.splice(0)) {
            actions.push(...twoStage.observePartial(partial));
          }
          const replay = applyBargeInActions(actions);
          if (replay && speech) await confirmBargeIn(replay, 'two_stage');
          continue;
        }

        if (state === 'speaking' && bargeInMode === 'legacy' && bargeController) {
          const observation = bargeController.observe(chunk);
          if (observation.triggered && speech) {
            await confirmBargeIn(observation.buffered_chunks, 'legacy');
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
      // Cancel the live turn BEFORE awaiting it: the turn promise awaits
      // speech.done, so the reverse order would wait out the whole
      // remaining audio instead of cutting it.
      cancellation.abortCurrent('external');
      abortSpeculation('external');
      await stopSpeech();
      closeBargeFeed();
      if (pendingTurn) await pendingTurn;
      await segmenter.dispose();
      for (const unbind of unbindExternal) unbind();
      options.signal?.removeEventListener('abort', onUpstreamAbort);
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
      await stopLoop();
      return done;
    },
  };
}
