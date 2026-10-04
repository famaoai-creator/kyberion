/**
 * Continuous interaction signals (CE-03).
 *
 * The engine never reduces conversation to booleans: every decision is
 * driven by values in [0, 1] that are recomputed as events arrive. v1 is
 * deliberately heuristic and transparent — each signal is documented as a
 * rule composition so the workbench can assert exact values and a learned
 * model can later sit behind the same seam.
 *
 *   end_of_turn_probability   P(the remote turn is finished) — delegated to
 *                             an injected scorer (voice: scoreEndOfTurn).
 *   interruption_probability  P(the remote party wants the floor NOW) —
 *                             speech duration + confirming words + intent.
 *   backchannel_probability   P(the remote fragment is a backchannel that
 *                             must not interrupt and needs no reply).
 *   user_engagement           rolling estimate that the user is actively
 *                             participating (speech ratio + substantive
 *                             turns + their own backchannel rate).
 *
 * Pure — injectable clock, no I/O.
 */

import type { UtteranceIntent } from './utterance-intent.js';

export interface InteractionSignals {
  end_of_turn_probability: number;
  interruption_probability: number;
  backchannel_probability: number;
  user_engagement: number;
}

export type EndOfTurnScorer = (text: string) => number;

export interface InteractionSignalsOptions {
  /** Scorer for end_of_turn_probability. Required — the voice layer passes scoreEndOfTurn. */
  eotScorer: EndOfTurnScorer;
  /** Rolling window for engagement estimates. Default 30s. */
  engagementWindowMs?: number;
  now?: () => number;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

export class InteractionSignalsTracker {
  private readonly eotScorer: EndOfTurnScorer;
  private readonly now: () => number;
  private readonly windowMs: number;

  private eotProbability = 0.5;
  private interruption = 0;
  private backchannel = 0;
  private engagement = 0.5;

  // Engagement bookkeeping (rolling window).
  private speakingMs = 0;
  private windowStartedAt: number | null = null;
  private substantiveTurns = 0;
  private remoteBackchannels = 0;
  private evaluatedTurns = 0;

  constructor(options: InteractionSignalsOptions) {
    this.eotScorer = options.eotScorer;
    this.now = options.now ?? (() => Date.now());
    this.windowMs = options.engagementWindowMs ?? 30_000;
  }

  get signals(): InteractionSignals {
    return {
      end_of_turn_probability: this.eotProbability,
      interruption_probability: this.interruption,
      backchannel_probability: this.backchannel,
      user_engagement: this.engagement,
    };
  }

  /** Latest transcript fragment (partial or final) with its intent. */
  observeTranscript(text: string, intent?: UtteranceIntent): void {
    this.eotProbability = clamp01(this.eotScorer(text));
    this.backchannel = this.backchannelProbability(text, intent);
  }

  /**
   * Remote speech while the agent is emitting output: how likely is this a
   * real interruption? Duration pressure + confirming words + intent.
   */
  observeInterruptionCandidate(input: {
    speechMs: number;
    confirmingWords: number;
    intent?: UtteranceIntent;
  }): void {
    let probability = clamp01(input.speechMs / 700);
    if (input.confirmingWords >= 1) probability = Math.max(probability, 0.75);
    if (input.intent === 'correcting') probability = Math.min(1, probability + 0.25);
    if (input.intent === 'backchannel') probability *= 0.2;
    this.interruption = clamp01(probability);
  }

  /** A remote utterance finished: credit its speech time and clear interruption. */
  observeUtteranceEnd(durationMs: number): void {
    this.speakingMs += Math.max(0, durationMs);
    this.interruption = 0;
  }

  /** A remote turn actually committed to the agent (respond-gate passed). */
  observeCommittedTurn(intent: UtteranceIntent): void {
    this.evaluatedTurns += 1;
    if (intent === 'backchannel') this.remoteBackchannels += 1;
    else this.substantiveTurns += 1;
    this.interruption = 0;
    this.refreshEngagement();
  }

  private backchannelProbability(text: string, intent?: UtteranceIntent): number {
    if (intent === 'backchannel') return 0.9;
    if (!text.trim()) return 0;
    if (intent === 'correcting' || intent === 'holding') return 0.05;
    return 0.3;
  }

  private refreshEngagement(): void {
    if (this.windowStartedAt === null) {
      this.windowStartedAt = this.now();
      return;
    }
    const elapsed = Math.max(1, this.now() - this.windowStartedAt);
    const speechRatio = clamp01(this.speakingMs / elapsed);
    const substantiveRatio =
      this.evaluatedTurns === 0 ? 0.5 : this.substantiveTurns / this.evaluatedTurns;
    // 60% how much of the window the user spends speaking, 40% how much of
    // it is substantive content vs. pure aizuchi.
    this.engagement = clamp01(0.6 * speechRatio * 2 + 0.4 * substantiveRatio);
    if (elapsed >= this.windowMs) {
      this.windowStartedAt = this.now();
      this.speakingMs = 0;
      this.evaluatedTurns = 0;
      this.substantiveTurns = 0;
      this.remoteBackchannels = 0;
    }
  }
}
