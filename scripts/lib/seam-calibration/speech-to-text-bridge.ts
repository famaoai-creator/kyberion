/**
 * Seam calibration adapter for 'speech-to-text-bridge': transcribe the same
 * audio file with every installed file-STT bridge and compare transcripts
 * (char_error_rate against reference_text when given).
 *
 * Candidates are the bridges the product installs on this machine (operator
 * commands, WhisperKit, managed mlx-whisper, Apple Speech); eligibility reuses
 * listSpeechToTextCandidates() — the same requirement check live selection
 * uses (the sidecar stub is never eligible, a requested language must be
 * declared by bridges that declare languages). Each trial calls the named
 * bridge directly, so a failure is never attributed to another bridge.
 */

import * as path from 'node:path';
import {
  getSpeechToTextBridges,
  installFluidAudioSpeechToTextBridgeIfAvailable,
  installManagedMlxWhisperSpeechToTextBridgeIfAvailable,
  installShellSpeechToTextBridgeIfAvailable,
  installWhisperKitSpeechToTextBridgeIfAvailable,
  listSpeechToTextCandidates,
} from '@agent/core/speech-to-text-bridge';
import { installAppleSpeechToTextBridgeIfAvailable } from '@agent/core/apple-intelligence-bridge';
import { installAppleSpeechFileToTextBridgeIfAvailable } from '@agent/core/apple-speech-file-stt-bridge';
import type {
  SeamCalibrationAdapter,
  SeamCalibrationTrialContext,
  SeamCalibrationTrialResult,
} from '@agent/core/seam-calibration';
import type { SeamProviderCandidate } from '@agent/core/seam-provider-selection';

export interface SpeechToTextCalibrationInput {
  audio_path: string;
  /** What was actually said; when given, each trial reports char_error_rate against it. */
  reference_text?: string;
  /** BCP-47 language of the audio; also a hard requirement for bridges that declare languages. */
  language?: string;
}

/**
 * Transcript comparison form: NFKC, lower case, without whitespace and
 * punctuation, as code points. STT backends differ in spacing (Japanese has
 * none), punctuation and full/half-width forms; none of that is a
 * recognition error.
 */
export function normalizeTranscriptForCer(text: string): string[] {
  return Array.from(
    String(text ?? '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\s\p{P}]/gu, '')
  );
}

/**
 * Character Error Rate over normalised transcripts: Levenshtein distance
 * (insertions, deletions, substitutions) divided by the reference length,
 * capped at 1. 0 = identical, 1 = no better than an empty transcript.
 */
export function transcriptCharErrorRate(hypothesis: string, reference: string): number {
  const hyp = normalizeTranscriptForCer(hypothesis);
  const ref = normalizeTranscriptForCer(reference);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  if (hyp.length === 0) return 1;
  let previous = Array.from({ length: ref.length + 1 }, (_, j) => j);
  for (let i = 1; i <= hyp.length; i += 1) {
    const current = new Array<number>(ref.length + 1);
    current[0] = i;
    for (let j = 1; j <= ref.length; j += 1) {
      const cost = hyp[i - 1] === ref[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    previous = current;
  }
  return Math.min(1, previous[ref.length]! / ref.length);
}

/** Install every file-STT bridge available on this machine (each helper is idempotent). */
export async function installSpeechToTextBridgesForCalibration(): Promise<void> {
  installShellSpeechToTextBridgeIfAvailable();
  installFluidAudioSpeechToTextBridgeIfAvailable();
  installWhisperKitSpeechToTextBridgeIfAvailable();
  installManagedMlxWhisperSpeechToTextBridgeIfAvailable();
  await installAppleSpeechToTextBridgeIfAvailable().catch(() => false);
  installAppleSpeechFileToTextBridgeIfAvailable();
}

export const speechToTextBridgeCalibrationAdapter: SeamCalibrationAdapter<SpeechToTextCalibrationInput> =
  {
    seam: 'speech-to-text-bridge',
    description:
      'Transcribe the same audio file with every installed STT bridge and compare transcripts (char_error_rate against reference_text when given).',
    input_example: {
      audio_path: 'active/shared/tmp/sample.wav',
      reference_text: '本日の議題は三点です',
      language: 'ja',
    },

    async listCandidates(input: SpeechToTextCalibrationInput): Promise<SeamProviderCandidate[]> {
      await installSpeechToTextBridgesForCalibration();
      return listSpeechToTextCandidates({
        ...(input.language ? { language: input.language } : {}),
      });
    },

    async runTrial(
      providerId: string,
      input: SpeechToTextCalibrationInput,
      context: SeamCalibrationTrialContext
    ): Promise<SeamCalibrationTrialResult> {
      const bridge = getSpeechToTextBridges().find((candidate) => candidate.name === providerId);
      if (!bridge) return { ok: false, error: `unknown speech-to-text bridge '${providerId}'` };
      const result = await bridge.transcribe({
        audioPath: input.audio_path,
        ...(input.language ? { language: input.language } : {}),
        outputPath: path.join(context.outDir, `transcript-${context.repeat + 1}.txt`),
      });
      if (result.synthetic) return { ok: false, error: 'synthetic transcript (sidecar), not STT' };
      const metrics: Record<string, number> = {};
      if (input.reference_text) {
        metrics.char_error_rate = transcriptCharErrorRate(result.text, input.reference_text);
      }
      return {
        ok: true,
        output: {
          text: result.text,
          ...(result.written_to ? { artifact_path: result.written_to } : {}),
        },
        metrics,
      };
    },

    trait_mappings: {
      accuracy: { metric: 'char_error_rate', higher_is_better: false },
      latency: { metric: 'latency_ms', higher_is_better: false },
    },

    /** Bridges that do not declare local_only (operator shell commands) may be cloud CLIs. */
    requiresExplicitOptIn(providerId: string): boolean {
      const bridge = getSpeechToTextBridges().find((candidate) => candidate.name === providerId);
      return bridge?.capabilities?.local_only !== true;
    },
  };
