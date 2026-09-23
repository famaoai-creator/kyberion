import * as path from 'node:path';
import { logger } from './core.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { isRecord } from './foundation/text.js';
import { nowIso } from './foundation/time.js';
import { pathResolver } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExecResult,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} from './secure-io.js';
import { executeServicePreset } from './service-engine.js';
import { resolveServiceBinding } from './service-binding.js';
import { resolveLocalFluxGenerationPolicy } from './image-generation-policy.js';
import { getMediaBackendRegistry } from './media-backend-registry.js';
import { probeToolRuntime } from './tool-runtime-registry.js';
import { probeServiceRuntime } from './service-runtime-registry.js';
import { parseSafeJsonObjectValue } from './foundation/safe-json.js';
import {
  generateImageLocallyWithApplePlayground,
  probeAppleImageGeneration,
} from './apple-intelligence-bridge.js';
import {
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageGenerationProvider,
  ImageReference,
} from './image-generation-types.js';
import {
  assertReferenceEgressAllowed,
  hasReferenceImages,
  imageProviderDataEgress,
  recordReferenceEgressReceipt,
  referenceImageViolation,
  resolveReferenceImagePath,
} from './image-reference-consent.js';
import {
  generateImageWithWindowsNativeApi,
  probeWindowsNativeImageGeneration,
} from './windows-native-image-generation-bridge.js';
import { resolveGeminiApiKey } from './gemini-api-backend.js';
import { isAppleSilicon } from './platform.js';
import { coreSeamCatalog, createSeam } from './seam.js';
import {
  explainSeamProviderDecision,
  listSeamSelectionPurposes,
  resolveSeamProviderDecision,
  type ResolveSeamProviderOptions,
  type SeamProviderCandidate,
} from './seam-provider-selection.js';
import { matchSeamSelectionRule } from './seam-selection-rules.js';

const IMAGE_GENERATION_PROVIDER_SEAM = 'image-generation-provider';

const imageGenerationProviderSeam = createSeam<ImageGenerationProvider>({
  key: 'image-generation-provider',
  multiplicity: 'named',
  catalog: coreSeamCatalog,
});

const imageGenerationProviderDisposers = new Map<string, () => void>();
// Held as AdaptivePolicyRouter once classes below are constructed.
let imageGenerationGlobalRouter: any = null;
let imageGenerationBuiltinsRegistered = false;

/** Register an image-generation backend into the image-generation-provider seam. */
export function registerImageGenerationProvider(provider: ImageGenerationProvider): () => void {
  const id = String(provider.id || '').trim();
  if (!id) throw new Error('ImageGenerationProvider.id is required');
  imageGenerationProviderDisposers.get(id)?.();
  const disposer = imageGenerationProviderSeam.register(id, provider, {
    provenance: 'builtin',
    source: 'image-generation-bridge',
  });
  imageGenerationProviderDisposers.set(id, disposer);
  imageGenerationGlobalRouter = null;
  return disposer;
}

export function listImageGenerationProviders(): ImageGenerationProvider[] {
  return imageGenerationProviderSeam.list().map((entry) => entry.implementation);
}

export function resetImageGenerationProviders(): void {
  for (const dispose of imageGenerationProviderDisposers.values()) {
    try {
      dispose();
    } catch {
      /* noop */
    }
  }
  imageGenerationProviderDisposers.clear();
  imageGenerationGlobalRouter = null;
  imageGenerationBuiltinsRegistered = false;
}

function getFallbackTargetPath(request: ImageGenerationRequest): string {
  const filename = `generated-${Date.now()}-${Math.random().toString(36).substring(2, 7)}.jpg`;
  const candidate = request.targetPath || pathResolver.resolve(`active/shared/tmp/${filename}`);
  assertSafeRepositoryPath(pathResolver.resolve(candidate), { allowMissingLeaf: true });
  return candidate;
}

export function isRateLimitOrQuotaError(error: unknown): boolean {
  if (!error) return false;
  const msg = error instanceof Error ? error.message : String(error);
  return /429|resource_exhausted|rate\s*limit|quota/i.test(msg);
}

function imageBytesFromResponse(value: unknown): string | undefined {
  if (typeof value === 'string') return normalizeImageBytes(value);
  if (!isRecord(value)) return undefined;
  let safeValue: Record<string, unknown>;
  try {
    safeValue = parseSafeJsonObjectValue(value, 'image generation response');
  } catch {
    return undefined;
  }
  const direct = normalizeImageBytes(safeValue.imageBytes);
  if (direct) return direct;
  if (Array.isArray(safeValue.generatedImages)) {
    const first = safeValue.generatedImages[0];
    if (isRecord(first) && isRecord(first.image)) {
      const nested = normalizeImageBytes(first.image.imageBytes);
      if (nested) return nested;
    }
  }
  if (isRecord(safeValue.result)) return normalizeImageBytes(safeValue.result.imageBytes);
  return undefined;
}

