import * as path from 'node:path';
import { logger } from '../../../core.js';
import { getRegisteredEnvText } from '../../../foundation/env.js';
import { isRecord } from '../../../foundation/text.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeWriteFile } from '../../../secure-io.js';
import { executeServicePreset } from '../../../service/service-engine.js';
import { resolveServiceBinding } from '../../../service/service-binding.js';
import { parseSafeJsonObjectValue } from '../../../foundation/safe-json.js';
import {
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageGenerationProvider,
} from '../../image-generation-types.js';
import {
  assertReferenceEgressAllowed,
  resolveReferenceImagePath,
} from '../../image-reference-consent.js';
import { resolveGeminiApiKey } from '../../../provider/gemini-api-backend.js';
import { resolveRuntimeModelId } from '../../../tool/runtime-model-defaults.js';
import { imageReferenceSnapshots, governImageProvider } from '../admission.js';
import {
  getFallbackTargetPath,
  imageBytesFromResponse,
  normalizeImageBytes,
} from '../provider-support.js';

export class GeminiFastImageGenerationProvider implements ImageGenerationProvider {
  constructor() {
    this.generate = governImageProvider(this).generate;
  }
  readonly id = 'gemini_fast';
  readonly backendIds = ['media-generation.gemini.imagen-3-fast'];
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
  constructor() {
    this.generate = governImageProvider(this).generate;
  }
  readonly id = 'gemini_service';
  readonly backendIds = ['media-generation.gemini'];
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

/**
 * Default Gemini image model for reference-conditioned generation (PA-10):
 * provider-config.json runtime_defaults['gemini-image'] (RS-02).
 */
export function defaultGeminiImageModel(): string {
  return resolveRuntimeModelId('gemini-image');
}

/** Keeps the inline-data request under the network guardrail (2 MB by default). */
const GEMINI_REFERENCE_MAX_BYTES = 1024 * 1024;

const GEMINI_REFERENCE_TOTAL_MAX_BYTES = 1400 * 1024;

/** References are downscaled to this longest side before upload (PA-10). */
export const GEMINI_REFERENCE_MAX_EDGE_PX = 768;

/** [longest side, JPEG quality] tried in order; the first encoding under budget wins. */
const GEMINI_REFERENCE_ENCODE_STEPS: ReadonlyArray<[number, number]> = [
  [GEMINI_REFERENCE_MAX_EDGE_PX, 85],
  [GEMINI_REFERENCE_MAX_EDGE_PX, 70],
  [640, 60],
  [512, 50],
];

/** A source larger than this is refused before decoding (concierge uploads cap at 8 MB). */
const GEMINI_REFERENCE_SOURCE_MAX_BYTES = 16 * 1024 * 1024;

export function resolveGeminiImageModel(): string {
  const configured = getRegisteredEnvText('KYBERION_GEMINI_IMAGE_MODEL')?.trim();
  if (!configured) return defaultGeminiImageModel();
  if (!/^[a-z0-9][a-z0-9.-]{0,79}$/u.test(configured)) {
    throw new Error(`KYBERION_GEMINI_IMAGE_MODEL is not a valid model id: ${configured}`);
  }
  return configured;
}

/**
 * PA-10: a reference photo (up to 8 MB from the concierge upload) or a
 * generated 1024² PNG frame is re-encoded in memory — longest side at most
 * {@link GEMINI_REFERENCE_MAX_EDGE_PX}, JPEG q85 — so a whole set fits the
 * inline upload budget (a very detailed source steps down in quality and
 * size until it fits `targetBytes`). Re-encoding also drops EXIF metadata.
 * Nothing is written to disk. A source Jimp cannot decode (e.g. WebP) is sent
 * as is when it already fits the budget.
 */
export async function prepareGeminiReferenceImage(
  bytes: Buffer,
  mimeType: string,
  targetBytes: number = GEMINI_REFERENCE_MAX_BYTES
): Promise<{ mimeType: string; bytes: Buffer }> {
  if (bytes.length > GEMINI_REFERENCE_SOURCE_MAX_BYTES) {
    throw new Error(
      `reference image too large for inline upload (${Math.ceil(bytes.length / 1024)}KB source)`
    );
  }
  const budget = Math.min(targetBytes, GEMINI_REFERENCE_MAX_BYTES);
  let encode: ((edge: number, quality: number) => Promise<Buffer>) | null = null;
  try {
    const { Jimp } = await import('jimp');
    const decoded = await Jimp.read(bytes);
    encode = async (edge, quality) => {
      const image = decoded.clone();
      if (image.bitmap.width > edge || image.bitmap.height > edge) {
        image.scaleToFit({ w: edge, h: edge });
      }
      return Buffer.from(await image.getBuffer('image/jpeg', { quality }));
    };
  } catch {
    encode = null;
  }
  if (!encode) {
    if (bytes.length > budget) {
      throw new Error(
        `reference image too large for inline upload (${Math.ceil(bytes.length / 1024)}KB > ${Math.floor(budget / 1024)}KB)`
      );
    }
    return { mimeType, bytes };
  }
  // Highly detailed sources step down in quality / size until they fit.
  for (const [edge, quality] of GEMINI_REFERENCE_ENCODE_STEPS) {
    const encoded = await encode(edge, quality);
    if (encoded.length <= budget) return { mimeType: 'image/jpeg', bytes: encoded };
  }
  throw new Error(
    `reference image too large for inline upload even after downscaling (> ${Math.floor(budget / 1024)}KB)`
  );
}

/** `generateContent` contents: every reference as `inlineData`, then the text prompt. */
export async function buildGeminiImageContents(request: ImageGenerationRequest): Promise<
  Array<{
    role: 'user';
    parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }>;
  }>
> {
  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
  let total = 0;
  const references = request.referenceImages ?? [];
  for (const [index, reference] of references.entries()) {
    const referencePath = resolveReferenceImagePath(reference);
    const source =
      imageReferenceSnapshots.get(request)?.get(referencePath) ??
      (safeReadFile(referencePath, { encoding: null }) as Buffer);
    // Each reference gets an equal share of what is left of the total budget.
    const remaining = references.length - index;
    const share = Math.floor((GEMINI_REFERENCE_TOTAL_MAX_BYTES - total) / remaining);
    const prepared = await prepareGeminiReferenceImage(source, reference.mimeType, share);
    total += prepared.bytes.length;
    if (total > GEMINI_REFERENCE_TOTAL_MAX_BYTES) {
      throw new Error('reference images exceed the inline upload budget');
    }
    parts.push({
      inlineData: { mimeType: prepared.mimeType, data: prepared.bytes.toString('base64') },
    });
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
  constructor() {
    this.generate = governImageProvider(this).generate;
  }
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
          contents: await buildGeminiImageContents(request),
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
