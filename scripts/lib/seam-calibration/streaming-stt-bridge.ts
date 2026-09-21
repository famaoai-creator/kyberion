/**
 * Seam calibration adapter for 'streaming-stt-bridge': stream the same WAV
 * file (16-bit PCM, mono, 16/24/48 kHz) through every installed streaming
 * STT bridge and compare the final transcripts (char_error_rate against
 * reference_text when given).
 *
 * Candidates are the stub plus the bridges installed here (KYBERION_STT_COMMAND
 * shell bridge, managed mlx_whisper); eligibility reuses
 * listStreamingSttCandidates() — the stub is synthetic and never eligible.
 * Audio is fed as fast as the bridge reads it, so latency_ms is total
 * processing time for the file, not real-time responsiveness.
 */

import {
  getStreamingSttBridge,
  getStreamingSttBridgeCapabilities,
  listStreamingSttCandidates,
  listStreamingSttBridges,
} from '@agent/core/streaming-stt-bridge';
import {
  installManagedMlxWhisperStreamingSttBridgeIfAvailable,
  installShellStreamingSttBridgeFromEnv,
} from '@agent/core/shell-streaming-stt-bridge';
import type { AudioChunk, AudioFormat } from '@agent/core/meeting-session-types';
import { safeReadFile } from '@agent/core/secure-io';
import type {
  SeamCalibrationAdapter,
  SeamCalibrationTrialResult,
} from '@agent/core/seam-calibration';
import type { SeamProviderCandidate } from '@agent/core/seam-provider-selection';
import { transcriptCharErrorRate } from './speech-to-text-bridge.js';

export interface StreamingSttCalibrationInput {
  /** 16-bit PCM WAV, mono, 16000 / 24000 / 48000 Hz. */
  audio_path: string;
  reference_text?: string;
  /** BCP-47; a hard requirement for bridges that declare languages. */
  language?: string;
  /** Chunk size fed to the bridge (default 100 ms). */
  chunk_ms?: number;
}

export interface DecodedPcmWav {
  format: AudioFormat;
  pcm: Buffer;
}

/** Decode a canonical RIFF/WAVE file into s16le PCM; rejects formats AudioChunk cannot carry. */
export function decodePcmWav(wav: Buffer): DecodedPcmWav {
  if (
    wav.length < 12 ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('not a RIFF/WAVE file');
  }
  let offset = 12;
  let fmt: { audioFormat: number; channels: number; sampleRate: number; bits: number } | null =
    null;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        audioFormat: wav.readUInt16LE(body),
        channels: wav.readUInt16LE(body + 2),
        sampleRate: wav.readUInt32LE(body + 4),
        bits: wav.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data chunk before fmt chunk');
      if (fmt.audioFormat !== 1 || fmt.bits !== 16) {
        throw new Error('WAV must be 16-bit PCM');
      }
      if (fmt.channels !== 1) throw new Error('WAV must be mono');
      if (![16000, 24000, 48000].includes(fmt.sampleRate)) {
        throw new Error('WAV sample rate must be 16000, 24000 or 48000 Hz');
      }
      return {
        format: {
          encoding: 'pcm_s16le',
          sample_rate_hz: fmt.sampleRate as AudioFormat['sample_rate_hz'],
          channels: 1,
        },
        pcm: wav.subarray(body, Math.min(wav.length, body + size)),
      };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}

/** Split PCM into fixed-duration AudioChunks. */
export function* pcmChunks(decoded: DecodedPcmWav, chunkMs = 100): Generator<AudioChunk> {
  const bytesPerMs = (decoded.format.sample_rate_hz * 2) / 1000;
  const step = Math.max(2, Math.floor((bytesPerMs * chunkMs) / 2) * 2);
  for (let start = 0; start < decoded.pcm.length; start += step) {
    yield {
      format: decoded.format,
      payload: new Uint8Array(decoded.pcm.subarray(start, start + step)),
      ts_ms: Math.round(start / bytesPerMs),
    };
  }
}

async function* toAsync(chunks: Iterable<AudioChunk>): AsyncIterable<AudioChunk> {
  for (const chunk of chunks) yield chunk;
}

/** Install the streaming bridges this machine can run (env shell command, managed mlx_whisper). */
export function installStreamingSttBridgesForCalibration(): void {
  const registered = new Set(listStreamingSttBridges());
  if (!registered.has('shell')) installShellStreamingSttBridgeFromEnv();
  if (!registered.has('managed_mlx_whisper')) {
    installManagedMlxWhisperStreamingSttBridgeIfAvailable();
  }
}

export const streamingSttBridgeCalibrationAdapter: SeamCalibrationAdapter<StreamingSttCalibrationInput> =
  {
    seam: 'streaming-stt-bridge',
    description:
      'Stream the same 16-bit mono WAV through every installed streaming STT bridge and compare final transcripts (char_error_rate against reference_text when given).',
    input_example: {
      audio_path: 'active/shared/tmp/sample-16k.wav',
      reference_text: '本日の議題は三点です', // i18n-exempt: calibration sample text for CER input, not app-facing copy
      language: 'ja',
    },

    async listCandidates(input: StreamingSttCalibrationInput): Promise<SeamProviderCandidate[]> {
      installStreamingSttBridgesForCalibration();
      return listStreamingSttCandidates({
        ...(input.language ? { language: input.language } : {}),
      });
    },

    async runTrial(
      providerId: string,
      input: StreamingSttCalibrationInput
    ): Promise<SeamCalibrationTrialResult> {
      const decoded = decodePcmWav(
        safeReadFile(input.audio_path, { encoding: null, label: 'calibration audio' }) as Buffer
      );
      const bridge = getStreamingSttBridge(providerId);
      const finals: string[] = [];
      for await (const chunk of bridge.transcribeStream(
        toAsync(pcmChunks(decoded, input.chunk_ms ?? 100))
      )) {
        if (chunk.is_final && chunk.text.trim()) finals.push(chunk.text.trim());
      }
      const text = finals.join(' ');
      if (!text) return { ok: false, error: 'bridge produced no final transcript' };
      const metrics: Record<string, number> = { final_chunks: finals.length };
      if (input.reference_text) {
        metrics.char_error_rate = transcriptCharErrorRate(text, input.reference_text);
      }
      return { ok: true, output: { text }, metrics };
    },

    trait_mappings: {
      accuracy: { metric: 'char_error_rate', higher_is_better: false },
      latency: { metric: 'latency_ms', higher_is_better: false },
    },

    /** Bridges that do not declare local_only (operator shell commands) may be cloud CLIs. */
    requiresExplicitOptIn(providerId: string): boolean {
      return getStreamingSttBridgeCapabilities(providerId).local_only !== true;
    },
  };
