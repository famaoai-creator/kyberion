/**
 * CE-02 wiring between the realtime voice loop and the ConversationEngine.
 * The loop supplies observations and output hooks; this module owns engine
 * construction, event stepping, action dispatch and listening-evidence
 * feeds — so `realtime-voice-loop.ts` stays an orchestrator, not a second
 * implementation of the deciders.
 */

import {
  VoiceTurnTakingMachine,
  LegacyBargeInArbiter,
  type TurnTakingAction,
  type TurnTakingInput,
} from './voice-turn-taking.js';
import type { SpeculativeReplyPolicy } from './voice-speculative-policy.js';
import type { AudioChunk } from '../meeting/meeting-session-types.js';
import { computeChunkDurationMs } from './voice-activity-detector.js';
import type { OwnTtsEchoContext } from './voice-respond-gate.js';
import { shouldRespondToVoiceTurn } from './voice-respond-gate.js';
import type { VoiceTurnCancelReason } from './voice-turn-cancellation.js';
import type { PlaybackHandle } from './audio-playback.js';
import type { StreamingTextToSpeechBridge } from './streaming-tts-bridge.js';
import type { MediaEvent } from '../realtime-media-session.js';
import { nowIso } from '../foundation/time.js';
import { randomUUID } from 'node:crypto';

export type EngineDecision = Extract<TurnTakingAction, { type: 'hold' | 'commit' | 'drop' }>;

export type VoiceLoopEngineBargeInMode = 'off' | 'legacy' | 'two_stage';

export interface VoiceLoopEngineOptions {
  bargeInMode: VoiceLoopEngineBargeInMode;
  bargeInMultiplier: number;
  bargeInMinSpeechMs: number;
  bargeIn?: {
    provisionalSpeechMs?: number;
    wordsGraceMs?: number;
    fallbackHardStopSpeechMs?: number;
  };
  eotHold?: { enabled?: boolean; commitThreshold?: number; maxHoldMs?: number };
  respondGateEnabled: boolean;
  speculationEnabled: boolean;
  speculativePolicy: SpeculativeReplyPolicy;
  streamingStt: boolean;
  interaction?: {
    intentShortcuts?: boolean;
    instantReaction?: boolean;
    rhythm?: boolean;
    backchannel?:
      boolean | { minSpeechMs?: number; minIntervalMs?: number; maxPerUtterance?: number };
  };
  /** The loop's calibrated RMS threshold (0 → fall back to module default). */
  calibratedRmsThreshold: number;
  echoContext: () => OwnTtsEchoContext;
}

/** Output/decision side effects the loop provides for engine actions. */
export interface VoiceLoopEngineHooks {
  emitBackchannel(text: string): void;
  /** Pause the reply output and seed the transcript probe with `buffered`. */
  pauseSpeech(buffered: AudioChunk[]): void;
  resumeSpeech(reason: 'no_words' | 'echo' | undefined): void;
  /** Stop a live reaction alongside speech actions (pause/resume/hard_stop). */
  pauseReaction(): void;
  resumeReaction(): void;
  stopReaction(): void;
  hardStopSpeech(replay: AudioChunk[]): void;
  startSpeculative(partial: string): void;
  abortSpeculative(reason: VoiceTurnCancelReason): void;
  enqueueDecision(action: EngineDecision): void;
  onWarn(reason: string): void;
  onBackchannelTrace(text: string): void;
}

/** Everything the CE→output reaction shortcut needs from the loop. */
export interface LoopReactionDeps {
  speakBackchannel?(text: string): Promise<void>;
  streamingTts?: StreamingTextToSpeechBridge;
  voiceProfileId?: string;
  playAudioStream?(stream: AsyncIterable<AudioChunk>, index: number): PlaybackHandle;
  synthesizeSegment?(segment: string, index: number, turnIndex: number): Promise<string>;
  play(audioPath: string, index: number): PlaybackHandle;
  observeAudioStream(
    stream: AsyncIterable<AudioChunk>,
    turnIndex: number,
    source: string
  ): AsyncIterable<AudioChunk>;
  publishMediaEvent(event: MediaEvent): void;
  onDegraded(what: string, reason: string): void;
  onTrace(name: string, attrs: Record<string, string | number | boolean>): void;
  /** Engine event feed (reaction_started / reaction_ended). */
  onEngine(input: TurnTakingInput): void;
  /** Echo view: reaction registered before playback begins. */
  onEchoAssistantStarted(text: string): void;
  /** Echo view after playback — must not evict a substantive reply. */
  onEchoAssistantEnded(text: string): void;
  /** Suppress mic echoes until `untilMs` (post-reaction drain). */
  onSuppressEcho(untilMs: number): void;
  rel(): number;
  sessionId: string;
  turnsCompleted(): number;
  /** Post-playback drain in ms (selfAudioSuppression / drain options). */
  drainMs(): number;
}

