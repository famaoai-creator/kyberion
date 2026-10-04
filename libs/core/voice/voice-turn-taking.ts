/**
 * Voice adapter for the Conversation Engine. `VoiceTurnTakingMachine` keeps
 * its historical name and options contract but is now a thin wiring layer
 * over `libs/core/interaction/conversation-engine.ts`: it injects the voice
 * deciders (two-stage barge-in, EOT hold, respond gate, speculative policy)
 * and the governed turn-taking language packs. The pure machine / voice
 * workbench replays the same decisions on a fake clock.
 *
 * The machine decides; the caller acts (pausing playback, starting or
 * aborting inference, dispatching the committed turn, emitting a
 * backchannel).
 */

import {
  TwoStageBargeIn,
  countBargeInWords,
  type TwoStageBargeInOptions,
} from '../two-stage-barge-in.js';
import { EotHoldAggregator, scoreEndOfTurn } from './voice-eot-scorer.js';
import { isOwnTtsEcho, shouldRespondToVoiceTurn } from './voice-respond-gate.js';
import {
  transcriptsMatchForSpeculation,
  type SpeculativeReplyPolicy,
} from './voice-speculative-policy.js';
import {
  ConversationEngine,
  type InteractionAction,
  type InteractionEvent,
  type InterruptionAction,
  type InterruptionArbiter,
  type RespondGateFn,
} from '../interaction/conversation-engine.js';
import { BargeInController, type BargeInControllerOptions } from '../barge-in-controller.js';
import type { AudioChunk } from '../meeting/meeting-session-types.js';
import { languagePacksFromLexicon } from '../interaction/language-pack.js';
import type { BackchannelPolicyOptions } from '../interaction/backchannel-policy.js';
import type { UserRhythmOptions, RhythmAdjustments } from '../interaction/user-rhythm.js';
import { loadVoiceTurnTakingLexicon } from './voice-turn-taking-lexicon.js';

/** Event names the adapter accepts: legacy voice names + canonical engine names. */
export type TurnTakingInputType = InteractionEvent['type'];

export type TurnTakingInput = InteractionEvent;

export type TurnTakingAction = InteractionAction;

export interface TurnTakingInteractionOptions {
  /** Agent backchannel emission (CE-05). Default off. */
  backchannel?: BackchannelPolicyOptions | false;
  /** Utterance-intent classification metadata on actions. Default off. */
  intent?: boolean;
  /** User-rhythm adaptation of timing constants (CE-07). Default off. */
  rhythm?: UserRhythmOptions | false;
}

export interface TurnTakingOptions {
  barge_in?: Omit<TwoStageBargeInOptions, 'now' | 'isEcho' | 'streaming_stt'>;
  /**
   * Injection seam for the interruption arbiter — the realtime loop selects
   * the implementation by `bargeIn.mode` (`two_stage`, `legacy`, or none for
   * `off`). When omitted the machine builds a `TwoStageBargeIn` from
   * `barge_in` (the historical default).
   */
  arbiter?: InterruptionArbiter | null;
  /** Streaming STT partials are available (enables word-confirmed barge-in). Default true. */
  streaming_stt?: boolean;
  /** EOT hold tuning; `false` disables holding entirely (every final commits). */
  eot?: { commitThreshold?: number; maxHoldMs?: number } | false;
  /**
   * Respond-gate override — the realtime loop injects its echo-aware gate so
   * reactions are the only output gated when barge-in is off. `false`
   * disables gating (every committed turn is answered).
   */
  respond_gate?: RespondGateFn | false;
  speculative?: Partial<SpeculativeReplyPolicy>;
  /** After silence, how long to wait for the STT final before held text may commit. Default 800ms. */
  final_wait_ms?: number;
  /** How long spoken assistant text stays eligible for echo matching. Default 9000ms. */
  echo_window_ms?: number;
  /** Conversation-engine extras (backchannel, intent, rhythm). */
  interaction?: TurnTakingInteractionOptions;
}

const DEFAULT_BASE_RMS_THRESHOLD = 800;