function normalizeImageBytes(candidate: unknown): string | undefined {
  if (typeof candidate !== 'string') return undefined;
  const normalized = candidate.trim();
  if (!normalized || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]+=*$/u.test(normalized)) {
    return undefined;
  }
  const decoded = Buffer.from(normalized, 'base64');
  if (decoded.length === 0) return undefined;
  const withoutPadding = normalized.replace(/=+$/u, '');
  if (decoded.toString('base64').replace(/=+$/u, '') !== withoutPadding) return undefined;
  return normalized;
}

function dallEImageBytesFromResponse(value: unknown): string | undefined {
  try {
    const safeValue = parseSafeJsonObjectValue(value, 'OpenAI DALL-E response');
    if (!Array.isArray(safeValue.data) || !isRecord(safeValue.data[0])) return undefined;
    return normalizeImageBytes(safeValue.data[0].b64_json);
  } catch {
    return undefined;
  }
}

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

export class ComfyUiImageGenerationProvider implements ImageGenerationProvider {
  readonly id = 'comfyui';
  readonly costTier = 'self_hosted';
  readonly dataPolicy = 'local_only';
  readonly executionLocality = 'local';

  async isAvailable(): Promise<boolean> {
    const resolution = await probeServiceRuntime('comfyui', 'trial');
    return resolution.available;
  }

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const startedAt = Date.now();
    try {
      const targetPath = request.targetPath ? getFallbackTargetPath(request) : undefined;
      // Delegate to existing ComfyUI service preset
      const res = await executeServicePreset('media-generation', 'generate_image', {
        prompt: request.prompt,
        aspect_ratio: request.aspectRatio,
        target_path: targetPath,
        await_completion: request.awaitCompletion ?? true,
      });

      return {
        status: res?.prompt_id ? 'submitted' : 'succeeded',
        path: res?.copied_to || res?.target_path || targetPath,
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

export class GeminiFastImageGenerationProvider implements ImageGenerationProvider {
  readonly id = 'gemini_fast';
  readonly costTier = 'free';
  readonly dataPolicy = 'training_eligible';
  readonly executionLocality = 'remote';

  async isAvailable(): Promise<boolean> {
    if (!resolveGeminiApiKey()) return false;
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
        'generate_image_fast',
        {
          prompt: request.prompt,
          aspect_ratio: request.aspectRatio || '1:1',
        },
        'secret-guard'
      );

      const imageBytes = imageBytesFromResponse(response);

      if (!imageBytes || typeof imageBytes !== 'string') {
        throw new Error('Gemini fast image service returned no image bytes');
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
      logger.error(
        `[image_generation_bridge] Gemini fast service generation failed: ${error.message}`
      );
      return {
        status: 'failed',
        provider: this.id,
        elapsedMs: Date.now() - startedAt,
        error: error.message || 'gemini_fast_image_generation_failed',
      };
    }
  }
}

export class GeminiServiceImageGenerationProvider implements ImageGenerationProvider {
  readonly id = 'gemini_service';
  readonly costTier = 'paid';
  readonly dataPolicy = 'zero_retention';
  readonly executionLocality = 'remote';

  async isAvailable(): Promise<boolean> {
    if (!resolveGeminiApiKey()) return false;
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
        'secret-guard'
      );

      const imageBytes = imageBytesFromResponse(response);

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

/** Default Gemini image model for reference-conditioned generation (PA-10). */
export const DEFAULT_GEMINI_IMAGE_MODEL = 'gemini-2.5-flash-image';
/** Keeps the inline-data request under the network guardrail (2 MB by default). */
const GEMINI_REFERENCE_MAX_BYTES = 1024 * 1024;
const GEMINI_REFERENCE_TOTAL_MAX_BYTES = 1400 * 1024;

export function resolveGeminiImageModel(): string {
  const configured = getRegisteredEnvText('KYBERION_GEMINI_IMAGE_MODEL')?.trim();
  if (!configured) return DEFAULT_GEMINI_IMAGE_MODEL;
  if (!/^[a-z0-9][a-z0-9.-]{0,79}$/u.test(configured)) {
    throw new Error(`KYBERION_GEMINI_IMAGE_MODEL is not a valid model id: ${configured}`);
  }
  return configured;
}

/** `generateContent` contents: every reference as `inlineData`, then the text prompt. */
export function buildGeminiImageContents(request: ImageGenerationRequest): Array<{
  role: 'user';
  parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }>;
}> {
  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
  let total = 0;
  for (const reference of request.referenceImages ?? []) {
    const referencePath = resolveReferenceImagePath(reference);
    const bytes = safeReadFile(referencePath, { encoding: null }) as Buffer;
    if (bytes.length > GEMINI_REFERENCE_MAX_BYTES) {
      throw new Error(
        `reference image too large for inline upload (${Math.ceil(bytes.length / 1024)}KB > ${GEMINI_REFERENCE_MAX_BYTES / 1024}KB)`
      );
    }
    total += bytes.length;
    if (total > GEMINI_REFERENCE_TOTAL_MAX_BYTES) {
      throw new Error('reference images exceed the inline upload budget');
    }
    parts.push({ inlineData: { mimeType: reference.mimeType, data: bytes.toString('base64') } });
  }
  parts.push({ text: request.prompt });
  return [{ role: 'user', parts }];
}

/** First image part of a `generateContent` response (`candidates[0].content.parts[*].inlineData`). */
export function geminiContentImageBytes(value: unknown): string | undefined {
  let safeValue: Record<string, unknown>;
  try {
    safeValue = parseSafeJsonObjectValue(value, 'Gemini generateContent response');
  } catch {
    return undefined;
  }
  const candidates = Array.isArray(safeValue.candidates) ? safeValue.candidates : [];
  const first = candidates[0];
  if (!isRecord(first) || !isRecord(first.content) || !Array.isArray(first.content.parts)) {
    return undefined;
  }
  for (const part of first.content.parts) {
    if (!isRecord(part)) continue;
    const inline = isRecord(part.inlineData)
      ? part.inlineData
      : isRecord(part.inline_data)
        ? part.inline_data
        : undefined;
    const bytes = inline ? normalizeImageBytes(inline.data) : undefined;
    if (bytes) return bytes;
  }
  return undefined;
}

/**
 * PA-10: Gemini image model through `models/<model>:generateContent`
 * (service preset `gemini.generate_content_image`). Unlike Imagen
 * `generateImages` it accepts reference images as `inlineData` parts, so it
 * can stylise a user photo. Cloud egress: reference requests need consent.
 */
export class GeminiImageModelGenerationProvider implements ImageGenerationProvider {
  readonly id = 'gemini_image';
  readonly displayName = 'Google Gemini API';
  readonly costTier = 'paid';
  readonly dataPolicy = 'training_eligible';
  readonly executionLocality = 'remote';
  readonly dataEgress = 'cloud';
  readonly supportsReferenceImages = true;

  async isAvailable(): Promise<boolean> {
    if (!resolveGeminiApiKey()) return false;
    try {
      resolveServiceBinding('gemini', 'secret-guard');
      return true;
    } catch (_) {
      return false;
    }
  }

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const startedAt = Date.now();
    // Consent is checked before any byte of a reference is read.
    assertReferenceEgressAllowed(request, this);
    try {
      const response = await executeServicePreset(
        'gemini',
        'generate_content_image',
        {
          model: resolveGeminiImageModel(),
          contents: buildGeminiImageContents(request),
          generation_config: {
            responseModalities: ['IMAGE'],
            imageConfig: { aspectRatio: request.aspectRatio || '1:1' },
          },
        },
        'secret-guard'
      );
      const imageBytes = geminiContentImageBytes(response);
      if (!imageBytes) throw new Error('Gemini image model returned no image bytes');
      const targetPath = getFallbackTargetPath(request);
      const outputDir = path.dirname(targetPath);
      if (!safeExistsSync(outputDir)) safeMkdir(outputDir, { recursive: true });
      safeWriteFile(targetPath, Buffer.from(imageBytes, 'base64'));
      return {
        status: 'succeeded',
        provider: this.id,
        path: targetPath,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error: any) {
      logger.error(`[image_generation_bridge] Gemini image model failed: ${error.message}`);
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
  readonly costTier = 'paid';
  readonly dataPolicy = 'zero_retention';
  readonly executionLocality = 'remote';

  async isAvailable(): Promise<boolean> {
    return Boolean(resolveGeminiApiKey() || getRegisteredEnvText('OPENAI_API_KEY'));
  }

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const startedAt = Date.now();
    const apiKeyGemini = resolveGeminiApiKey();
    const apiKeyOpenAI = getRegisteredEnvText('OPENAI_API_KEY');

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

  private async callGeminiImagen(
    apiKey: string,
    request: ImageGenerationRequest,
    startedAt: number
  ): Promise<ImageGenerationResult> {
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
      outputMimeType: 'image/jpeg',
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`Gemini Imagen API error: ${res.statusText} (${res.status})`);
    }

    const data = (await res.json()) as unknown;
    const base64Bytes = imageBytesFromResponse(data);
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

  private async callOpenAIDallE(
    apiKey: string,
    request: ImageGenerationRequest,
    startedAt: number
  ): Promise<ImageGenerationResult> {
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
      response_format: 'b64_json',
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`OpenAI DALL-E API error: ${res.statusText} (${res.status})`);
    }

    const data = await res.json();
    const base64Bytes = dallEImageBytesFromResponse(data);
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

export class WindowsNativeImageGenerationProvider implements ImageGenerationProvider {
  readonly id = 'windows_native';
  readonly costTier = 'self_hosted';
  readonly dataPolicy = 'local_only';
  readonly executionLocality = 'local';

  async isAvailable(): Promise<boolean> {
    return probeWindowsNativeImageGeneration().available;
  }

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const startedAt = Date.now();
    const outputPath = getFallbackTargetPath(request).replace(/\.[^.]+$/, '.png');
    const generated = generateImageWithWindowsNativeApi({
      prompt: request.prompt,
      outputPath,
      ...(request.width ? { width: request.width } : {}),
      ...(request.height ? { height: request.height } : {}),
    });
    return generated
      ? {
          status: 'succeeded',
          provider: this.id,
          path: generated,
          elapsedMs: Date.now() - startedAt,
        }
      : {
          status: 'failed',
          provider: this.id,
          elapsedMs: Date.now() - startedAt,
          error: 'windows_native_image_generation_unavailable',
        };
  }
}

function getApplePlaygroundTargetPath(request: ImageGenerationRequest): string {
  const targetPath = getFallbackTargetPath(request);
  const extension = path.extname(targetPath);
  if (extension.toLowerCase() === '.png') return targetPath;
  return extension ? `${targetPath.slice(0, -extension.length)}.png` : `${targetPath}.png`;
}

export class ApplePlaygroundImageGenerationProvider implements ImageGenerationProvider {
  readonly id = 'apple_playground';
  readonly costTier = 'self_hosted';
  readonly dataPolicy = 'local_only';
  readonly executionLocality = 'local';

  async isAvailable(): Promise<boolean> {
    return (await probeAppleImageGeneration()).available;
  }

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const startedAt = Date.now();
    const targetPath = getApplePlaygroundTargetPath(request);
    const outputDir = path.dirname(targetPath);
    if (!safeExistsSync(outputDir)) {
      safeMkdir(outputDir, { recursive: true });
    }

    try {
      const generated = await generateImageLocallyWithApplePlayground(request.prompt, targetPath, {
        ...(request.style ? { style: request.style } : {}),
      });
      if (!generated) {
        return {
          status: 'failed',
          provider: this.id,
          elapsedMs: Date.now() - startedAt,
          error: 'apple_playground_generation_unavailable',
        };
      }
      return {
        status: 'succeeded',
        provider: this.id,
        path: generated.path,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error: any) {
      return {
        status: 'failed',
        provider: this.id,
        elapsedMs: Date.now() - startedAt,
        error: error?.message || 'apple_playground_generation_failed',
      };
    }
  }
}

type HostBridgeVariant =
  'host_agent' | 'codex_host_bridge' | 'agy_host_bridge' | 'cursor_host_bridge';

interface HostBridgeProviderConfig {
  id: HostBridgeVariant;
  displayName: string;
  requestFileName: string;
  errorCode: string;
  availability: () => boolean;
}

/** Repo-relative reference entries for a host hand-off (paths only, never bytes). */
export function hostBridgeReferenceEntries(
  request: ImageGenerationRequest
): Array<{ path: string; mimeType: string; role: string }> {
  return (request.referenceImages ?? []).map((reference) => ({
    path: pathResolver.toRepoRelative(resolveReferenceImagePath(reference)),
    mimeType: reference.mimeType,
    role: reference.role ?? 'subject',
  }));
}

function hostBridgeReferenceInstruction(request: ImageGenerationRequest): string {
  const entries = hostBridgeReferenceEntries(request);
  if (entries.length === 0) return '';
  return ` Use these reference image(s) as input images (do not copy them elsewhere): ${entries
    .map((entry) => `"${entry.path}" (${entry.role})`)
    .join(', ')}.`;
}

function writeHostBridgeRequest(
  config: HostBridgeProviderConfig,
  request: ImageGenerationRequest,
  targetPath: string
): void {
  const requestFilePath = assertSafeRepositoryPath(
    pathResolver.resolve(`active/shared/tmp/${config.requestFileName}`),
    { allowMissingLeaf: true }
  );
  const outputDir = path.dirname(requestFilePath);
  if (!safeExistsSync(outputDir)) {
    safeMkdir(outputDir, { recursive: true });
  }

  try {
    safeWriteFile(
      requestFilePath,
      JSON.stringify(
        {
          bridge_provider: config.id,
          bridge_name: config.displayName,
          prompt: request.prompt,
          targetPath,
          aspectRatio: request.aspectRatio || '1:1',
          ...(hasReferenceImages(request)
            ? {
                referenceImages: hostBridgeReferenceEntries(request),
                egressConsent: request.egressConsent
                  ? {
                      provider_id: request.egressConsent.provider_id,
                      granted_at: request.egressConsent.granted_at,
                    }
                  : null,
              }
            : {}),
          timestamp: nowIso(),
        },
        null,
        2
      )
    );
  } catch {
    // Request metadata is best-effort; the bridge still returns the actionable instruction.
  }
}

abstract class BaseHostBridgeImageGenerationProvider implements ImageGenerationProvider {
  abstract readonly id: HostBridgeVariant;
  readonly costTier = 'environment';
  readonly dataPolicy = 'zero_retention';
  readonly executionLocality = 'local';
  readonly requiresInteractiveHandoff = true;
  /** The host agent forwards the request (and any reference photo) to its own model. */
  readonly dataEgress = 'cloud';
  readonly supportsReferenceImages = true;
  protected abstract readonly config: HostBridgeProviderConfig;

  get displayName(): string {
    return this.config.displayName;
  }

  async isAvailable(): Promise<boolean> {
    return this.config.availability();
  }

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const startedAt = Date.now();
    const targetPath = getFallbackTargetPath(request);

    if (safeExistsSync(targetPath)) {
      logger.info(
        `[image_generation_bridge] ${this.config.displayName} image already exists at ${targetPath}. Skipping generation.`
      );
      return {
        status: 'succeeded',
        provider: this.id,
        path: targetPath,
        elapsedMs: Date.now() - startedAt,
      };
    }

    assertReferenceEgressAllowed(request, this);
    writeHostBridgeRequest(this.config, request, targetPath);

    const errMessage = `${this.config.errorCode}: ${this.config.displayName} is required. Please use your 'generate_image' tool with prompt: "${request.prompt}" and save the image to "${targetPath}".${hostBridgeReferenceInstruction(request)} After saving, please rerun the task.`;
    logger.warn(`[image_generation_bridge] ${errMessage}`);
    throw new Error(errMessage);
  }
}

function envFlagEnabled(name: string): boolean {
  return getRegisteredEnvText(name) === 'true';
}

function envAnyEnabled(names: string[]): boolean {
  return names.some((name) => Boolean(getRegisteredEnvText(name)));
}

function envEquals(name: string, expected: string): boolean {
  return getRegisteredEnvText(name) === expected;
}

export class HostAgentImageGenerationProvider extends BaseHostBridgeImageGenerationProvider {
  readonly id = 'host_agent';

