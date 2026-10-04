/**
 * User Rhythm — per-user conversational tempo learned during the session
 * (CE-07).
 *
 * People differ: some leave long pauses mid-sentence, some speak fast, some
 * backchannel constantly. The engine observes utterance durations, inter-
 * utterance gaps, transcript production rate, and the user's own
 * backchannel frequency, then adapts the timing constants instead of
 * treating everyone with the same 150/250/600/1500 ms defaults.
 *
 * Cold start is safe: adjustments are emitted only after `minSamples`
 * utterances and are clamped to [0.5×, 2×] the base defaults. Until then the
 * engine behaves exactly as before.
 *
 * Pure — injectable clock, no I/O. Persistence (personal tier) is a caller
 * concern.
 */

export interface UserRhythmProfile {
  utterances: number;
  /** Mean utterance duration (speech onset → endpoint). */
  avgUtteranceMs: number;
  /** Mean silence gap between consecutive utterances. */
  avgGapMs: number;
  /** Transcript characters per second of speech — a speech-rate proxy. */
  charsPerSec: number;
  /** User backchannels per utterance. */
  backchannelRate: number;
}

export interface RhythmAdjustments {
  /** EOT hold budget — longer for people who think while talking. */
  maxHoldMs: number;
  /** Tentative silence before a speculative reply may start. */
  tentativeSilenceMs: number;
  /** Minimum spacing between the agent's own backchannels. */
  backchannelIntervalMs: number;
}

export interface UserRhythmOptions {
  /** EMA smoothing factor per new sample. Default 0.3. */
  alpha?: number;
  /** Samples required before adjustments activate. Default 4. */
  minSamples?: number;
  /** Base values the adjustments clamp around. */
  base?: { maxHoldMs: number; tentativeSilenceMs: number; backchannelIntervalMs: number };
  now?: () => number;
}

const DEFAULT_BASE = { maxHoldMs: 1500, tentativeSilenceMs: 250, backchannelIntervalMs: 4000 };

function clampAround(base: number, value: number): number {
  return Math.min(base * 2, Math.max(base * 0.5, value));
}

export class UserRhythm {
  private readonly alpha: number;
  private readonly minSamples: number;
  private readonly base: Required<NonNullable<UserRhythmOptions['base']>>;

  private utterances = 0;
  private avgUtteranceMs = 0;
  private avgGapMs = 0;
  private charsPerSec = 0;
  private backchannelRate = 0;
  private lastSilenceAt: number | null = null;

  constructor(options: UserRhythmOptions = {}) {
    this.alpha = options.alpha ?? 0.3;
    this.minSamples = options.minSamples ?? 4;
    this.base = { ...DEFAULT_BASE, ...options.base };
  }

  get profile(): UserRhythmProfile {
    return {
      utterances: this.utterances,
      avgUtteranceMs: this.avgUtteranceMs,
      avgGapMs: this.avgGapMs,
      charsPerSec: this.charsPerSec,
      backchannelRate: this.backchannelRate,
    };
  }

  /** Speech onset — measures the gap since the previous utterance end. */
  observeSpeechStart(atMs: number): void {
    if (this.lastSilenceAt !== null) {
      const gap = Math.max(0, atMs - this.lastSilenceAt);
      this.avgGapMs = this.avgGapMs === 0 ? gap : this.mix(this.avgGapMs, gap);
    }
  }

  /** Utterance finished: duration + transcript so far. */
  observeUtterance(input: { durationMs: number; transcriptChars: number; atMs: number }): void {
    this.utterances += 1;
    this.lastSilenceAt = input.atMs;
    this.avgUtteranceMs =
      this.avgUtteranceMs === 0
        ? input.durationMs
        : this.mix(this.avgUtteranceMs, input.durationMs);
    if (input.durationMs > 0 && input.transcriptChars > 0) {
      const rate = (input.transcriptChars / input.durationMs) * 1000;
      this.charsPerSec = this.charsPerSec === 0 ? rate : this.mix(this.charsPerSec, rate);
    }
  }

  /** A committed turn classified as a user backchannel. */
  observeUserBackchannel(): void {
    this.backchannelRate = this.mix(this.backchannelRate, 1);
  }

  /** A committed turn with substantive content. */
  observeSubstantiveTurn(): void {
    this.backchannelRate = this.mix(this.backchannelRate, 0);
  }

  /**
   * Timing adjustments derived from the observed rhythm, or null before the
   * sample floor is reached (engine then keeps its configured defaults).
   */
  adjustments(): RhythmAdjustments | null {
    if (this.utterances < this.minSamples) return null;
    const { maxHoldMs, tentativeSilenceMs, backchannelIntervalMs } = this.base;
    return {
      // People who pause long mid-thought need a longer hold before commit.
      maxHoldMs: clampAround(maxHoldMs, Math.max(maxHoldMs, this.avgGapMs * 1.5)),
      // Fast talkers tolerate quicker speculation; slow speakers need more room.
      tentativeSilenceMs: clampAround(tentativeSilenceMs, this.avgGapMs * 0.6),
      // If the user backchannels a lot, the agent may too — sparingly.
      backchannelIntervalMs: clampAround(
        backchannelIntervalMs,
        backchannelIntervalMs / (1 + this.backchannelRate)
      ),
    };
  }

  private mix(current: number, sample: number): number {
    return current + this.alpha * (sample - current);
  }
}
