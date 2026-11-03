import * as path from 'node:path';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeExecResult,
  safeMkdir,
  safeWriteFile,
} from '../../../secure-io.js';
import { probeToolRuntime } from '../../../tool/tool-runtime-registry.js';
import { isAppleSilicon } from '../../../platform.js';
import {
  MUSAUDIOGEN_REQUIRED_FILES,
  MUSAUDIOGEN_VARIANT_HF_REPO,
  clampMlAudioGenDurationSec,
  clampMusicGenDurationSec,
  clampStableAudioDurationSec,
  resolveChatMusicianGenerationPolicy,
  resolveLocalMusicGenMlxGenerationPolicy,
  resolveLocalStableAudioGenerationPolicy,
  resolveMlAudioGenGenerationPolicy,
  resolveMlAudioGenVariant,
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

/**
 * Resolve the `--weights-dir` for mlx-audiogen. An explicit env value that
 * looks like a path is used as-is (user-managed). Otherwise the variant
 * short name maps to a pre-converted weight repo that is downloaded once
 * into the tool's own model cache (`~/.mlx-audiogen/models/<variant>`).
 */
function provisionMlAudioGenWeights(
  variant: string,
  policy: { weightsDir?: string; timeoutMs: number }
): { dir: string } | { error: string } {
  const explicit = variant.trim();
  if (explicit.includes('/') || explicit.includes('\\')) {
    return { dir: explicit };
  }
  const repo = MUSAUDIOGEN_VARIANT_HF_REPO[explicit];
  if (!repo) {
    return {
      error:
        `musicgen_audiogen_weights_required: set KYBERION_MUSAUDIOGEN_WEIGHTS_DIR to a converted ` +
        `weights dir (mlx-audiogen-convert --model facebook/<variant> --output <dir>)`,
    };
  }
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const cacheDir = home
    ? path.join(home, '.mlx-audiogen', 'models', explicit)
    : path.join('active', 'shared', 'cache', 'mlx-audiogen', explicit);
  const complete = MUSAUDIOGEN_REQUIRED_FILES.every((file) =>
    safeExistsSync(path.join(cacheDir, file))
  );
  if (complete) return { dir: cacheDir };
  // huggingface_hub renamed its CLI to `hf`; older installs still ship
  // `huggingface-cli`. Try the new name first, then the legacy one.
  let downloadError = '';
  for (const cli of ['hf', 'huggingface-cli']) {
    const download = safeExecResult(
      'uvx',
      ['--from', 'huggingface_hub', cli, 'download', repo, '--local-dir', cacheDir],
      { timeoutMs: policy.timeoutMs, maxOutputMB: 20 }
    );
    if (download.status === 0 && !download.error) {
      downloadError = '';
      break;
    }
    downloadError = download.stderr?.trim() || download.stdout?.trim() || '';
  }
  if (downloadError) {
    return {
      error:
        downloadError ||
        `musicgen_audiogen_weights_download_failed: pre-converted weights for '${explicit}' ` +
          `could not be fetched from ${repo}; convert manually (mlx-audiogen-convert --model ` +
          `facebook/${explicit} --output <dir>) and set KYBERION_MUSAUDIOGEN_WEIGHTS_DIR`,
    };
  }
  const ready = MUSAUDIOGEN_REQUIRED_FILES.every((file) =>
    safeExistsSync(path.join(cacheDir, file))
  );
  if (!ready) {
    return {
      error: `musicgen_audiogen_weights_incomplete: ${cacheDir} lacks ${MUSAUDIOGEN_REQUIRED_FILES.join(', ')}`,
    };
  }
  return { dir: cacheDir };
}

async function runMlAudioGenGeneration(
  request: MusicGenerationRequest,
  startedAt: number,
  providerId: string
): Promise<MusicGenerationResult> {
  const outputPath = ensureWavTargetPath(getFallbackTargetPath(request));
  const outputDir = path.dirname(outputPath);
  if (!safeExistsSync(outputDir)) {
    safeMkdir(outputDir, { recursive: true });
  }

  const policy = resolveMlAudioGenGenerationPolicy();
  const durationSec = clampMlAudioGenDurationSec(request.durationSec, policy);
  const prompt = request.prompt.trim();
  if (!prompt) {
    return {
      status: 'failed',
      provider: providerId,
      elapsedMs: Date.now() - startedAt,
      error: 'musicgen_audiogen_prompt_required',
    };
  }

  const runtime = probeToolRuntime('musicgen_audiogen', 'trial');
  if (runtime.selected_action === 'install') {
    return {
      status: 'failed',
      provider: providerId,
      elapsedMs: Date.now() - startedAt,
      error: 'musicgen_audiogen_install_required',
    };
  }

  const runner = runtime.selected_backend || runtime.trial_backend;
  let args = [...(runner.args || [])];
  if (runner.command === 'uvx') {
    args = patchUvxPackageSpec(args, policy.packageSpec);
  }

  // mlx-audiogen CLI: mlx-audiogen --model musicgen --prompt "<p>" --seconds <s> --output <path>
  // The model variant (mono/stereo/melody) follows --weights-dir, which the
  // bridge always passes: explicit env path as-is, otherwise a provisioned
  // pre-converted weights dir (auto-downloaded once). request.model selects
  // the variant (never forwarded).
  const weights = provisionMlAudioGenWeights(
    resolveMlAudioGenVariant(request.model, policy),
    policy
  );
  if ('error' in weights) {
    return {
      status: 'failed',
      provider: providerId,
      elapsedMs: Date.now() - startedAt,
      error: weights.error,
    };
  }
  args.push(
    '--model',
    'musicgen',
    '--prompt',
    prompt,
    '--seconds',
    String(durationSec),
    '--output',
    outputPath,
    '--weights-dir',
    weights.dir,
    '--top-k',
    String(policy.topK),
    '--guidance-coef',
    String(policy.guidance)
  );
  const seed = request.seed?.trim() || policy.seed;
  if (seed) {
    args.push('--seed', seed);
  }

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
        'musicgen_audiogen_generation_failed',
    };
  }

  if (!safeExistsSync(outputPath)) {
    return {
      status: 'failed',
      provider: providerId,
      elapsedMs: Date.now() - startedAt,
      error: 'musicgen_audiogen_output_missing',
    };
  }

  return {
    status: 'succeeded',
    provider: providerId,
    path: outputPath,
    elapsedMs: Date.now() - startedAt,
  };
}

export class MlAudioGenGenerationProvider implements MusicGenerationProvider {
  readonly id = 'musicgen_audiogen';
  readonly costTier = 'self_hosted';
  readonly dataPolicy = 'local_only';
  readonly executionLocality = 'local';
  readonly outputFormats = ['wav'] as const;
  /** mlx-audiogen musicgen renders instrumental audio only — no sung voice. */
  readonly supportsVocals = false;

  maxDurationSec(): number {
    return resolveMlAudioGenGenerationPolicy().maxDurationSec;
  }

  async isAvailable(): Promise<boolean> {
    try {
      return (
        isAppleSilicon() && probeToolRuntime('musicgen_audiogen').selected_action !== 'install'
      );
    } catch {
      // Availability probes must never throw (see ChatMusician provider).
      return false;
    }
  }

  async generate(request: MusicGenerationRequest): Promise<MusicGenerationResult> {
    return await runMlAudioGenGeneration(request, Date.now(), this.id);
  }
}
