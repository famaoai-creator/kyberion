/**
 * Two-stage barge-in: sustained energy only *pauses* assistant playback; the
 * hard stop needs a streaming STT partial that contains real words. Echo of
 * the assistant's own voice and word-less noise resume playback instead.
 * Without streaming STT, sustained speech past a longer fallback window stops.
 *
 * Stage 1 reuses `BargeInController` as the energy detector. Callers that
 * already run their own VAD can drive stage 1 with `observeVadStart/End`.
 */

import { loadVoiceTurnTakingLexicon } from './voice-turn-taking-lexicon.js';
import type { AudioChunk } from './meeting-session-types.js';
import { BargeInController } from './barge-in-controller.js';
import { computeChunkDurationMs, computeChunkRms } from './voice-activity-detector.js';
import { isPureDisfluency } from './voice-respond-gate.js';

export type BargeInAction =
  | { type: 'pause_tts' }
  | { type: 'resume_tts'; reason: 'no_words' | 'echo' }
  | { type: 'hard_stop'; words: string };

export interface TwoStageBargeInOptions {
  base_rms_threshold: number;
  threshold_multiplier?: number;
  /** Sustained speech that provisionally pauses playback. Defaults to 150ms. */
  provisional_speech_ms?: number;
  /** Time after the pause to wait for words before resuming. Defaults to 600ms. */
  words_grace_ms?: number;
  /** Words a partial needs to confirm the interruption. Defaults to 1. */
  min_confirm_words?: number;
  /** Without streaming STT, sustained speech that hard-stops. Defaults to 700ms. */
  fallback_hard_stop_speech_ms?: number;
  /** Whether streaming STT partials will arrive while playback is paused. */
  streaming_stt?: boolean;
  /** True when a partial is the assistant's own playback picked up by the mic. */
  isEcho?: (partial: string) => boolean;
  now?: () => number;
}

type Phase = 'listening' | 'paused' | 'stopped';

const LATIN_FILLERS = new Set([
  'uh',
  'um',
  'umm',
  'er',
  'erm',
  'ah',
  'eh',
  'hmm',
  'hm',
  'mm',
  'mhm',
  'uh-huh',
  'uhhuh',
]);

// Japanese backchannels come from the turn-taking lexicon; longest first so a
// long filler is stripped before its prefix.
function cjkBackchannels(): string[] {
  return [...loadVoiceTurnTakingLexicon().ja.barge_in_backchannels].sort(
    (a, b) => b.length - a.length
  );
}

const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;

/**
 * Count confirming words in a partial. Latin tokens split on whitespace; CJK
 * text has no spaces, so every two non-filler CJK characters count as a word.
 */
export function countBargeInWords(text: string): number {
  if (isPureDisfluency(text)) return 0;
  const normalized = text.normalize('NFKC').toLowerCase();
  let cjk = normalized.replace(/[\p{P}\p{S}\s]+/gu, ' ');
  for (const filler of cjkBackchannels()) cjk = cjk.split(filler).join(' ');
  const cjkChars = (cjk.replace(/\u30fc/gu, '').match(CJK_CHAR) ?? []).length;
  const latinWords = cjk
    .replace(CJK_CHAR, ' ')
    .split(/\s+/)
    .map((token) => token.replace(/[^\p{L}\p{N}-]/gu, ''))
    .filter((token) => /[\p{L}\p{N}]/u.test(token) && !LATIN_FILLERS.has(token)).length;
  return latinWords + Math.floor(cjkChars / 2);
}

export class TwoStageBargeIn {
  private readonly detector: BargeInController;
  private readonly rmsThreshold: number;
  private readonly wordsGraceMs: number;
  private readonly minConfirmWords: number;
  private readonly fallbackMs: number;
  private readonly streamingStt: boolean;
  private readonly isEcho: (partial: string) => boolean;
  private readonly now: () => number;
  private phase: Phase = 'listening';
  private pausedAt = 0;
  private speechMs = 0;
  private vadSpeechSince: number | null = null;
  private audioSpeaking = false;
  private chunks: AudioChunk[] = [];

