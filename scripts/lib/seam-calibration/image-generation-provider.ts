/**
 * Calibration adapter for seam `image-generation-provider`: the same prompt on
 * every image provider that can run it unattended, one image per trial in the
 * run directory. Quality is judged by a human from the images; the runner's
 * latency becomes the suggested `speed` trait.
 */

import * as path from 'node:path';
import {
  getImageGenerationProvider,
  listImageGenerationCandidates,
} from '@agent/core/image-generation-bridge';
import type {
  ImageGenerationMode,
  ImageGenerationProvider,
} from '@agent/core/image-generation-types';
import type { SeamCalibrationAdapter } from '@agent/core/seam-calibration';
import type { SeamProviderCandidate } from '@agent/core/seam-provider-selection';
import { safeExistsSync, safeStat } from '@agent/core/secure-io';

export interface ImageCalibrationInput {
  prompt: string;
  aspect_ratio?: string;
  mode?: ImageGenerationMode;
  /** Include host-agent bridges (they hand the prompt over and need a rerun). */
  allow_host_handoff?: boolean;
}

export interface ImageCalibrationDeps {
  listCandidates(input: ImageCalibrationInput): Promise<SeamProviderCandidate[]>;
  getProvider(id: string): ImageGenerationProvider | undefined;
}

const defaultDeps: ImageCalibrationDeps = {
  listCandidates: (input) =>
    listImageGenerationCandidates({
      prompt: input.prompt,
      aspectRatio: input.aspect_ratio,
      mode: input.mode,
      allowHostHandoff: input.allow_host_handoff === true,
    }),
  getProvider: getImageGenerationProvider,
};

function requirePrompt(input: ImageCalibrationInput): string {
  const prompt = typeof input?.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt) throw new Error('image-generation-provider calibration input needs a prompt');
  return prompt;
}

export function createImageGenerationCalibrationAdapter(
  deps: ImageCalibrationDeps = defaultDeps
): SeamCalibrationAdapter<ImageCalibrationInput> {
  return {
    seam: 'image-generation-provider',
    description:
      'Generate the same prompt with each image provider; compare the saved images side by side.',
    input_example: { prompt: 'A lighthouse on a cliff at dusk, watercolor', aspect_ratio: '1:1' },
    listCandidates: async (input) => {
      requirePrompt(input);
      return deps.listCandidates(input);
    },
    runTrial: async (providerId, input, context) => {
      const provider = deps.getProvider(providerId);
      if (!provider) return { ok: false, error: `unknown image provider '${providerId}'` };
      const result = await provider.generate({
        prompt: requirePrompt(input),
        aspectRatio: input.aspect_ratio,
        mode: input.mode,
        targetPath: path.join(context.outDir, `trial-${context.repeat + 1}.png`),
        awaitCompletion: true,
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
    // Remote, billed or hand-off providers send the prompt off the machine or cost money.
    requiresExplicitOptIn: (providerId) => {
      const provider = deps.getProvider(providerId);
      return (
        !provider ||
        provider.executionLocality !== 'local' ||
        provider.costTier === 'paid' ||
        provider.requiresInteractiveHandoff === true
      );
    },
  };
}

export const imageGenerationProviderCalibrationAdapter = createImageGenerationCalibrationAdapter();