export class VoiceTurnTakingMachine extends ConversationEngine {
  constructor(options: TurnTakingOptions = {}) {
    // Deferred references: the arbiter/aggregator need the engine's clock and
    // echo view before `this` exists, so they read through these boxes.
    const self: { engine: VoiceTurnTakingMachine | null } = { engine: null };
    const nowMs = () => self.engine?.nowMs ?? 0;
    const rhythmBox: { get: () => RhythmAdjustments | null } = { get: () => null };
    const echoWindowMs = options.echo_window_ms ?? 9_000;
    const eotOption = options.eot === false ? undefined : options.eot;
    const baseMaxHoldMs = eotOption?.maxHoldMs ?? 1500;
    const baseBackchannelIntervalMs =
      typeof options.interaction?.backchannel === 'object' &&
      options.interaction.backchannel.minIntervalMs !== undefined
        ? options.interaction.backchannel.minIntervalMs
        : 4_000;
    // Rhythm adjustments clamp around the configured bases, not defaults.
    const rhythmOption = options.interaction?.rhythm;
    const rhythm: UserRhythmOptions | false =
      rhythmOption === undefined || rhythmOption === false
        ? false
        : {
            ...rhythmOption,
            base: {
              maxHoldMs: baseMaxHoldMs,
              tentativeSilenceMs: options.speculative?.tentativeSilenceMs ?? 250,
              backchannelIntervalMs: baseBackchannelIntervalMs,
              ...rhythmOption.base,
            },
          };

    const interruption =
      options.arbiter !== undefined
        ? options.arbiter
        : new TwoStageBargeIn({
            base_rms_threshold: DEFAULT_BASE_RMS_THRESHOLD,
            ...options.barge_in,
            streaming_stt: options.streaming_stt ?? true,
            isEcho: (partial) => self.engine?.isEcho(partial) ?? false,
            now: nowMs,
          });
    const eot =
      options.eot === false
        ? undefined
        : new EotHoldAggregator({
            commitThreshold: eotOption?.commitThreshold,
            maxHoldMs: () => rhythmBox.get()?.maxHoldMs ?? baseMaxHoldMs,
            now: nowMs,
          });
    const respondGate =
      options.respond_gate === false
        ? undefined
        : (options.respond_gate ?? shouldRespondToVoiceTurn);

    super({
      interruption,
      eot,
      respondGate,
      echo: (text, ctx) => isOwnTtsEcho(text, ctx, { windowMs: echoWindowMs }),
      speculation: {
        enabled: false,
        tentativeSilenceMs: 250,
        minPartialChars: 4,
        ...options.speculative,
      },
      speculationMatcher: transcriptsMatchForSpeculation,
      wordCounter: countBargeInWords,
      finalWaitMs: options.final_wait_ms ?? 800,
      echoWindowMs,
      packs: languagePacksFromLexicon(loadVoiceTurnTakingLexicon().languages),
      language: 'auto',
      eotScorer: (text) => scoreEndOfTurn(text).probability,
      backchannel: options.interaction?.backchannel ?? false,
      // Intent metadata is additive on actions; keep it opt-in so legacy
      // callers comparing exact action objects are unaffected.
      intent: options.interaction?.intent ?? false,
      rhythm,
      now: nowMs,
    });

    self.engine = this;
    rhythmBox.get = () => this.rhythmAdjustments();
  }

  override step(input: TurnTakingInput): TurnTakingAction[] {
    return super.step(input as InteractionEvent);
  }
}

/**
 * Legacy-mode interruption arbiter: a sustained-energy probe that maps the
 * historical `BargeInController` onto the engine's `InterruptionArbiter`
 * contract. The loop feeds chunks through tick payloads while output is
 * active; a sustained speech-energy run immediately hard-stops (no
 * transcript confirmation, matching `--barge-in-mode legacy`).
 */
export class LegacyBargeInArbiter implements InterruptionArbiter {
  private controller: BargeInController;
  private buffered: AudioChunk[] = [];
  private stopped = false;

  constructor(private readonly options: BargeInControllerOptions) {
    this.controller = new BargeInController(options);
  }

  get state(): string {
    return this.stopped ? 'stopped' : 'listening';
  }

  observeTick(chunk: unknown, _partials: readonly string[]): InterruptionAction[] {
    if (this.stopped) return [];
    const observation = this.controller.observe(chunk as AudioChunk);
    if (!observation.triggered) return [];
    this.stopped = true;
    this.buffered = observation.buffered_chunks;
    return [{ type: 'hard_stop', words: 'speech' }];
  }

  observeVadStart(): InterruptionAction[] {
    return [];
  }
  observeVadEnd(): InterruptionAction[] {
    return [];
  }
  observePartial(): InterruptionAction[] {
    return [];
  }
  tick(): InterruptionAction[] {
    return [];
  }

  bufferedChunks(): readonly unknown[] {
    return this.buffered;
  }

  reset(): void {
    this.stopped = false;
    this.buffered = [];
    this.controller.reset();
  }
}