  constructor(options: TwoStageBargeInOptions) {
    const provisionalMs = options.provisional_speech_ms ?? 150;
    this.detector = new BargeInController({
      base_rms_threshold: options.base_rms_threshold,
      threshold_multiplier: options.threshold_multiplier,
      min_speech_ms: provisionalMs,
    });
    this.rmsThreshold = options.base_rms_threshold * (options.threshold_multiplier ?? 2);
    this.wordsGraceMs = options.words_grace_ms ?? 600;
    this.minConfirmWords = options.min_confirm_words ?? 1;
    this.fallbackMs = options.fallback_hard_stop_speech_ms ?? 700;
    if (!Number.isFinite(this.wordsGraceMs) || this.wordsGraceMs <= 0) {
      throw new Error('barge-in words_grace_ms must be a finite number > 0');
    }
    if (!Number.isInteger(this.minConfirmWords) || this.minConfirmWords < 1) {
      throw new Error('barge-in min_confirm_words must be an integer >= 1');
    }
    if (!Number.isFinite(this.fallbackMs) || this.fallbackMs < provisionalMs) {
      throw new Error('barge-in fallback_hard_stop_speech_ms must be >= provisional_speech_ms');
    }
    this.streamingStt = options.streaming_stt ?? false;
    this.isEcho = options.isEcho ?? (() => false);
    this.now = options.now ?? Date.now;
  }

  get state(): Phase {
    return this.phase;
  }

  observeAudio(chunk: AudioChunk): BargeInAction[] {
    if (this.phase === 'stopped') return [];
    if (this.phase === 'listening') {
      const observation = this.detector.observe(chunk);
      if (!observation.triggered) return [];
      this.chunks = observation.buffered_chunks;
      this.speechMs = observation.speech_ms;
      this.audioSpeaking = true;
      return this.pause();
    }
    this.chunks.push(chunk);
    this.audioSpeaking = computeChunkRms(chunk) >= this.rmsThreshold;
    if (this.audioSpeaking) this.speechMs += computeChunkDurationMs(chunk);
    return [...this.checkFallback(), ...this.checkGrace()];
  }

  /** Stage 1 from an external VAD that already applied its own onset rules. */
  observeVadStart(rms?: number): BargeInAction[] {
    if (this.phase !== 'listening') {
      if (this.phase === 'paused' && this.vadSpeechSince === null) this.vadSpeechSince = this.now();
      return [];
    }
    if (rms !== undefined && rms < this.rmsThreshold) return [];
    this.chunks = [];
    this.vadSpeechSince = this.now();
    return this.pause();
  }

  observeVadEnd(): BargeInAction[] {
    if (this.vadSpeechSince !== null) {
      this.speechMs += this.now() - this.vadSpeechSince;
      this.vadSpeechSince = null;
    }
    return [];
  }

  observePartial(text: string): BargeInAction[] {
    if (this.phase !== 'paused') return [];
    if (this.isEcho(text)) {
      this.resetDetection();
      return [{ type: 'resume_tts', reason: 'echo' }];
    }
    if (countBargeInWords(text) >= this.minConfirmWords) return this.hardStop(text);
    return [];
  }

  tick(): BargeInAction[] {
    if (this.phase !== 'paused') return [];
    return [...this.checkFallback(), ...this.checkGrace()];
  }

  /** Audio captured since the provisional pause, for replay into STT. */
  bufferedChunks(): AudioChunk[] {
    return [...this.chunks];
  }

  reset(): void {
    this.resetDetection();
  }

  private pause(): BargeInAction[] {
    this.phase = 'paused';
    this.pausedAt = this.now();
    return [{ type: 'pause_tts' }];
  }

  private hardStop(words: string): BargeInAction[] {
    this.phase = 'stopped';
    this.vadSpeechSince = null;
    return [{ type: 'hard_stop', words }];
  }

  private currentSpeechMs(): number {
    return this.speechMs + (this.vadSpeechSince === null ? 0 : this.now() - this.vadSpeechSince);
  }

  private checkFallback(): BargeInAction[] {
    if (this.phase !== 'paused' || this.streamingStt) return [];
    return this.currentSpeechMs() >= this.fallbackMs ? this.hardStop('') : [];
  }

  private checkGrace(): BargeInAction[] {
    if (this.phase !== 'paused' || this.now() - this.pausedAt < this.wordsGraceMs) return [];
    // Without STT only the fallback can confirm, so keep waiting while speech continues.
    if (!this.streamingStt && (this.audioSpeaking || this.vadSpeechSince !== null)) return [];
    this.resetDetection();
    return [{ type: 'resume_tts', reason: 'no_words' }];
  }

  private resetDetection(): void {
    this.detector.reset();
    this.phase = 'listening';
    this.pausedAt = 0;
    this.speechMs = 0;
    this.vadSpeechSince = null;
    this.audioSpeaking = false;
    this.chunks = [];
  }
}
