import * as path from 'node:path';
import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { safeExecResult, safeExistsSync, safeMkdir, safeWriteFile } from './secure-io.js';
import { executeServicePreset } from './service-engine.js';
import { resolveServiceBinding } from './service-binding.js';
import { resolveLocalFluxGenerationPolicy } from './image-generation-policy.js';
import { probeToolRuntime } from './tool-runtime-registry.js';
import { probeServiceRuntime } from './service-runtime-registry.js';
import {
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageGenerationProvider
} from './image-generation-types.js';

function getFallbackTargetPath(request: ImageGenerationRequest): string {
  const filename = `generated-${Date.now()}-${Math.random().toString(36).substring(2, 7)}.jpg`;
  return request.targetPath || pathResolver.resolve(`active/shared/tmp/${filename}`);
}

function isAppleSiliconMac(): boolean {
  return process.platform === 'darwin' && process.arch === 'arm64';
}

function resolveLocalFluxDimensions(request: ImageGenerationRequest): { width: number; height: number } {
  if (request.width && request.height) {
    return {
      width: Math.max(16, Math.round(request.width / 16) * 16),
      height: Math.max(16, Math.round(request.height / 16) * 16),
    };
  }

  const ratio = String(request.aspectRatio || '1:1').replace('/', ':').trim();
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

async function runLocalFluxGeneration(
  request: ImageGenerationRequest,
  startedAt: number,
  providerId: string,
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
  args.push(
    '--model',
    model,
    '--prompt',
    request.prompt,
    '--width',
    String(width),
    '--height',
    String(height),
    '--steps',
    String(steps),
    '--output',
    outputPath,
  );
  if (quantize !== undefined) {
    args.push('-q', String(quantize));
  }
  const seed = process.env.KYBERION_MFLUX_SEED?.trim();
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
      error: result.stderr?.trim() || result.stdout?.trim() || result.error?.message || 'mflux_generation_failed',
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

export class ComfyUiImageGenerationProvider implements ImageGenerationProvider {
  readonly id = 'comfyui';

  async isAvailable(): Promise<boolean> {
    const resolution = await probeServiceRuntime('comfyui', 'trial');
    return resolution.available;
  }

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const startedAt = Date.now();
    try {
      // Delegate to existing ComfyUI service preset
      const res = await executeServicePreset('media-generation', 'generate_image', {
        prompt: request.prompt,
        aspect_ratio: request.aspectRatio,
        target_path: request.targetPath,
        await_completion: request.awaitCompletion ?? true,
      });

      return {
        status: res?.prompt_id ? 'submitted' : 'succeeded',
        path: res?.copied_to || res?.target_path || request.targetPath,
        provider: this.id,
        promptId: res?.prompt_id,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error: any) {
      logger.error(`[image_generation_bridge] ComfyUI generation failed: ${error.message}`);
      return {
        status: 'failed',
        provider: this.id,
        elapsedMs: Date.now() - startedAt,
        error: error.message || 'comfyui_generation_failed',
      };
    }
  }
}

export class GeminiServiceImageGenerationProvider implements ImageGenerationProvider {
  readonly id = 'gemini_service';

  async isAvailable(): Promise<boolean> {
    if (!process.env.GEMINI_API_KEY) return false;
    try {
      resolveServiceBinding('gemini', 'secret-guard');
      return true;
    } catch (_) {
      return false;
    }
  }

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const startedAt = Date.now();
    try {
      const response = await executeServicePreset(
        'gemini',
        'generate_image',
        {
          prompt: request.prompt,
          aspect_ratio: request.aspectRatio || '1:1',
        },
        'secret-guard',
      );

      const imageBytes =
        typeof response === 'string'
          ? response
          : (response as any)?.imageBytes
            || (response as any)?.generatedImages?.[0]?.image?.imageBytes
            || (response as any)?.result?.imageBytes;

      if (!imageBytes || typeof imageBytes !== 'string') {
        throw new Error('Gemini image service returned no image bytes');
      }

      const targetPath = getFallbackTargetPath(request);
      const buffer = Buffer.from(imageBytes, 'base64');
      safeWriteFile(targetPath, buffer);

      return {
        status: 'succeeded',
        provider: this.id,
        path: targetPath,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error: any) {
      logger.error(`[image_generation_bridge] Gemini service generation failed: ${error.message}`);
      return {
        status: 'failed',
        provider: this.id,
        elapsedMs: Date.now() - startedAt,
        error: error.message || 'gemini_image_generation_failed',
      };
    }
  }
}

export class LlmApiImageGenerationProvider implements ImageGenerationProvider {
  readonly id = 'llm_api';

  async isAvailable(): Promise<boolean> {
    return Boolean(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY);
  }

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const startedAt = Date.now();
    const apiKeyGemini = process.env.GEMINI_API_KEY;
    const apiKeyOpenAI = process.env.OPENAI_API_KEY;

    const order = request.providerPreference || ['gemini', 'openai'];

    for (const key of order) {
      if (key.includes('gemini') && apiKeyGemini) {
        return await this.callGeminiImagen(apiKeyGemini, request, startedAt);
      }
      if (key.includes('openai') && apiKeyOpenAI) {
        return await this.callOpenAIDallE(apiKeyOpenAI, request, startedAt);
      }
    }

    if (apiKeyGemini) return await this.callGeminiImagen(apiKeyGemini, request, startedAt);
    if (apiKeyOpenAI) return await this.callOpenAIDallE(apiKeyOpenAI, request, startedAt);

    throw new Error('No Cloud Image Generation API key available.');
  }

  private async callGeminiImagen(apiKey: string, request: ImageGenerationRequest, startedAt: number): Promise<ImageGenerationResult> {
    // Default to Imagen 3 API
    const url = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:generateImages?key=${apiKey}`;
    
    // aspect ratio can be '1:1', '3:4', '4:3', '9:16', or '16:9'
    let resolvedRatio = request.aspectRatio || '1:1';
    if (resolvedRatio === '16/9') resolvedRatio = '16:9';
    if (resolvedRatio === '9/16') resolvedRatio = '9:16';

    const payload = {
      numberOfImages: 1,
      prompt: request.prompt,
      aspectRatio: resolvedRatio,
      outputMimeType: 'image/jpeg'
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`Gemini Imagen API error: ${res.statusText} (${res.status})`);
    }

    const data = await res.json() as any;
    const base64Bytes = data.generatedImages?.[0]?.image?.imageBytes;
    if (!base64Bytes) {
      throw new Error('Gemini Imagen API returned no image bytes');
    }

    const targetPath = getFallbackTargetPath(request);
    const buffer = Buffer.from(base64Bytes, 'base64');
    safeWriteFile(targetPath, buffer);

    return {
      status: 'succeeded',
      provider: 'gemini_imagen',
      path: targetPath,
      elapsedMs: Date.now() - startedAt,
    };
  }

  private async callOpenAIDallE(apiKey: string, request: ImageGenerationRequest, startedAt: number): Promise<ImageGenerationResult> {
    const url = 'https://api.openai.com/v1/images/generations';
    
    // Resolve size mapping for DALL-E 3
    let size = '1024x1024';
    if (request.aspectRatio === '16:9' || request.aspectRatio === '16/9') size = '1792x1024';
    if (request.aspectRatio === '9:16' || request.aspectRatio === '9/16') size = '1024x1792';

    const payload = {
      model: 'dall-e-3',
      prompt: request.prompt,
      n: 1,
      size,
      response_format: 'b64_json'
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`OpenAI DALL-E API error: ${res.statusText} (${res.status})`);
    }

    const data = await res.json() as any;
    const base64Bytes = data.data?.[0]?.b64_json;
    if (!base64Bytes) {
      throw new Error('OpenAI DALL-E API returned no image bytes');
    }

    const targetPath = getFallbackTargetPath(request);
    const buffer = Buffer.from(base64Bytes, 'base64');
    safeWriteFile(targetPath, buffer);

    return {
      status: 'succeeded',
      provider: 'dalle_3',
      path: targetPath,
      elapsedMs: Date.now() - startedAt,
    };
  }
}

export class LocalDiffusionImageGenerationProvider implements ImageGenerationProvider {
  readonly id = 'local_diffusion';

  async isAvailable(): Promise<boolean> {
    return isAppleSiliconMac() && probeToolRuntime('mflux').selected_action !== 'install';
  }

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    return await runLocalFluxGeneration(request, Date.now(), this.id);
  }
}

export class LocalFluxImageGenerationProvider implements ImageGenerationProvider {
  readonly id = 'local_flux';

  async isAvailable(): Promise<boolean> {
    return isAppleSiliconMac() && probeToolRuntime('mflux').selected_action !== 'install';
  }

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    return await runLocalFluxGeneration(request, Date.now(), this.id);
  }
}

export class AdaptivePolicyRouter {
  private providers: Map<string, ImageGenerationProvider> = new Map();

  constructor(providers: ImageGenerationProvider[]) {
    for (const p of providers) {
      this.providers.set(p.id, p);
    }
  }

  async selectProvider(request: ImageGenerationRequest): Promise<ImageGenerationProvider> {
    if (request.providerPreference && request.providerPreference.length > 0) {
      for (const id of request.providerPreference) {
        const provider = this.providers.get(id);
        if (provider && (await provider.isAvailable())) {
          return provider;
        }
      }
    }

    const mode = request.mode || 'balanced';

    let defaultChain: string[] = [];
    if (mode === 'local_only' || mode === 'privacy_first') {
      defaultChain = ['local_flux', 'local_diffusion', 'comfyui'];
    } else if (mode === 'artistic') {
      defaultChain = ['gemini_service', 'llm_api', 'local_flux', 'comfyui'];
    } else {
      // balanced
      defaultChain = ['local_flux', 'comfyui', 'gemini_service', 'llm_api'];
    }

    for (const id of defaultChain) {
      const provider = this.providers.get(id);
      if (provider && (await provider.isAvailable())) {
        return provider;
      }
    }

    throw new Error('No available Image Generation provider could be resolved.');
  }
}

let globalRouter: AdaptivePolicyRouter | null = null;

function getRouter(): AdaptivePolicyRouter {
  if (!globalRouter) {
    globalRouter = new AdaptivePolicyRouter([
      new ComfyUiImageGenerationProvider(),
      new GeminiServiceImageGenerationProvider(),
      new LlmApiImageGenerationProvider(),
      new LocalFluxImageGenerationProvider(),
      new LocalDiffusionImageGenerationProvider()
    ]);
  }
  return globalRouter;
}

export async function generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
  const router = getRouter();
  const provider = await router.selectProvider(request);
  logger.info(`[image_generation_bridge] Routing generation request to provider: ${provider.id}`);
  return await provider.generate(request);
}
