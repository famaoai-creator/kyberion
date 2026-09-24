/**
 * Pure turn-taking state machine for the realtime voice loop. It composes the
 * two-stage barge-in, the end-of-turn hold aggregator, the respond gate and
 * the speculative-reply policy behind one deterministic event interface:
 * every input carries its own `at_ms`, which is the only clock used.
 *
 * The machine decides; the caller acts (pausing playback, starting or
 * aborting inference, dispatching the committed turn).
 */

import { TwoStageBargeIn, type TwoStageBargeInOptions } from './two-stage-barge-in.js';
import { EotHoldAggregator } from './voice-eot-scorer.js';
import {
  isOwnTtsEcho,
  shouldRespondToVoiceTurn,
  type OwnTtsEchoContext,
} from './voice-respond-gate.js';
import {
  transcriptsMatchForSpeculation,
  type SpeculativeReplyPolicy,
} from './voice-speculative-policy.js';
import type { VoiceTurnCancelReason } from './voice-turn-cancellation.js';

export type TurnTakingInputType =
  'vad_start' | 'vad_silence' | 'stt_partial' | 'stt_final' | 'tts_start' | 'tts_end' | 'tick';

export interface TurnTakingInput {
  type: TurnTakingInputType;
  at_ms: number;
  /** Transcript for stt_*; spoken text for tts_start (used for echo checks). */
  text?: string;
  /** Onset energy for vad_start. */
  rms?: number;
}

export type TurnTakingAction =
  | { type: 'pause_tts' }
  | { type: 'resume_tts'; reason: 'no_words' | 'echo' }
  | { type: 'hard_stop'; words: string }
  | { type: 'hold'; text: string }
  | { type: 'commit'; text: string }
  | { type: 'drop'; reason: string; text: string }
  | { type: 'start_speculative'; partial: string }
  | { type: 'abort_speculative'; reason: VoiceTurnCancelReason };

export interface TurnTakingOptions {
  barge_in?: Omit<TwoStageBargeInOptions, 'now' | 'isEcho' | 'streaming_stt'>;
  /** Streaming STT partials are available (enables word-confirmed barge-in). Default true. */
  streaming_stt?: boolean;
  eot?: { commitThreshold?: number; maxHoldMs?: number };
  speculative?: Partial<SpeculativeReplyPolicy>;
  /** After silence, how long to wait for the STT final before held text may commit. Default 800ms. */
  final_wait_ms?: number;
  /** How long spoken assistant text stays eligible for echo matching. Default 9000ms. */
  echo_window_ms?: number;
}

const DEFAULT_BASE_RMS_THRESHOLD = 800;

export class VoiceTurnTakingMachine {
  private readonly bargeIn: TwoStageBargeIn;
  private readonly eot: EotHoldAggregator;
  private readonly speculativePolicy: SpeculativeReplyPolicy;
  private readonly finalWaitMs: number;
  private readonly echoWindowMs: number;
  private nowMs = 0;
  private ttsActive = false;
  private spoken: Array<{ text: string; at_ms: number }> = [];
  private userSpeaking = false;
  private silenceAt: number | null = null;
  private awaitingFinalUntil: number | null = null;
  private lastPartial = '';
  private speculatedPartial = '';
  private speculative: { partial: string } | null = null;

  constructor(options: TurnTakingOptions = {}) {
    this.finalWaitMs = options.final_wait_ms ?? 800;
    this.echoWindowMs = options.echo_window_ms ?? 9_000;
    this.bargeIn = new TwoStageBargeIn({
      base_rms_threshold: DEFAULT_BASE_RMS_THRESHOLD,
      ...options.barge_in,
      streaming_stt: options.streaming_stt ?? true,
      isEcho: (partial) => this.isEcho(partial),
      now: () => this.nowMs,
    });
    this.eot = new EotHoldAggregator({ ...options.eot, now: () => this.nowMs });
    this.speculativePolicy = {
      enabled: false,
      tentativeSilenceMs: 250,
      minPartialChars: 4,
      ...options.speculative,
    };
  }

  get speaking(): boolean {
    return this.ttsActive;
  }

  step(input: TurnTakingInput): TurnTakingAction[] {
    if (!Number.isFinite(input.at_ms)) throw new Error('turn-taking input at_ms must be finite');
    this.nowMs = Math.max(this.nowMs, input.at_ms);
    const text = input.text ?? '';
    switch (input.type) {
      case 'tts_start':
        this.ttsActive = true;
        this.bargeIn.reset();
        if (text.trim()) this.spoken.push({ text, at_ms: this.nowMs });
        return [];
      case 'tts_end':
        this.ttsActive = false;
        this.bargeIn.reset();
        return [];
      case 'vad_start':
        return this.onVadStart(input.rms);
      case 'vad_silence':
        this.userSpeaking = false;
        this.silenceAt = this.nowMs;
        this.awaitingFinalUntil = this.nowMs + this.finalWaitMs;
        return [...this.fromBargeIn(this.bargeIn.observeVadEnd()), ...this.maybeSpeculate()];
      case 'stt_partial':
        if (!text.trim()) return [];
        this.lastPartial = text;
        return this.ttsActive ? this.fromBargeIn(this.bargeIn.observePartial(text)) : [];
      case 'stt_final':
        return this.onFinal(text);
      case 'tick':
        return this.onTick();
    }
  }