  protected readonly config: HostBridgeProviderConfig = {
    id: 'host_agent',
    displayName: 'Host agent bridge',
    requestFileName: 'host_agent_image_request.json',
    errorCode: 'HOST_AGENT_IMAGE_GENERATION_REQUIRED',
    availability: () => envFlagEnabled('KYBERION_HOST_AGENT_ACTIVE'),
  };
}

export class CodexHostBridgeImageGenerationProvider extends BaseHostBridgeImageGenerationProvider {
  readonly id = 'codex_host_bridge';

  protected readonly config: HostBridgeProviderConfig = {
    id: 'codex_host_bridge',
    displayName: 'Codex host bridge',
    requestFileName: 'codex_host_bridge_image_request.json',
    errorCode: 'HOST_BRIDGE_IMAGE_GENERATION_REQUIRED',
    availability: () =>
      envAnyEnabled(['CODEX_CLI', 'CODEX_VERSION']) || envEquals('TERM_PROGRAM', 'codex'),
  };
}

export class AgyHostBridgeImageGenerationProvider extends BaseHostBridgeImageGenerationProvider {
  readonly id = 'agy_host_bridge';

  protected readonly config: HostBridgeProviderConfig = {
    id: 'agy_host_bridge',
    displayName: 'AGY host bridge',
    requestFileName: 'agy_host_bridge_image_request.json',
    errorCode: 'HOST_BRIDGE_IMAGE_GENERATION_REQUIRED',
    availability: () => envAnyEnabled(['AGY_CLI', 'ANTIGRAVITY_CLI']),
  };
}

export class CursorHostBridgeImageGenerationProvider extends BaseHostBridgeImageGenerationProvider {
  readonly id = 'cursor_host_bridge';

