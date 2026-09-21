/**
 * Calibration adapter for seam `video-generation-provider`: the same prompt on
 * each text-to-video backend that can run it, through the media-generation
 * actuator (op preflight, provider adapters, artifact download), one clip per
 * trial in the run directory. Every API backend is billed / off-machine, so
 * it only runs when listed in --providers. A human judges the clips; the
 * runner's latency becomes the suggested `speed` trait.
 */

import * as path from 'node:path';
import { getMediaBackendRecord } from '@agent/core/media-backend-registry';
import type { SeamCalibrationAdapter } from '@agent/core/seam-calibration';
import type { SeamProviderCandidate } from '@agent/core/seam-provider-selection';
import { safeExistsSync, safeStat } from '@agent/core/secure-io';
import { listVideoGenerationCandidates } from '../../../libs/actuators/media-generation-actuator/src/video-generation-provider.js';

export interface VideoCalibrationInput {
  prompt: string;
  aspect_ratio?: string;
  resolution?: string;
  duration_seconds?: number;
  generate_audio?: boolean;
  first_frame_image?: string;
  last_frame_image?: string;
  /** ComfyUI workflow (object) — needed for media-generation.comfyui.video to be a candidate. */
  workflow?: unknown;
  workflow_path?: string;
  timeout_ms?: number;
}

type GenerationResult = Record<string, unknown>;

export interface VideoCalibrationDeps {
  listCandidates(input: VideoCalibrationInput): Promise<SeamProviderCandidate[]>;
  generate(params: Record<string, unknown>): Promise<GenerationResult>;
  requiresExplicitOptIn(backendId: string): boolean;
}

const defaultDeps: VideoCalibrationDeps = {
  listCandidates: (input) => listVideoGenerationCandidates({ ...input }),
  generate: async (params) => {
    const { handleAction } =
      await import('../../../libs/actuators/media-generation-actuator/src/media-generation-action-helpers.js');
    return (await handleAction({ action: 'generate_video', params })) as GenerationResult;
  },
  requiresExplicitOptIn: (backendId) => {
    const record = getMediaBackendRecord(backendId, 'video');
    return (
      record.backend_id !== backendId ||
      record.kind === 'api' ||
      record.execution_locality !== 'local' ||
      record.cost_tier === 'paid'
    );
  },
};

function requirePrompt(input: VideoCalibrationInput): string {
  const prompt = typeof input?.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt) throw new Error('video-generation-provider calibration input needs a prompt');
  return prompt;
}

function artifactPath(result: GenerationResult): string | undefined {
  const artifact = result.artifact as { path?: unknown } | null | undefined;
  const candidates = [result.output_path, result.copied_to, artifact?.path];
  return candidates.find((value): value is string => typeof value === 'string' && value.length > 0);
}

export function createVideoGenerationCalibrationAdapter(
  deps: VideoCalibrationDeps = defaultDeps
): SeamCalibrationAdapter<VideoCalibrationInput> {
  return {
    seam: 'video-generation-provider',
    description:
      'Generate the same prompt with each text-to-video backend (billed APIs only when listed in --providers); compare the clips.',
    input_example: {
      prompt: 'A slow dolly shot across a quiet harbour at dawn',
      aspect_ratio: '16:9',
      duration_seconds: 5,
    },
    listCandidates: async (input) => {
      requirePrompt(input);
      return deps.listCandidates(input);
    },
    runTrial: async (backendId, input, context) => {
      const result = await deps.generate({
        ...input,
        prompt: requirePrompt(input),
        backend_id: backendId,
        await_completion: true,
        target_path: path.join(context.outDir, `trial-${context.repeat + 1}.mp4`),
        no_style_pack: true,
      });
      const output = artifactPath(result);
      if (result.status !== 'succeeded' || !output) {
        const message = typeof result.message === 'string' ? result.message : undefined;
        const error = typeof result.error === 'string' ? result.error : undefined;
        return { ok: false, error: message || error || `status ${String(result.status)}` };
      }
      if (!safeExistsSync(output)) {
        return { ok: false, error: `generation reported ${output} but no file exists` };
      }
      return {
        ok: true,
        output: { artifact_path: output },
        metrics: { bytes: safeStat(output).size },
      };
    },
    trait_mappings: { speed: { metric: 'latency_ms', higher_is_better: false } },
    requiresExplicitOptIn: (backendId) => deps.requiresExplicitOptIn(backendId),
  };
}

export const videoGenerationProviderCalibrationAdapter = createVideoGenerationCalibrationAdapter();
