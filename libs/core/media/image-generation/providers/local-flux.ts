import * as path from 'node:path';
import { getRegisteredEnvText } from '../../../foundation/env.js';
import { safeExecResult, safeExistsSync, safeMkdir } from '../../../secure-io.js';
import { resolveLocalFluxGenerationPolicy } from '../../image-generation-policy.js';
import { probeToolRuntime } from '../../../tool/tool-runtime-registry.js';
import {
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageGenerationProvider,
  ImageReference,
} from '../../image-generation-types.js';
import { resolveReferenceImagePath } from '../../image-reference-consent.js';
import { isAppleSilicon } from '../../../platform.js';
import { getFallbackTargetPath } from '../provider-support.js';

function resolveLocalFluxDimensions(request: ImageGenerationRequest): {
  width: number;
  height: number;
} {
  if (request.width && request.height) {
    return {
      width: Math.max(16, Math.round(request.width / 16) * 16),
      height: Math.max(16, Math.round(request.height / 16) * 16),
    };
  }

  const ratio = String(request.aspectRatio || '1:1')
    .replace('/', ':')
    .trim();
  switch (ratio) {
    case '16:9':
      return { width: 1344, height: 768 };
    case '9:16':
      return { width: 768, height: 1344 };
    case '4:3':
      return { width: 1152, height: 864 };
    case '3:4':
      return { width: 864, height: 1152 };
    case '3:2':
      return { width: 1216, height: 832 };
    case '2:3':
      return { width: 832, height: 1216 };
    case '16:10':
      return { width: 1280, height: 800 };
    case '10:16':
      return { width: 800, height: 1280 };
    default:
      return { width: 1024, height: 1024 };
  }
}

function pickLocalInitImage(references: ImageReference[] | undefined): ImageReference | undefined {
  if (!references || references.length === 0) return undefined;
  return (
    references.find((ref) => ref.role === 'consistency') ||
    references.find((ref) => (ref.role ?? 'subject') === 'subject') ||
    references[0]
  );
}

async function runLocalFluxGeneration(
  request: ImageGenerationRequest,
  startedAt: number,
  providerId: string
): Promise<ImageGenerationResult> {
  const outputPath = getFallbackTargetPath(request);
  const outputDir = path.dirname(outputPath);
  if (!safeExistsSync(outputDir)) {
    safeMkdir(outputDir, { recursive: true });
  }

  const policy = resolveLocalFluxGenerationPolicy(process.env, request.mode);
  const model = policy.model;
  const { width, height } = resolveLocalFluxDimensions(request);
  const steps = policy.steps;
  const quantize = policy.quantize;
  const packageSpec = policy.packageSpec;

  const runtime = probeToolRuntime('mflux', 'trial');
  if (runtime.selected_action === 'install') {
    return {
      status: 'failed',
      provider: providerId,
      elapsedMs: Date.now() - startedAt,
      error: 'mflux_install_required',
    };
  }

  const runner = runtime.selected_backend || runtime.trial_backend;
  const args = [...(runner.args || [])];
  if (runner.command === 'uvx') {
    const fromIndex = args.indexOf('--from');
    if (fromIndex >= 0 && args[fromIndex + 1]) {
      args[fromIndex + 1] = packageSpec;
    }
  }
  if (!args.includes('--model') && !args.includes('-m')) {
    args.push('--model', model);
  }
  args.push(
    '--prompt',
    request.prompt,
    '--width',
    String(width),
    '--height',
    String(height),
    '--steps',
    String(steps),
    '--output',
    outputPath
  );
  if (quantize !== undefined) {
    args.push('-q', String(quantize));
  }
  const seed = getRegisteredEnvText('KYBERION_MFLUX_SEED')?.trim();
  if (seed) {
    args.push('--seed', seed);
  }
  // PA-10: mflux img2img takes one init image (`--image-path`). A consistency
  // frame (e.g. the generated neutral) keeps an expression set coherent, so it
  // wins over the raw subject photo. Local only — nothing leaves the machine.
  const initImage = pickLocalInitImage(request.referenceImages);
  if (initImage) {
    args.push('--image-path', resolveReferenceImagePath(initImage), '--image-strength', '0.45');
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
        'mflux_generation_failed',
    };
  }

  if (!safeExistsSync(outputPath)) {
    return {
      status: 'failed',
      provider: providerId,
      elapsedMs: Date.now() - startedAt,
      error: 'mflux_output_missing',
    };
  }

  return {
    status: 'succeeded',
    provider: providerId,
    path: outputPath,
    elapsedMs: Date.now() - startedAt,
  };
}

export class LocalDiffusionImageGenerationProvider implements ImageGenerationProvider {
  /** mflux img2img (`--image-path`): one local init image, nothing leaves the machine. */
  readonly supportsReferenceImages = true;
  readonly dataEgress = 'local';
  readonly id = 'local_diffusion';
  readonly costTier = 'self_hosted';
  readonly dataPolicy = 'local_only';
  readonly executionLocality = 'local';

  async isAvailable(): Promise<boolean> {
    return isAppleSilicon() && probeToolRuntime('mflux').selected_action !== 'install';
  }

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    return await runLocalFluxGeneration(request, Date.now(), this.id);
  }
}

export class LocalFluxImageGenerationProvider implements ImageGenerationProvider {
  /** mflux img2img (`--image-path`): one local init image, nothing leaves the machine. */
  readonly supportsReferenceImages = true;
  readonly dataEgress = 'local';
  readonly id = 'local_flux';
  readonly backendIds = ['media-generation.local_flux'];
  readonly costTier = 'self_hosted';
  readonly dataPolicy = 'local_only';
  readonly executionLocality = 'local';

  async isAvailable(): Promise<boolean> {
    return isAppleSilicon() && probeToolRuntime('mflux').selected_action !== 'install';
  }

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    return await runLocalFluxGeneration(request, Date.now(), this.id);
  }
}
