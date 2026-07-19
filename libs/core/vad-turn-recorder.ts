/**
 * VAD turn segmentation — chunk-in / event-out utterance boundary
 * detection, plus a one-shot recorder built on top of it.
 *
 * `VadTurnSegmenter` owns the reusable logic: (optional) noise-floor
 * calibration → wait for speech onset (keeping a pre-roll ring buffer so
 * the first syllable is not clipped) → assemble the utterance until the
 * VAD reports an endpoint or the utterance cap is hit. It does NOT own
 * the microphone, so the realtime voice loop can keep one continuous
 * capture session and re-arm the segmenter between turns.
 *
 * `recordVadTurn` drives the segmenter over a fresh mic session for a
 * single utterance and writes a WAV — the simple building block used by
 * the turn-based CLI mode.
 *
 * Time is accounted from chunk durations, not wall clock, so fixture
 * replay through `MicCaptureOptions.command` stays deterministic.
 */

import { startMicCapture, type MicCaptureOptions } from './mic-capture.js';
import { pcmToWav } from './pcm-wav.js';
import { safeWriteFile } from './secure-io.js';
import {
  computeChunkDurationMs,
  computeChunkRms,
  EnergyVad,
  type VoiceActivityDetector,
} from './voice-activity-detector.js';
import type { AudioChunk } from './meeting-session-types.js';

export type VadTurnState = 'calibrating' | 'listening' | 'recording' | 'finalizing';

const MIN_CALIBRATED_THRESHOLD = 250;
const MAX_CALIBRATED_THRESHOLD = 8000;

export function calibrateRmsThreshold(noiseFloorRms: number, multiplier: number): number {
  const scaled = noiseFloorRms * multiplier;
  return Math.min(MAX_CALIBRATED_THRESHOLD, Math.max(MIN_CALIBRATED_THRESHOLD, Math.round(scaled)));
}

export interface VadTurnSegmenterOptions {
  /**
   * Build the VAD once the speech threshold is known. `threshold` is null
   * when calibration is disabled (a detector that does not need an energy
   * threshold, e.g. a neural VAD, can ignore it).
   */
  vadFactory?: (threshold: number | null) => VoiceActivityDetector;
  /** Explicit RMS speech threshold. When set, noise-floor calibration is skipped. */
  rmsThreshold?: number;
  /**
   * Disable energy calibration entirely (neural VAD). The segmenter goes
   * straight to 'listening' and passes threshold=null to `vadFactory`.
   */
  skipCalibration?: boolean;
  /** ms of continuous silence before declaring the utterance finished. */
  endpointMs?: number;
  /** ms of leading audio used to estimate the noise floor (default 500). */
  calibrationMs?: number;
  /** Threshold = clamp(noiseFloor × multiplier, min 250, max 8000). Default 3.5. */
  calibrationMultiplier?: number;
  /** ms of audio retained before speech onset so the first syllable survives (default 300). */
  prerollMs?: number;
  /** Hard cap per utterance even without a silence endpoint (default 30s). */
  maxUtteranceMs?: number;
}

export interface VadSegmenterPush {
  state: Exclude<VadTurnState, 'finalizing'>;
  /** True on the chunk where speech onset was detected (listening → recording). */
  onset: boolean;
  /** True when this chunk completed an utterance via silence endpoint. */
  endpoint: boolean;
  /** True when this chunk completed an utterance via the max-utterance cap. */
  capped: boolean;
  /** Raw VAD speech flag for this chunk (false while calibrating). */
  speaking: boolean;
  /** On onset: the pre-roll PCM that was promoted into the segment (for streaming STT). */
  onsetPreroll?: Buffer;
}

export interface VadTurnSegment {
  pcm: Buffer;
  durationMs: number;
  endpointed: boolean;
}

export class VadTurnSegmenter {
  private readonly endpointMs: number;
  private readonly calibrationMs: number;
  private readonly calibrationMultiplier: number;
  private readonly prerollMs: number;
  private readonly maxUtteranceMs: number;
  private readonly vadFactory: (threshold: number | null) => VoiceActivityDetector;

  private phase: Exclude<VadTurnState, 'finalizing'> = 'listening';
  private vad: VoiceActivityDetector | null = null;
  private thresholdValue = 0;
  private noiseFloor: number | null = null;
  private calibrationAccumMs = 0;
  private calibrationWeightedRms = 0;

  private readonly preroll: Array<{ buf: Buffer; ms: number }> = [];
  private prerollTotalMs = 0;
  private segment: Buffer[] = [];
  private segmentBytes = 0;
  private segmentMs = 0;
  private segmentEndpointed = false;
  private listenedMsValue = 0;

