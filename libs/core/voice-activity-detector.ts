/**
 * Voice Activity Detector.
 *
 * The coordinator needs a "should I start speaking now?" signal — it
 * shouldn't talk over a participant. The classic approach is a VAD
 * over the inbound audio stream: when energy / spectral features stay
 * below a threshold for N ms, a turn boundary is declared.
 *
 * We expose a tiny interface so callers can swap in WebRTC VAD or a
 * neural VAD without rewriting the loop. The reference implementation
 * here is energy-based (RMS over 16-bit PCM frames) — sufficient for
 * the smoke run; replace before high-noise environments.
 */

import type { AudioChunk } from './meeting-session-types.js';

export interface VoiceActivityDetector {
  /**
   * Returns true when the chunk contains speech-level energy. Stateful:
   * the detector remembers recent silence/voice transitions.
   */
  ingest(chunk: AudioChunk): VoiceActivityState;
  reset(): void;
}

export interface VoiceActivityState {
  speaking: boolean;
  /** Milliseconds of continuous silence since the last speech. */
  silence_ms: number;
  /** True when this chunk crossed a silence ≥ `endpoint_ms` boundary. */
  endpoint: boolean;
}

export interface EnergyVadOptions {
  /** RMS threshold above which a frame is considered speech. */
  rms_threshold: number;
  /** ms of continuous silence before declaring an endpoint. */
  endpoint_ms: number;
}

const DEFAULT_OPTIONS: EnergyVadOptions = {
  rms_threshold: 800, // empirical for 16-bit PCM voice at low gain
  endpoint_ms: 700,
};

export class EnergyVad implements VoiceActivityDetector {
  private silenceMs = 0;
  /** True once speech has been observed at least once since the last endpoint. */
  private hadSpeechSinceEndpoint = false;
  /** Becomes true on the first silence chunk that crosses the threshold;
   *  resets to false once speech resumes. Prevents repeated endpoint
   *  reports during one continuous silence. */
  private endpointFired = false;

  constructor(private readonly opts: EnergyVadOptions = DEFAULT_OPTIONS) {}

  reset(): void {
    this.silenceMs = 0;
    this.hadSpeechSinceEndpoint = false;
    this.endpointFired = false;
  }

  ingest(chunk: AudioChunk): VoiceActivityState {
    const rms = computeRms(chunk);
    const speaking = rms >= this.opts.rms_threshold;
    const frameMs = chunkDurationMs(chunk);
    if (speaking) {
      this.silenceMs = 0;
      this.hadSpeechSinceEndpoint = true;
      this.endpointFired = false;
    } else {
      this.silenceMs += frameMs;
    }
    const endpoint =
      !speaking &&
      this.hadSpeechSinceEndpoint &&
      this.silenceMs >= this.opts.endpoint_ms &&
      !this.endpointFired;
    if (endpoint) {
      this.endpointFired = true;
      this.hadSpeechSinceEndpoint = false;
    }
    return { speaking, silence_ms: this.silenceMs, endpoint };
  }
}

function computeRms(chunk: AudioChunk): number {
  if (chunk.format.encoding !== 'pcm_s16le') {
    // Other encodings: skip detection (return loud so the caller treats
    // it as speech rather than spuriously endpointing).
    return Number.POSITIVE_INFINITY;
  }
  const view = new DataView(
    chunk.payload.buffer,
    chunk.payload.byteOffset,
    chunk.payload.byteLength,
  );
  const sampleCount = chunk.payload.byteLength / 2;
  if (sampleCount === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i++) {
    const sample = view.getInt16(i * 2, true);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

function chunkDurationMs(chunk: AudioChunk): number {
  const bytesPerSample =
    chunk.format.encoding === 'pcm_f32le' ? 4 : chunk.format.encoding === 'pcm_s16le' ? 2 : 2;
  const samples = chunk.payload.byteLength / (bytesPerSample * chunk.format.channels);
  return (samples * 1000) / chunk.format.sample_rate_hz;
}