  protected readonly config: HostBridgeProviderConfig = {
    id: 'cursor_host_bridge',
    displayName: 'Cursor host bridge',
    requestFileName: 'cursor_host_bridge_image_request.json',
    errorCode: 'HOST_BRIDGE_IMAGE_GENERATION_REQUIRED',
    availability: () =>
      envAnyEnabled(['CURSOR_CLI', 'CURSOR_AGENT', 'KYBERION_CURSOR_CLI_BIN', 'CURSOR_API_KEY']),
  };
}

/** Media backend registry id → image provider id (bridge providers without a record are absent). */
const IMAGE_BACKEND_ID_TO_PROVIDER_ID: Record<string, string> = {
  'media-generation.comfyui': 'comfyui',
  'media-generation.gemini.imagen-3-fast': 'gemini_fast',
  'media-generation.gemini': 'gemini_service',
  'media-generation.host_agent': 'host_agent',
  'media-generation.cursor_host_bridge': 'cursor_host_bridge',
  'media-generation.local_flux': 'local_flux',
  'media-generation.apple_playground': 'apple_playground',
};

/**
 * The media backend registry id of an image provider (the id a generation
 * result reports), or undefined for providers without a registry record.
 */
export function imageGenerationBackendIdForProvider(providerId: string): string | undefined {
  return Object.entries(IMAGE_BACKEND_ID_TO_PROVIDER_ID).find(([, id]) => id === providerId)?.[0];
}

/** Request facts operator rules may match on (e.g. `{ mode: 'fast' }`). */
function imageSelectionContext(request: ImageGenerationRequest): Record<string, string> {
  const context: Record<string, string> = {};
  if (request.mode) context.mode = request.mode;
  const aspectRatio = request.aspectRatio?.trim();
  if (aspectRatio) context.aspect_ratio = aspectRatio;
  return context;
}

export class AdaptivePolicyRouter {
  private providers: Map<string, ImageGenerationProvider> = new Map();
  private fallbackGraph: Map<string, string> = new Map();

