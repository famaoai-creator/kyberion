/**
 * Backend-neutral sustained-speech detector used while assistant audio is
 * being emitted. It deliberately owns only energy/VAD timing and buffered
 * chunks; playback cancellation and transcript replay stay with the caller.
 */

import type { AudioChunk } from './meeting-session-types.js';
import { computeChunkDurationMs, EnergyVad } from './voice-activity-detector.js';

export interface BargeInControllerOptions {
  /** Baseline speech threshold before the multiplier is applied. */
  base_rms_threshold: number;
  /** Output/input separation multiplier. Defaults to 2. */
  threshold_multiplier?: number;
  /** Sustained speech required before triggering. Defaults to 250ms. */
  min_speech_ms?: number;
}

export interface BargeInObservation {
  speaking: boolean;
  speech_ms: number;
  triggered: boolean;
  buffered_chunks: AudioChunk[];
}

export class BargeInController {
  private readonly vad: EnergyVad;
  private readonly minSpeechMs: number;
  private speechMs = 0;
  private chunks: AudioChunk[] = [];

  constructor(options: BargeInControllerOptions) {
    const multiplier = options.threshold_multiplier ?? 2;
    if (!Number.isFinite(options.base_rms_threshold) || options.base_rms_threshold < 0) {
      throw new Error('barge-in base_rms_threshold must be a finite non-negative number');
    }
    if (!Number.isFinite(multiplier) || multiplier < 1) {
      throw new Error('barge-in threshold_multiplier must be a finite number >= 1');
    }
    this.minSpeechMs = options.min_speech_ms ?? 250;
    if (!Number.isFinite(this.minSpeechMs) || this.minSpeechMs <= 0) {
      throw new Error('barge-in min_speech_ms must be a finite number > 0');
    }
    this.vad = new EnergyVad({
      rms_threshold: Math.round(options.base_rms_threshold * multiplier),
      endpoint_ms: Number.MAX_SAFE_INTEGER,
    });
  }

  observe(chunk: AudioChunk): BargeInObservation {
    const state = this.vad.ingest(chunk);
    if (!state.speaking) {
      this.reset();
      return {
        speaking: false,
        speech_ms: 0,
        triggered: false,
        buffered_chunks: [],
      };
    }

    this.speechMs += computeChunkDurationMs(chunk);
    this.chunks.push(chunk);
    if (this.speechMs < this.minSpeechMs) {
      return {
        speaking: true,
        speech_ms: this.speechMs,
        triggered: false,
        buffered_chunks: [],
      };
    }

    const bufferedChunks = this.chunks;
    this.reset();
    return {
      speaking: true,
      speech_ms: this.minSpeechMs,
      triggered: true,
      buffered_chunks: bufferedChunks,
    };
  }

  reset(): void {
    this.vad.reset();
    this.speechMs = 0;
    this.chunks = [];
  }
}
