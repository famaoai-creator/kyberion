import * as path from 'node:path';
import { safeExistsSync, safeExecResult, safeMkdir } from '../../../secure-io.js';
import { probeToolRuntime } from '../../../tool/tool-runtime-registry.js';
import { isAppleSilicon } from '../../../platform.js';
import {
  clampMusicGenDurationSec,
  resolveLocalMusicGenMlxGenerationPolicy,
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

async function runLocalMusicGenMlxGeneration(
  request: MusicGenerationRequest,
  startedAt: number,
  providerId: string
): Promise<MusicGenerationResult> {
  const outputPath = ensureWavTargetPath(getFallbackTargetPath(request));
  const outputDir = path.dirname(outputPath);
  if (!safeExistsSync(outputDir)) {
    safeMkdir(outputDir, { recursive: true });
  }

  const policy = resolveLocalMusicGenMlxGenerationPolicy();
  const durationSec = clampMusicGenDurationSec(request.durationSec, policy);
  const model = request.model?.trim() || policy.model;
  const packageSpec = policy.packageSpec;
  const prompt = request.prompt.trim();
  if (!prompt) {
    return {
      status: 'failed',
      provider: providerId,
      elapsedMs: Date.now() - startedAt,
      error: 'musicgen_prompt_required',
    };
  }

  const runtime = probeToolRuntime('musicgen_mlx', 'trial');
  if (runtime.selected_action === 'install') {
    return {
      status: 'failed',
      provider: providerId,
      elapsedMs: Date.now() - startedAt,
      error: 'musicgen_mlx_install_required',
    };
  }

  const runner = runtime.selected_backend || runtime.trial_backend;
  let args = [...(runner.args || [])];
  if (runner.command === 'uvx') {
    args = patchUvxPackageSpec(args, packageSpec);
  }

  // musicgen-mlx CLI: musicgen-mlx "<prompt>" [-m model] -d <sec> -o <path>
  args.push(prompt);
  if (!args.includes('-m') && !args.includes('--model')) {
    args.push('-m', model);
  }
  args.push('-d', String(durationSec), '-o', outputPath);

  const result = safeExecResult(runner.command, args, {
    timeoutMs: policy.timeoutMs,
    maxOutputMB: 50,
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
        'musicgen_mlx_generation_failed',
    };
  }

  if (!safeExistsSync(outputPath)) {
    return {
      status: 'failed',
      provider: providerId,
      elapsedMs: Date.now() - startedAt,
      error: 'musicgen_mlx_output_missing',
    };
  }

  return {
    status: 'succeeded',
    provider: providerId,
    path: outputPath,
    elapsedMs: Date.now() - startedAt,
  };
}

export class LocalMusicGenMlxGenerationProvider implements MusicGenerationProvider {
  readonly id = 'musicgen_mlx';
  readonly costTier = 'self_hosted';
  readonly dataPolicy = 'local_only';
  readonly executionLocality = 'local';
  readonly outputFormats = ['wav'] as const;
  /** MusicGen renders instrumental audio only — no sung voice. */
  readonly supportsVocals = false;

  maxDurationSec(): number {
    return resolveLocalMusicGenMlxGenerationPolicy().maxDurationSec;
  }

  async isAvailable(): Promise<boolean> {
    return isAppleSilicon() && probeToolRuntime('musicgen_mlx').selected_action !== 'install';
  }

  async generate(request: MusicGenerationRequest): Promise<MusicGenerationResult> {
    return await runLocalMusicGenMlxGeneration(request, Date.now(), this.id);
  }
}