  constructor(providers: ImageGenerationProvider[]) {
    for (const p of providers) {
      this.providers.set(p.id, p);
    }
    this.initFallbackGraph();
  }

  private initFallbackGraph(): void {
    try {
      const registry = getMediaBackendRegistry();
      const backends = registry.backends.filter((b) => b.modality === 'image');
      const aliasToProviderId = IMAGE_BACKEND_ID_TO_PROVIDER_ID;
      for (const b of backends) {
        if (b.fallback_backend_id) {
          const fromId = aliasToProviderId[b.backend_id] || b.backend_id;
          const toId = aliasToProviderId[b.fallback_backend_id] || b.fallback_backend_id;
          this.fallbackGraph.set(fromId, toId);
        }
      }
    } catch (_) {
      // Ignore registry loading issues in unit tests with mocked environments
    }
  }

  /** Why the request's mode forbids this provider (hard constraint), or null. */
  private modeViolation(
    request: ImageGenerationRequest,
    provider: ImageGenerationProvider
  ): string | null {
    if (
      (request.mode === 'privacy_first' || request.mode === 'local_only') &&
      provider.dataPolicy === 'training_eligible'
    ) {
      return `mode ${request.mode} excludes training_eligible data policy`;
    }
    if (request.mode === 'local_only' && provider.executionLocality !== 'local') {
      return `mode local_only excludes ${provider.executionLocality ?? 'unknown'} execution`;
    }
    return null;
  }