  private onVadStart(rms: number | undefined): TurnTakingAction[] {
    const actions: TurnTakingAction[] = [];
    this.userSpeaking = true;
    this.silenceAt = null;
    this.awaitingFinalUntil = null;
    if (this.speculative) actions.push(this.abortSpeculative('eot_revoked'));
    if (this.ttsActive) actions.push(...this.fromBargeIn(this.bargeIn.observeVadStart(rms)));
    return actions;
  }

  private onFinal(text: string): TurnTakingAction[] {
    this.awaitingFinalUntil = null;
    this.lastPartial = '';
    if (!text.trim()) return [];
    const actions: TurnTakingAction[] = [];
    if (this.ttsActive) {
      actions.push(...this.fromBargeIn(this.bargeIn.observePartial(text)));
      if (this.ttsActive && this.isEcho(text)) {
        return [...actions, { type: 'drop', reason: 'echo', text }];
      }
    }
    const result = this.eot.offer(text);
    if (!result.commit) {
      if (this.speculative) actions.push(this.abortSpeculative('eot_revoked'));
      return [...actions, { type: 'hold', text: result.text }];
    }
    return [...actions, ...this.commit(result.text)];
  }

  private onTick(): TurnTakingAction[] {
    const actions = this.fromBargeIn(this.bargeIn.tick());
    const finalPending = this.awaitingFinalUntil !== null && this.nowMs < this.awaitingFinalUntil;
    if (!this.userSpeaking && !finalPending) {
      const forced = this.eot.tick();
      if (forced?.commit) actions.push(...this.commit(forced.text));
    }
    return [...actions, ...this.maybeSpeculate()];
  }

  private commit(text: string): TurnTakingAction[] {
    const actions: TurnTakingAction[] = [];
    const speculative = this.speculative;
    const gate = shouldRespondToVoiceTurn(text, this.gateContext());
    if (!gate.respond) {
      if (speculative) actions.push(this.abortSpeculative('external'));
      return [...actions, { type: 'drop', reason: gate.reason ?? 'not_addressed', text }];
    }
    if (speculative && !transcriptsMatchForSpeculation(speculative.partial, text)) {
      actions.push(this.abortSpeculative('eot_revoked'));
    }
    this.speculative = null;
    return [...actions, { type: 'commit', text }];
  }

  private maybeSpeculate(): TurnTakingAction[] {
    const policy = this.speculativePolicy;
    if (!policy.enabled || this.speculative || this.userSpeaking || this.ttsActive) return [];
    if (this.silenceAt === null || this.nowMs - this.silenceAt < policy.tentativeSilenceMs)
      return [];
    const partial = this.lastPartial.trim();
    if (partial.length < policy.minPartialChars || partial === this.speculatedPartial) return [];
    if (this.eot.pending) return [];
    this.speculative = { partial };
    this.speculatedPartial = partial;
    return [{ type: 'start_speculative', partial }];
  }

  private abortSpeculative(reason: VoiceTurnCancelReason): TurnTakingAction {
    this.speculative = null;
    return { type: 'abort_speculative', reason };
  }

  private fromBargeIn(actions: ReturnType<TwoStageBargeIn['tick']>): TurnTakingAction[] {
    for (const action of actions) {
      if (action.type === 'hard_stop') this.ttsActive = false;
    }
    return actions;
  }

  private recentSpoken(): Array<{ text: string; at_ms: number }> {
    this.spoken = this.spoken.filter((entry) => this.nowMs - entry.at_ms <= this.echoWindowMs);
    return this.spoken;
  }

  private echoContext(entry: { text: string; at_ms: number } | undefined): OwnTtsEchoContext {
    if (!entry) return {};
    return {
      recentAssistantText: entry.text,
      ageMs: this.nowMs - entry.at_ms,
      speaking: this.ttsActive,
    };
  }

  private gateContext(): OwnTtsEchoContext {
    const recent = this.recentSpoken();
    return this.echoContext(recent[recent.length - 1]);
  }

  private isEcho(text: string): boolean {
    return this.recentSpoken().some((entry) =>
      isOwnTtsEcho(text, this.echoContext(entry), { windowMs: this.echoWindowMs })
    );
  }
}