  constructor(private readonly opts: VadTurnSegmenterOptions = {}) {
    this.endpointMs = opts.endpointMs ?? 700;
    this.calibrationMs = opts.calibrationMs ?? 500;
    this.calibrationMultiplier = opts.calibrationMultiplier ?? 3.5;
    this.prerollMs = opts.prerollMs ?? 300;
    this.maxUtteranceMs = opts.maxUtteranceMs ?? 30_000;
    this.vadFactory =
      opts.vadFactory ??
      ((threshold) =>
        new EnergyVad({
          rms_threshold: threshold ?? 800,
          endpoint_ms: this.endpointMs,
        }));

    if (opts.rmsThreshold !== undefined) {
      if (!Number.isFinite(opts.rmsThreshold) || opts.rmsThreshold <= 0) {
        throw new Error(
          `[vad-turn-segmenter] rmsThreshold must be a positive number (got ${opts.rmsThreshold})`
        );
      }
      this.thresholdValue = opts.rmsThreshold;
      this.vad = this.vadFactory(opts.rmsThreshold);
    } else if (opts.skipCalibration) {
      this.vad = this.vadFactory(null);
    } else {
      this.phase = 'calibrating';
    }
  }

  get state(): Exclude<VadTurnState, 'finalizing'> {
    return this.phase;
  }

  get rmsThreshold(): number {
    return this.thresholdValue;
  }

  get noiseFloorRms(): number | null {
    return this.noiseFloor;
  }

  /** Total ms spent in 'listening' since the last onset/reset. */
  get listenedMs(): number {
    return this.listenedMsValue;
  }

  push(chunk: AudioChunk): VadSegmenterPush {
    const buf = Buffer.from(chunk.payload);
    const chunkMs = computeChunkDurationMs(chunk);

    if (this.phase === 'calibrating') {
      this.calibrationWeightedRms += computeChunkRms(chunk) * chunkMs;
      this.calibrationAccumMs += chunkMs;
      this.pushPreroll(buf, chunkMs);
      if (this.calibrationAccumMs >= this.calibrationMs) {
        this.noiseFloor =
          this.calibrationAccumMs > 0 ? this.calibrationWeightedRms / this.calibrationAccumMs : 0;
        this.thresholdValue = calibrateRmsThreshold(this.noiseFloor, this.calibrationMultiplier);
        this.vad = this.vadFactory(this.thresholdValue);
        this.phase = 'listening';
      }
      return { state: this.phase, onset: false, endpoint: false, capped: false, speaking: false };
    }

    const state = (this.vad as VoiceActivityDetector).ingest(chunk);

    if (this.phase === 'listening') {
      this.listenedMsValue += chunkMs;
      if (state.speaking) {
        const onsetPreroll = this.startSegmentFromPreroll();
        this.segment.push(buf);
        this.segmentBytes += buf.byteLength;
        this.segmentMs += chunkMs;
        this.phase = 'recording';
        return {
          state: this.phase,
          onset: true,
          endpoint: false,
          capped: false,
          speaking: true,
          onsetPreroll,
        };
      }
      this.pushPreroll(buf, chunkMs);
      return { state: this.phase, onset: false, endpoint: false, capped: false, speaking: false };
    }

    // phase === 'recording'
    this.segment.push(buf);
    this.segmentBytes += buf.byteLength;
    this.segmentMs += chunkMs;
    if (state.endpoint) {
      this.segmentEndpointed = true;
      return {
        state: this.phase,
        onset: false,
        endpoint: true,
        capped: false,
        speaking: state.speaking,
      };
    }
    if (this.segmentMs >= this.maxUtteranceMs) {
      this.segmentEndpointed = false;
      return {
        state: this.phase,
        onset: false,
        endpoint: false,
        capped: true,
        speaking: state.speaking,
      };
    }
    return {
      state: this.phase,
      onset: false,
      endpoint: false,
      capped: false,
      speaking: state.speaking,
    };
  }

  /** Collect the assembled utterance and re-arm for the next one. */
  takeSegment(): VadTurnSegment {
    const segment: VadTurnSegment = {
      pcm: Buffer.concat(this.segment, this.segmentBytes),
      durationMs: Math.round(this.segmentMs),
      endpointed: this.segmentEndpointed,
    };
    this.resetSegment();
    return segment;
  }

  /** Drop any partial segment and go back to listening (threshold is kept). */
  reset(): void {
    this.resetSegment();
  }

  /** Release resources owned by the selected detector (for example Silero's Python child). */
  async dispose(): Promise<void> {
    await this.vad?.dispose?.();
  }

  private resetSegment(): void {
    this.segment = [];
    this.segmentBytes = 0;
    this.segmentMs = 0;
    this.segmentEndpointed = false;
    this.listenedMsValue = 0;
    this.preroll.length = 0;
    this.prerollTotalMs = 0;
    this.vad?.reset();
    if (this.phase !== 'calibrating') this.phase = 'listening';
  }

  private pushPreroll(buf: Buffer, ms: number): void {
    this.preroll.push({ buf, ms });
    this.prerollTotalMs += ms;
    while (this.preroll.length > 1 && this.prerollTotalMs - this.preroll[0].ms >= this.prerollMs) {
      this.prerollTotalMs -= this.preroll[0].ms;
      this.preroll.shift();
    }
  }