export interface LoopReactionEmitter {
  /** Fire-and-forget emission; a no-op while a reaction is in flight. */
  emit(text: string): void;
  inFlight(): boolean;
  pause(): void;
  resume(): void;
  stop(): void;
  done(): Promise<void>;
}

/**
 * The CE→TTS shortcut: reaction/backchannel audio without a reasoning call.
 * Owns `reactionInFlight`/`handle` so output control (pause/resume/stop) can
 * target a live reaction alongside reply speech.
 */
export function createLoopReactionEmitter(deps: LoopReactionDeps): LoopReactionEmitter {
  let handle: PlaybackHandle | null = null;
  let inFlight = false;

  const emit = async (text: string): Promise<void> => {
    if (!text.trim() || inFlight) return;
    inFlight = true;
    deps.onEngine({ type: 'reaction_started', at_ms: deps.rel(), text });
    // Echo context must see the reaction immediately — a fast mic echo can
    // endpoint before playback finishes.
    deps.onEchoAssistantStarted(text);
    deps.publishMediaEvent({
      event_id: `${deps.sessionId}:backchannel:${randomUUID()}`,
      session_id: deps.sessionId,
      type: 'assistant_text_delta',
      at_ms: deps.rel(),
      emitted_at: nowIso(),
      source: 'interaction-backchannel',
      text,
      is_final: true,
    });
    let local: PlaybackHandle | null = null;
    let interrupted = false;
    try {
      if (deps.speakBackchannel) {
        await deps.speakBackchannel(text);
      } else if (deps.streamingTts && deps.voiceProfileId && deps.playAudioStream) {
        const stream = await deps.streamingTts.synthesizeStream(
          (async function* (): AsyncGenerator<string> {
            yield text;
          })(),
          deps.voiceProfileId
        );
        local = deps.playAudioStream(
          deps.observeAudioStream(stream, deps.turnsCompleted(), 'interaction-backchannel'),
          -1
        );
        handle = local;
        interrupted = (await local.done).interrupted;
      } else if (deps.synthesizeSegment) {
        const audioPath = await deps.synthesizeSegment(text, -1, deps.turnsCompleted());
        local = deps.play(audioPath, -1);
        handle = local;
        interrupted = (await local.done).interrupted;
      }
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      deps.onDegraded('backchannel', reason);
      deps.onTrace('realtime_voice.backchannel_failed', { reason });
    } finally {
      if (handle === local) handle = null;
      inFlight = false;
      // Drain the mic briefly so the reaction's own tail cannot trigger a
      // false onset — skipped when the user cut the reaction (their speech
      // is already in flight and must not be swallowed).
      deps.onSuppressEcho(interrupted ? 0 : Date.now() + Math.max(0, deps.drainMs()));
      deps.onEchoAssistantEnded(text);
      deps.onEngine({ type: 'reaction_ended', at_ms: deps.rel() });
    }
  };

  return {
    emit: (text) => void emit(text),
    inFlight: () => inFlight,
    pause: () => {
      // Same semantics as the reply path: suspend; only stop if the player
      // cannot pause (e.g. Windows).
      if (handle && handle.pause?.() !== true) void handle.stop();
    },
    resume: () => handle?.resume?.(),
    stop: () => void handle?.stop(),
    done: async () => {
      await handle?.done;
    },
  };
}

export interface VoiceLoopEngine {
  readonly machine: VoiceTurnTakingMachine;
  /** Step the engine; failures are logged via `onWarn` and return []. */
  drive(input: TurnTakingInput): TurnTakingAction[];
  /** Step the engine and dispatch all resulting actions. */
  driveAndApply(input: TurnTakingInput): void;
  apply(actions: readonly TurnTakingAction[]): void;
  /** Evidence buffered by the arbiter while probing an interruption. */
  arbiterBuffered(): AudioChunk[];
  /**
   * Pause/resume transitions + a tick (with pause evidence) for one chunk
   * while the floor is remote — shared by the live and replayed chunk paths.
   */
  feedListeningEvidence(
    result: { state: string; onset: boolean; speaking: boolean },
    chunk: AudioChunk,
    relMs: number
  ): void;
}

