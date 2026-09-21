/**
 * Calibration adapter for seam `music-generation-provider`: the same prompt on
 * each local music provider that can run it (availability, duration and
 * format limits), one clip per trial in the run directory. Their declared
 * traits are identical, so this run is how an operator tells them apart: a
 * human listens to the clips; the runner's latency becomes the suggested
 * `speed` trait.
 */

import * as path from 'node:path';
import {
  getMusicGenerationProvider,
  listMusicGenerationCandidates,
} from '@agent/core/music-generation-bridge';
import type { MusicGenerationProvider } from '@agent/core/music-generation-types';
import type { SeamCalibrationAdapter } from '@agent/core/seam-calibration';
import type { SeamProviderCandidate } from '@agent/core/seam-provider-selection';
import { safeExistsSync, safeStat } from '@agent/core/secure-io';

export interface MusicCalibrationInput {
  prompt: string;
  duration_sec?: number;
  format?: string;
}

export interface MusicCalibrationDeps {
  listCandidates(input: MusicCalibrationInput): Promise<SeamProviderCandidate[]>;
  getProvider(id: string): MusicGenerationProvider | undefined;
}

const defaultDeps: MusicCalibrationDeps = {
  listCandidates: (input) =>
    listMusicGenerationCandidates({ durationSec: input.duration_sec, format: input.format }),
  getProvider: getMusicGenerationProvider,
};

function requirePrompt(input: MusicCalibrationInput): string {
  const prompt = typeof input?.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt) throw new Error('music-generation-provider calibration input needs a prompt');
  return prompt;
}

export function createMusicGenerationCalibrationAdapter(
  deps: MusicCalibrationDeps = defaultDeps
): SeamCalibrationAdapter<MusicCalibrationInput> {
  return {
    seam: 'music-generation-provider',
    description:
      'Generate the same music prompt with each local provider; listen to the clips side by side.',
    input_example: { prompt: 'calm piano with soft pads, no vocals', duration_sec: 15 },
    listCandidates: async (input) => {
      requirePrompt(input);
      return deps.listCandidates(input);
    },
    runTrial: async (providerId, input, context) => {
      const provider = deps.getProvider(providerId);
      if (!provider) return { ok: false, error: `unknown music provider '${providerId}'` };
      const result = await provider.generate({
        prompt: requirePrompt(input),
        ...(typeof input.duration_sec === 'number' ? { durationSec: input.duration_sec } : {}),
        targetPath: path.join(context.outDir, `trial-${context.repeat + 1}.wav`),
      });
      if (result.status !== 'succeeded' || !result.path) {
        return { ok: false, error: result.error || `provider returned status ${result.status}` };
      }
      if (!safeExistsSync(result.path)) {
        return { ok: false, error: `provider reported ${result.path} but no file exists` };
      }
      return {
        ok: true,
        output: { artifact_path: result.path },
        metrics: { bytes: safeStat(result.path).size },
      };
    },
    trait_mappings: { speed: { metric: 'latency_ms', higher_is_better: false } },
    // Both built-in providers run locally for free; anything else must be named.
    requiresExplicitOptIn: (providerId) => {
      const provider = deps.getProvider(providerId);
      return !provider || provider.executionLocality !== 'local' || provider.costTier === 'paid';
    },
  };
}

export const musicGenerationProviderCalibrationAdapter = createMusicGenerationCalibrationAdapter();