  private startSegmentFromPreroll(): Buffer {
    const parts: Buffer[] = [];
    for (const entry of this.preroll) {
      this.segment.push(entry.buf);
      this.segmentBytes += entry.buf.byteLength;
      this.segmentMs += entry.ms;
      parts.push(entry.buf);
    }
    this.preroll.length = 0;
    this.prerollTotalMs = 0;
    return Buffer.concat(parts);
  }
}

/* ------------------------------------------------------------------ *
 * One-shot recorder — a fresh mic session per utterance.
 * ------------------------------------------------------------------ */

export interface VadTurnRecorderOptions {
  /** Where the WAV is written (parent directory must exist). */
  outputPath: string;
  mic?: MicCaptureOptions;
  /** Explicit RMS speech threshold. When set, noise-floor calibration is skipped. */
  rmsThreshold?: number;
  /** ms of continuous silence before declaring the utterance finished. */
  endpointMs?: number;
  /** ms of leading audio used to estimate the noise floor (default 500). */
  calibrationMs?: number;
  /** Threshold = clamp(noiseFloor × multiplier, min 250, max 8000). Default 3.5. */
  calibrationMultiplier?: number;
  /** Pre-roll retained before speech onset so the first syllable survives (default 300ms). */
  prerollMs?: number;
  /** Hard cap per utterance even without a silence endpoint (default 30). */
  maxUtteranceSeconds?: number;
  /** Max audio-time to wait for speech onset before giving up (default 60). */
  maxWaitSeconds?: number;
  /** Custom VAD factory (default: EnergyVad on the resolved threshold). */
  vadFactory?: (threshold: number | null) => VoiceActivityDetector;
  onState?: (state: VadTurnState) => void;
}

export interface VadTurnRecording {
  audioPath: string;
  /** Duration of the captured utterance (pre-roll + speech + trailing silence). */
  durationMs: number;
  /** True when the VAD declared a silence endpoint; false when the cap flushed it. */
  endpointed: boolean;
  /** Measured noise floor RMS, or null when an explicit threshold was supplied. */
  noiseFloorRms: number | null;
  /** The RMS threshold actually used for speech detection. */
  rmsThreshold: number;
}

export async function recordVadTurn(options: VadTurnRecorderOptions): Promise<VadTurnRecording> {
  const sampleRateHz = options.mic?.sampleRateHz ?? 16_000;
  const maxWaitMs = (options.maxWaitSeconds ?? 60) * 1000;

  const segmenter = new VadTurnSegmenter({
    ...(options.vadFactory ? { vadFactory: options.vadFactory } : {}),
    ...(options.rmsThreshold !== undefined ? { rmsThreshold: options.rmsThreshold } : {}),
    ...(options.endpointMs !== undefined ? { endpointMs: options.endpointMs } : {}),
    ...(options.calibrationMs !== undefined ? { calibrationMs: options.calibrationMs } : {}),
    ...(options.calibrationMultiplier !== undefined
      ? { calibrationMultiplier: options.calibrationMultiplier }
      : {}),
    ...(options.prerollMs !== undefined ? { prerollMs: options.prerollMs } : {}),
    ...(options.maxUtteranceSeconds !== undefined
      ? { maxUtteranceMs: options.maxUtteranceSeconds * 1000 }
      : {}),
  });

  const mic = await startMicCapture({ ...options.mic, sampleRateHz });
  let lastState: VadTurnState = segmenter.state;
  options.onState?.(lastState);
  let finished = false;
  let sawSpeech = false;

  try {
    for await (const chunk of mic.chunks() as AsyncIterable<AudioChunk>) {
      const result = segmenter.push(chunk);
      if (result.state !== lastState) {
        lastState = result.state;
        options.onState?.(lastState);
      }
      if (result.onset) sawSpeech = true;
      if (result.endpoint || result.capped) {
        finished = true;
        break;
      }
      if (result.state === 'listening' && segmenter.listenedMs >= maxWaitMs) {
        throw new Error(
          `[vad-turn-recorder] no speech detected within ${Math.round(maxWaitMs / 1000)}s ` +
            `(threshold=${segmenter.rmsThreshold} rms). Adjust the mic gain or pass an explicit rmsThreshold.`
        );
      }
    }
  } finally {
    await mic.stop();
    await segmenter.dispose();
  }

  if (!sawSpeech) {
    throw new Error(
      `[vad-turn-recorder] microphone stream ended before any speech was detected ` +
        `(threshold=${segmenter.rmsThreshold} rms, listened=${Math.round(segmenter.listenedMs)}ms).`
    );
  }
  // Stream may end mid-utterance without an endpoint; flush what we have.
  void finished;

  options.onState?.('finalizing');
  const segment = segmenter.takeSegment();
  safeWriteFile(options.outputPath, pcmToWav(segment.pcm, sampleRateHz));

  return {
    audioPath: options.outputPath,
    durationMs: segment.durationMs,
    endpointed: segment.endpointed,
    noiseFloorRms: segmenter.noiseFloorRms,
    rmsThreshold: segmenter.rmsThreshold,
  };
}
