/**
 * Agent backchannel policy (CE-05).
 *
 * While the remote party holds the floor, the agent may emit short reactions
 * (「うん」「なるほど」/ "yeah", "I see") — the conversational-response path
 * that bypasses the reasoning backend entirely and goes straight to output.
 *
 * The policy is intentionally conservative so the agent cannot babble:
 * it requires sustained remote speech, a minimum interval since the last
 * emission, a per-utterance cap, and never fires while the last partial
 * transcript looks like a correction or a hold request.
 *
 * Pure — injectable clock, no I/O.
 */

import type { LanguagePack } from './language-pack.js';
import type { UtteranceIntent } from './utterance-intent.js';

export interface BackchannelPolicyOptions {
  /** Master switch — default off (opt-in). */
  enabled?: boolean;
  /** Sustained remote speech required before the first emission. Default 1200ms. */
  minSpeechMs?: number;
  /** Minimum spacing between emissions. Default 4000ms. */
  minIntervalMs?: number;
  /** Maximum emissions per remote utterance. Default 3. */
  maxPerUtterance?: number;
  now?: () => number;
}

export class BackchannelPolicy {
  private readonly enabled: boolean;
  private readonly minSpeechMs: number;
  private minIntervalMs: number;
  private readonly maxPerUtterance: number;
  private readonly now: () => number;

  private remoteSpeechSince: number | null = null;
  private lastEmittedAt: number | null = null;
  private emittedThisUtterance = 0;
  private phraseCursor = 0;

  constructor(options: BackchannelPolicyOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.minSpeechMs = Math.max(1, options.minSpeechMs ?? 1200);
    // Interval/cap must be positive — 0 would emit a reaction every tick.
    this.minIntervalMs = Math.max(1, options.minIntervalMs ?? 4000);
    this.maxPerUtterance = Math.max(1, options.maxPerUtterance ?? 3);
    this.now = options.now ?? (() => Date.now());
  }

  /** Remote speech began (or continues). */
  observeRemoteSpeechStart(atMs?: number): void {
    if (this.remoteSpeechSince === null) {
      this.remoteSpeechSince = atMs ?? this.now();
      this.emittedThisUtterance = 0;
    }
  }

  /** Remote speech ended — next emission needs a fresh sustained interval. */
  observeRemoteSpeechEnd(): void {
    this.remoteSpeechSince = null;
  }

  /** Rhythm-derived interval override (clamped by UserRhythm upstream). */
  setMinInterval(ms: number): void {
    if (Number.isFinite(ms) && ms > 0) this.minIntervalMs = ms;
  }

  /** An emission is in flight — prevents double-fire before the next tick. */
  markEmitted(atMs?: number): void {
    this.lastEmittedAt = atMs ?? this.now();
    this.emittedThisUtterance += 1;
  }

  /**
   * Whether the agent may emit a backchannel right now. `lastPartialIntent`
   * suppresses emission over corrections/holds — the agent should not go
   * 「うん」 while being told 「ちょっと待って」.
   */
  shouldEmit(lastPartialIntent?: UtteranceIntent): boolean {
    if (!this.enabled || this.remoteSpeechSince === null) return false;
    if (this.emittedThisUtterance >= this.maxPerUtterance) return false;
    if (lastPartialIntent === 'correcting' || lastPartialIntent === 'holding') return false;
    if (this.now() - this.remoteSpeechSince < this.minSpeechMs) return false;
    if (this.lastEmittedAt !== null && this.now() - this.lastEmittedAt < this.minIntervalMs) {
      return false;
    }
    return true;
  }

  /** Rotate through the pack's agent backchannels so reactions vary. */
  pickPhrase(pack: LanguagePack): string {
    const phrases = pack.agentBackchannels;
    if (phrases.length === 0) return pack.usesWordSpaces ? 'okay' : 'うん';
    const phrase = phrases[this.phraseCursor % phrases.length];
    this.phraseCursor += 1;
    return phrase;
  }
}