  /**
   * Every hard constraint: the mode's filters, then PA-10 reference-image
   * rules (reference support; cloud egress needs a consent naming the provider).
   */
  private hardViolation(
    request: ImageGenerationRequest,
    provider: ImageGenerationProvider,
    options: { ignoreConsent?: boolean } = {}
  ): string | null {
    return (
      this.modeViolation(request, provider) ?? referenceImageViolation(request, provider, options)
    );
  }

  /**
   * Eligibility of every registered provider for this request: the mode's
   * hard constraints, availability and (unless allowed) interactive hand-off.
   */
  private async selectionCandidates(
    request: ImageGenerationRequest,
    allowHostHandoff: boolean
  ): Promise<SeamProviderCandidate[]> {
    const candidates: SeamProviderCandidate[] = [];
    for (const provider of this.providers.values()) {
      const unmet: string[] = [];
      const violation = this.hardViolation(request, provider);
      if (violation) unmet.push(violation);
      if (provider.requiresInteractiveHandoff && !allowHostHandoff) {
        unmet.push('interactive host hand-off not allowed (allow_host_handoff)');
      }
      if (unmet.length === 0 && !(await provider.isAvailable())) unmet.push('unavailable');
      candidates.push({ id: provider.id, eligible: unmet.length === 0, unmet });
    }
    return candidates;
  }

  /** Candidates with eligibility for this request (hand-off only when allowed); for calibration. */
  async listCandidates(request: ImageGenerationRequest): Promise<SeamProviderCandidate[]> {
    return this.selectionCandidates(request, request.allowHostHandoff === true);
  }

  /**
   * Purpose-driven chain: every registered provider is filtered by the mode's
   * hard constraints, availability and (unless allowed) interactive hand-off;
   * the eligible ones are ranked by the governed seam policy. The decision is
   * audited and pinned per mission under the purpose.
   */
  private async resolvePurposeChain(
    request: ImageGenerationRequest,
    purpose: string
  ): Promise<ImageGenerationProvider[]> {
    const known = listSeamSelectionPurposes(IMAGE_GENERATION_PROVIDER_SEAM);
    if (!known.includes(purpose)) {
      throw new Error(
        `[IMAGE_GENERATION_SELECTION] unknown purpose '${purpose}' for seam '${IMAGE_GENERATION_PROVIDER_SEAM}' (known: ${known.join(', ')})`
      );
    }
    const candidates = await this.selectionCandidates(request, request.allowHostHandoff === true);
    const decision = resolveSeamProviderDecision({
      seam: IMAGE_GENERATION_PROVIDER_SEAM,
      candidates,
      purpose,
      context: imageSelectionContext(request),
      decisionKey: purpose,
    });
    if (!decision.provider_id) {
      throw new Error(`[IMAGE_GENERATION_SELECTION] ${decision.rationale}`);
    }
    logger.info(
      `[image_generation_bridge] provider '${decision.provider_id}' selected (${decision.strategy}): ${decision.rationale}`
    );
    return decision.ranked.map((id) => this.providers.get(id)!);
  }