export function createVoiceLoopEngine(
  options: VoiceLoopEngineOptions,
  hooks: VoiceLoopEngineHooks
): VoiceLoopEngine {
  const engineBaseRms = options.calibratedRmsThreshold > 0 ? options.calibratedRmsThreshold : 800;
  const interactionOpts = options.interaction;
  const machine = new VoiceTurnTakingMachine({
    streaming_stt: options.streamingStt,
    // The arbiter needs the loop's calibrated threshold, not the module
    // default — otherwise quiet mics never confirm an interruption.
    ...(options.bargeInMode === 'off' ? { arbiter: null } : {}),
    ...(options.bargeInMode === 'legacy'
      ? {
          arbiter: new LegacyBargeInArbiter({
            base_rms_threshold: engineBaseRms,
            threshold_multiplier: options.bargeInMultiplier,
            min_speech_ms: options.bargeInMinSpeechMs,
          }),
        }
      : {}),
    barge_in: {
      base_rms_threshold: engineBaseRms,
      threshold_multiplier: options.bargeInMultiplier,
      ...(options.bargeIn?.provisionalSpeechMs !== undefined
        ? { provisional_speech_ms: options.bargeIn.provisionalSpeechMs }
        : {}),
      ...(options.bargeIn?.wordsGraceMs !== undefined
        ? { words_grace_ms: options.bargeIn.wordsGraceMs }
        : {}),
      ...(options.bargeIn?.fallbackHardStopSpeechMs !== undefined
        ? { fallback_hard_stop_speech_ms: options.bargeIn.fallbackHardStopSpeechMs }
        : {}),
    },
    eot: options.eotHold?.enabled
      ? {
          ...(options.eotHold.commitThreshold !== undefined
            ? { commitThreshold: options.eotHold.commitThreshold }
            : {}),
          ...(options.eotHold.maxHoldMs !== undefined
            ? { maxHoldMs: options.eotHold.maxHoldMs }
            : {}),
        }
      : false,
    speculative: {
      enabled: options.speculationEnabled,
      tentativeSilenceMs: options.speculativePolicy.tentativeSilenceMs,
      minPartialChars: options.speculativePolicy.minPartialChars,
    },
    respond_gate: options.respondGateEnabled
      ? (text: string) => shouldRespondToVoiceTurn(text, options.echoContext())
      : false,
    interaction: {
      intent: Boolean(interactionOpts),
      rhythm: interactionOpts?.rhythm ? {} : false,
      backchannel: interactionOpts?.backchannel
        ? {
            enabled: true,
            ...(typeof interactionOpts.backchannel === 'object' ? interactionOpts.backchannel : {}),
          }
        : false,
    },
  });

  const drive = (input: TurnTakingInput): TurnTakingAction[] => {
    try {
      return machine.step(input);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      hooks.onWarn(`interaction engine step failed: ${reason}`);
      return [];
    }
  };

  const arbiterBuffered = (): AudioChunk[] =>
    (machine.arbiter?.bufferedChunks?.() ?? []) as AudioChunk[];

  const apply = (actions: readonly TurnTakingAction[]): void => {
    for (const action of actions) {
      switch (action.type) {
        case 'emit_backchannel':
          hooks.onBackchannelTrace(action.text);
          hooks.emitBackchannel(action.text);
          break;
        case 'pause_tts':
          hooks.pauseSpeech(arbiterBuffered());
          hooks.pauseReaction();
          break;
        case 'resume_tts':
          hooks.resumeSpeech(action.reason as 'no_words' | 'echo' | undefined);
          hooks.resumeReaction();
          break;
        case 'hard_stop':
          hooks.stopReaction();
          hooks.hardStopSpeech(arbiterBuffered());
          break;
        case 'start_speculative':
          hooks.startSpeculative(action.partial);
          break;
        case 'abort_speculative':
          hooks.abortSpeculative(action.reason as VoiceTurnCancelReason);
          break;
        case 'hold':
        case 'commit':
        case 'drop':
          hooks.enqueueDecision(action);
          break;
      }
    }
  };

  let intraUtterancePaused = false;
  const feedListeningEvidence = (
    result: { state: string; onset: boolean; speaking: boolean },
    chunk: AudioChunk,
    relMs: number
  ): void => {
    if (result.onset || result.state !== 'recording') intraUtterancePaused = false;
    if (result.state === 'recording' && !result.onset) {
      if (!result.speaking && !intraUtterancePaused) {
        intraUtterancePaused = true;
        apply(drive({ type: 'speech_pause', at_ms: relMs }));
      } else if (result.speaking && intraUtterancePaused) {
        intraUtterancePaused = false;
        apply(drive({ type: 'speech_resume', at_ms: relMs }));
      }
    }
    apply(
      drive({
        type: 'tick',
        at_ms: relMs,
        ...(intraUtterancePaused
          ? { payload: { silenceDeltaMs: computeChunkDurationMs(chunk) } }
          : {}),
      })
    );
  };

  return {
    machine,
    drive,
    driveAndApply: (input) => apply(drive(input)),
    apply,
    arbiterBuffered,
    feedListeningEvidence,
  };
}
