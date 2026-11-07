import * as path from 'node:path';
import { safeExistsSync, safeExecResult, safeMkdir } from '@agent/core/secure-io';
import { probeToolRuntime } from '@agent/core/tool/tool-runtime-registry';
import {
  clampStableAudioDurationSec,
  resolveLocalStableAudioGenerationPolicy,
} from '../../music-generation-policy.js';
import type {
  MusicGenerationProvider,
  MusicGenerationRequest,
  MusicGenerationResult,
} from '../../music-generation-types.js';
import {
  getFallbackTargetPath,
  ensureWavTargetPath,
  patchUvxPackageSpec,
} from '../provider-support.js';

async function runLocalStableAudioGeneration(
  request: MusicGenerationRequest,
  startedAt: number,
  providerId: string
): Promise<MusicGenerationResult> {
  const outputPath = ensureWavTargetPath(getFallbackTargetPath(request));
  const outputDir = path.dirname(outputPath);
  if (!safeExistsSync(outputDir)) {
    safeMkdir(outputDir, { recursive: true });
  }

  const policy = resolveLocalStableAudioGenerationPolicy();
  const durationSec = clampStableAudioDurationSec(request.durationSec, policy);
  const model = request.model?.trim() || policy.model;
  const packageSpec = policy.packageSpec;
  const prompt = request.prompt.trim();
  if (!prompt) {
    return {
      status: 'failed',
      provider: providerId,
      elapsedMs: Date.now() - startedAt,
      error: 'stable_audio_prompt_required',
    };
  }

  const runtime = probeToolRuntime('stable_audio_3', 'trial');
  if (runtime.selected_action === 'install') {
    return {
      status: 'failed',
      provider: providerId,
      elapsedMs: Date.now() - startedAt,
      error: 'stable_audio_3_install_required',
    };
  }

  const runner = runtime.selected_backend || runtime.trial_backend;
  let args = [...(runner.args || [])];
  if (runner.command === 'uvx') {
    args = patchUvxPackageSpec(args, packageSpec);
  }

  // stable-audio --model small-music -p "<prompt>" --duration <sec> -o <path> [--device ...] [--seed ...]
  args.push('--model', model, '-p', prompt, '--duration', String(durationSec), '-o', outputPath);
  if (policy.device) {
    args.push('--device', policy.device);
  }
  if (policy.steps) {
    args.push('--steps', String(policy.steps));
  }
  const seed = request.seed?.trim() || policy.seed;
  if (seed) {
    args.push('--seed', seed);
  }

  const result = safeExecResult(runner.command, args, {
    timeoutMs: policy.timeoutMs,
    maxOutputMB: 80,
  });

  if (result.status !== 0 || result.error) {
    return {
      status: 'failed',
      provider: providerId,
      elapsedMs: Date.now() - startedAt,
      error:
        result.stderr?.trim() ||
        result.stdout?.trim() ||
        result.error?.message ||
        'stable_audio_3_generation_failed',
    };
  }

  if (!safeExistsSync(outputPath)) {
    return {
      status: 'failed',
      provider: providerId,
      elapsedMs: Date.now() - startedAt,
      error: 'stable_audio_3_output_missing',
    };
  }

  return {
    status: 'succeeded',
    provider: providerId,
    path: outputPath,
    elapsedMs: Date.now() - startedAt,
  };
}

export class LocalStableAudioGenerationProvider implements MusicGenerationProvider {
  readonly id = 'stable_audio_3';
  readonly costTier = 'self_hosted';
  readonly dataPolicy = 'local_only';
  readonly executionLocality = 'local';
  readonly outputFormats = ['wav'] as const;
  /** Stable Audio renders instrumental audio only — no sung voice. */
  readonly supportsVocals = false;

  maxDurationSec(): number {
    return resolveLocalStableAudioGenerationPolicy().maxDurationSec;
  }

  async isAvailable(): Promise<boolean> {
    return probeToolRuntime('stable_audio_3').selected_action !== 'install';
  }

  async generate(request: MusicGenerationRequest): Promise<MusicGenerationResult> {
    return await runLocalStableAudioGeneration(request, Date.now(), this.id);
  }
}