  /**
   * Without a purpose, an operator rule matching this request picks the
   * provider that leads the mode chain (a mission pin it produced is reused).
   * A request no rule matches keeps the mode chain unchanged — nothing is
   * recorded or pinned for it. Hand-off providers stay eligible, as in the
   * mode chain.
   */
  private async resolveOperatorRuleLead(request: ImageGenerationRequest): Promise<string[]> {
    const context = imageSelectionContext(request);
    if (!matchSeamSelectionRule(IMAGE_GENERATION_PROVIDER_SEAM, { context })) return [];
    const options: ResolveSeamProviderOptions = {
      seam: IMAGE_GENERATION_PROVIDER_SEAM,
      candidates: await this.selectionCandidates(request, request.allowHostHandoff === true),
      context,
      decisionKey: 'default',
    };
    // A matching rule whose providers are all ineligible keeps the mode chain.
    const preview = explainSeamProviderDecision(options);
    if (preview.strategy !== 'rule' && preview.strategy !== 'pinned') return [];
    const decision = resolveSeamProviderDecision(options);
    if (!decision.provider_id) return [];
    logger.info(
      `[image_generation_bridge] provider '${decision.provider_id}' leads the ${request.mode || 'balanced'} chain (${decision.strategy}): ${decision.rationale}`
    );
    return [decision.provider_id];
  }

  async resolveCandidateChain(
    request: ImageGenerationRequest,
    options: { ignoreConsent?: boolean } = {}
  ): Promise<ImageGenerationProvider[]> {
    const purpose = request.purpose?.trim();
    const hasPreference = Boolean(request.providerPreference && request.providerPreference.length);
    if (purpose && !hasPreference) {
      return await this.resolvePurposeChain(request, purpose);
    }
    const ruleLead = hasPreference ? [] : await this.resolveOperatorRuleLead(request);
    const candidates: ImageGenerationProvider[] = [];
    const seenIds = new Set<string>();

    const addIfAvailableAndCompliant = async (provider: ImageGenerationProvider | undefined) => {
      if (!provider || seenIds.has(provider.id)) return;
      if (this.hardViolation(request, provider, options)) return;
      if (await provider.isAvailable()) {
        candidates.push(provider);
        seenIds.add(provider.id);
      }
    };

    for (const id of [...ruleLead, ...(request.providerPreference ?? [])]) {
      await addIfAvailableAndCompliant(this.providers.get(id));
    }

    const mode = request.mode || 'balanced';

    let defaultChain: string[] = [];
    if (mode === 'local_only' || mode === 'privacy_first') {
      defaultChain = [
        'apple_playground',
        'windows_native',
        'local_flux',
        'local_diffusion',
        'comfyui',
      ];
    } else if (mode === 'fast') {
      defaultChain = [
        'gemini_fast',
        'gemini_service',
        'gemini_image',
        'apple_playground',
        'windows_native',
        'local_flux',
        'comfyui',
        'llm_api',
        'cursor_host_bridge',
        'host_agent',
      ];
    } else if (mode === 'artistic') {
      defaultChain = [
        'cursor_host_bridge',
        'codex_host_bridge',
        'agy_host_bridge',
        'host_agent',
        'apple_playground',
        'windows_native',
        'gemini_service',
        'gemini_fast',
        'gemini_image',
        'llm_api',
        'local_flux',
        'comfyui',
      ];
    } else {
      // balanced
      defaultChain = [
        'cursor_host_bridge',
        'codex_host_bridge',
        'agy_host_bridge',
        'host_agent',
        'apple_playground',
        'windows_native',
        'local_flux',
        'comfyui',
        'gemini_fast',
        'gemini_service',
        'gemini_image',
        'llm_api',
      ];
    }

    for (const id of defaultChain) {
      await addIfAvailableAndCompliant(this.providers.get(id));
    }

    // Follow governed fallback_backend_id chains for any selected candidates
    const visited = new Set<string>(seenIds);
    for (const c of [...candidates]) {
      let curr = c.id;
      while (this.fallbackGraph.has(curr)) {
        const nextId = this.fallbackGraph.get(curr)!;
        if (visited.has(nextId)) break;
        visited.add(nextId);
        await addIfAvailableAndCompliant(this.providers.get(nextId));
        curr = nextId;
      }
    }

    return candidates;
  }

  async selectProvider(request: ImageGenerationRequest): Promise<ImageGenerationProvider> {
    const chain = await this.resolveCandidateChain(request);
    if (chain.length > 0) {
      return chain[0];
    }
    throw new Error('No available Image Generation provider could be resolved.');
  }

  /**
   * PA-10: the provider a request would reach once any required consent is
   * given — for consent prompts that must name the provider before anything
   * is sent. Mode filters, reference support and availability still apply.
   */
  async planProvider(request: ImageGenerationRequest): Promise<ImageGenerationProvider | null> {
    const chain = await this.resolveCandidateChain(request, { ignoreConsent: true });
    return chain[0] ?? null;
  }

  async generateWithFallback(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const candidates = await this.resolveCandidateChain(request);
    if (candidates.length === 0) {
      if (hasReferenceImages(request)) {
        const blocked = (await this.resolveCandidateChain(request, { ignoreConsent: true }))[0];
        if (blocked) {
          recordReferenceEgressReceipt(
            request,
            blocked,
            'denied',
            referenceImageViolation(request, blocked) ?? undefined
          );
          throw new Error(
            `[IMAGE_REFERENCE_EGRESS_DENIED] ${blocked.id} would receive the reference image(s) but no valid user_photo consent names it.`
          );
        }
        throw new Error(
          'No available Image Generation provider can honour reference images for this request.'
        );
      }
      throw new Error('No available Image Generation provider could be resolved.');
    }

    let lastError: unknown = null;

    for (let i = 0; i < candidates.length; i++) {
      const provider = candidates[i];
      try {
        logger.info(
          `[image_generation_bridge] Routing generation request to provider: ${provider.id}`
        );
        if (hasReferenceImages(request)) {
          // Re-checked at dispatch (a consent can expire between routing and
          // the call); the receipt precedes any egress.
          assertReferenceEgressAllowed(request, provider);
          recordReferenceEgressReceipt(request, provider, 'allowed');
        }
        const result = await provider.generate(request);
        if (result.status === 'failed' && isRateLimitOrQuotaError(result.error)) {
          logger.warn(
            `[image_generation_bridge] Provider ${provider.id} encountered rate limit / quota error: ${result.error}. Attempting fallback.`
          );
          lastError = new Error(result.error);
          continue;
        }
        return result;
      } catch (err: any) {
        lastError = err;
        if (isRateLimitOrQuotaError(err)) {
          logger.warn(
            `[image_generation_bridge] Provider ${provider.id} threw rate limit / quota error: ${err?.message || err}. Attempting fallback.`
          );
          continue;
        }
        throw err;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError || 'All image generation providers failed.'));
  }
}

function ensureBuiltinImageGenerationProviders(): void {
  if (imageGenerationBuiltinsRegistered && listImageGenerationProviders().length > 0) return;
  for (const provider of [
    new ComfyUiImageGenerationProvider(),
    new GeminiFastImageGenerationProvider(),
    new GeminiServiceImageGenerationProvider(),
    new GeminiImageModelGenerationProvider(),
    new LlmApiImageGenerationProvider(),
    new LocalFluxImageGenerationProvider(),
    new WindowsNativeImageGenerationProvider(),
    new LocalDiffusionImageGenerationProvider(),
    new ApplePlaygroundImageGenerationProvider(),
    new CursorHostBridgeImageGenerationProvider(),
    new CodexHostBridgeImageGenerationProvider(),
    new AgyHostBridgeImageGenerationProvider(),
    new HostAgentImageGenerationProvider(),
  ]) {
    registerImageGenerationProvider(provider);
  }
  imageGenerationBuiltinsRegistered = true;
}

function getRouter(): AdaptivePolicyRouter {
  ensureBuiltinImageGenerationProviders();
  if (!imageGenerationGlobalRouter) {
    imageGenerationGlobalRouter = new AdaptivePolicyRouter(listImageGenerationProviders());
  }
  return imageGenerationGlobalRouter;
}

/** A registered image provider by id (built-ins included), e.g. to run one provider in isolation. */
export function getImageGenerationProvider(id: string): ImageGenerationProvider | undefined {
  ensureBuiltinImageGenerationProviders();
  return listImageGenerationProviders().find((provider) => provider.id === id);
}

/**
 * Every registered image provider with whether it can run this request
 * unattended here and now (mode filters, availability, hand-off opt-in).
 */
export async function listImageGenerationCandidates(
  request: ImageGenerationRequest
): Promise<SeamProviderCandidate[]> {
  return await getRouter().listCandidates(request);
}

export interface ImageGenerationPlan {
  provider_id: string;
  display_name: string;
  data_egress: 'local' | 'cloud';
  /** A cloud provider with references needs a per-run user_photo consent. */
  requires_consent: boolean;
  /** Host bridges hand the request to the host agent and need a rerun. */
  interactive_handoff: boolean;
}

/** Which provider this request would use (consent not yet given), or null. */
export async function planImageGeneration(
  request: ImageGenerationRequest
): Promise<ImageGenerationPlan | null> {
  const provider = await getRouter().planProvider(request);
  if (!provider) return null;
  const egress = imageProviderDataEgress(provider);
  return {
    provider_id: provider.id,
    display_name: provider.displayName || provider.id,
    data_egress: egress,
    requires_consent: egress === 'cloud' && hasReferenceImages(request),
    interactive_handoff: provider.requiresInteractiveHandoff === true,
  };
}

export async function generateImage(
  request: ImageGenerationRequest
): Promise<ImageGenerationResult> {
  const router = getRouter();
  return await router.generateWithFallback(request);
}
