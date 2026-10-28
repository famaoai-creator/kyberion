import path from 'node:path';
import { appleFmPromptWithImage, gateAppleLane } from '../apple-intelligence-bridge.js';
import {
  probeWindowsNativeImageRecognition,
  describeImageWithWindowsNativeApi,
} from '../windows-native-image-recognition-bridge.js';
import {
  ImageDescriptionProvider,
  ImageDescriptionRequest,
  ImageDescriptionResult,
} from './image-description-types.js';
import { pathResolver } from '../path-resolver.js';
import { secureFetch } from '../network.js';
import { safeReadFile, assertSafeRepositoryPath, validateFileSize } from '../secure-io.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import {
  resolveRuntimeDefaultModelId,
  resolveRuntimeEndpoint,
} from '../provider/provider-config.js';
import { isRecord } from '../foundation/text.js';
import {
  withReasoningPayloadScope,
  type ReasoningPayloadScope,
} from '../reasoning/reasoning-egress-scope.js';
import type {
  ReasoningBackend,
  ReasoningImageAttachment,
} from '../reasoning/reasoning-backend-contracts.js';

export class WindowsNativeImageDescriptionProvider implements ImageDescriptionProvider {
  readonly id = 'windows_native';

  async isAvailable(): Promise<boolean> {
    return probeWindowsNativeImageRecognition().description;
  }

  async describe(request: ImageDescriptionRequest): Promise<ImageDescriptionResult> {
    const startedAt = Date.now();
    const description = describeImageWithWindowsNativeApi(request.path);
    return description
      ? { status: 'succeeded', provider: this.id, description, elapsedMs: Date.now() - startedAt }
      : {
          status: 'failed',
          provider: this.id,
          description: '',
          error: 'windows_native_image_description_failed',
          elapsedMs: Date.now() - startedAt,
        };
  }
}

/** Experimental, explicitly selected Apple captioning. Availability does not establish visual accuracy. */
export class AppleNativeImageDescriptionProvider implements ImageDescriptionProvider {
  readonly id = 'apple_native';

  constructor(private readonly options: ReasoningVisionOptions = {}) {}

  async isAvailable(): Promise<boolean> {
    return (await gateAppleLane('multimodal')).available;
  }

  /** Policy and preparation errors propagate; only a native inference failure returns null. */
  async describeWithPrompt(imagePath: string, prompt: string): Promise<string | null> {
    const absolutePath = assertSafeRepositoryPath(pathResolver.rootResolve(imagePath));
    // The native bridge deliberately degrades failures to null. Authorize first so
    // denied input cannot be mistaken for an inference failure and sent elsewhere.
    validateFileSize(absolutePath, 512);
    const tier = effectiveTier(absolutePath, this.options.tier);
    const prepared = this.options.prepare_egress_image
      ? await this.options.prepare_egress_image(absolutePath)
      : undefined;
    try {
      const inputPath = prepared
        ? assertSafeRepositoryPath(pathResolver.rootResolve(prepared.path))
        : absolutePath;
      validateFileSize(inputPath, 512);
      const description = await withReasoningPayloadScope(
        {
          tier: effectiveTier(inputPath, tier),
          ...(this.options.tenant_slug ? { tenant_slug: this.options.tenant_slug } : {}),
          purpose: 'image description',
          attachment_count: 1,
        },
        () => appleFmPromptWithImage(prompt, inputPath)
      );
      // Recheck after the native await before allowing an inference-only fallback.
      if (description === null) {
        validateFileSize(absolutePath, 512);
        validateFileSize(inputPath, 512);
      }
      return description?.trim() || null;
    } finally {
      prepared?.dispose();
    }
  }

  async describe(request: ImageDescriptionRequest): Promise<ImageDescriptionResult> {
    const startedAt = Date.now();
    const description = await this.describeWithPrompt(
      request.path,
      imageDescriptionPrompt(request.kind)
    );
    return description
      ? { status: 'succeeded', provider: this.id, description, elapsedMs: Date.now() - startedAt }
      : {
          status: 'failed',
          provider: this.id,
          description: '',
          error: 'apple_native_image_description_failed',
          elapsedMs: Date.now() - startedAt,
        };
  }
}

/** Local Ollama vision provider for image captions; only loopback endpoints are eligible. */
export class OllamaVisionImageDescriptionProvider implements ImageDescriptionProvider {
  readonly id = 'ollama_vision';
  private readonly endpoint: string;
  private readonly model: string;
  private readonly explicitlyConfigured: boolean;

  constructor(
    endpoint = getRegisteredEnvText('OLLAMA_HOST') || resolveRuntimeEndpoint('ollama'),
    model = getRegisteredEnvText('OLLAMA_VLM_MODEL') ||
      resolveRuntimeDefaultModelId('ollama-vision'),
    private readonly visionOptions: ReasoningVisionOptions = {}
  ) {
    this.endpoint = endpoint.replace(/\/$/u, '');
    const configured = getRegisteredEnvText('OLLAMA_VLM_MODEL');
    this.explicitlyConfigured = Boolean(configured);
    this.model = configured || model;
  }

  private isLoopback(): boolean {
    try {
      const host = new URL(this.endpoint).hostname.toLowerCase().replace(/^\[|\]$/gu, '');
      return ['localhost', '127.0.0.1', '::1'].includes(host);
    } catch {
      return false;
    }
  }

  async isAvailable(): Promise<boolean> {
    if (!this.explicitlyConfigured || !this.isLoopback()) return false;
    try {
      const response = await secureFetch<unknown>({
        method: 'GET',
        url: `${this.endpoint}/api/tags`,
        timeout: 1_500,
        kyberion_allow_local_network: true,
      });
      const models = isRecord(response) && Array.isArray(response.models) ? response.models : [];
      return models.some(
        (entry) => isRecord(entry) && typeof entry.name === 'string' && entry.name === this.model
      );
    } catch {
      return false;
    }
  }

  async describe(request: ImageDescriptionRequest): Promise<ImageDescriptionResult> {
    const startedAt = Date.now();
    if (!this.isLoopback()) {
      return {
        status: 'failed',
        provider: this.id,
        description: '',
        error: 'ollama_vision_requires_loopback_endpoint',
        elapsedMs: Date.now() - startedAt,
      };
    }
    const absolutePath = assertSafeRepositoryPath(pathResolver.rootResolve(request.path));
    const image = safeReadFile(absolutePath, { encoding: null }) as Buffer;
    const response = await withReasoningPayloadScope(
      {
        tier: effectiveTier(absolutePath, this.visionOptions.tier),
        ...(this.visionOptions.tenant_slug ? { tenant_slug: this.visionOptions.tenant_slug } : {}),
        purpose: 'image description',
        attachment_count: 1,
      },
      () =>
        secureFetch<unknown>({
          method: 'POST',
          url: `${this.endpoint}/api/generate`,
          headers: { 'Content-Type': 'application/json' },
          timeout: 300_000,
          kyberion_allow_local_network: true,
          data: {
            model: this.model,
            prompt: imageDescriptionPrompt(request.kind),
            images: [image.toString('base64')],
            think: false,
            stream: false,
            options: { temperature: 0, num_ctx: 8_192, num_predict: 512 },
          },
        })
    );
    const description =
      isRecord(response) && typeof response.response === 'string' ? response.response.trim() : '';
    return description
      ? { status: 'succeeded', provider: this.id, description, elapsedMs: Date.now() - startedAt }
      : {
          status: 'failed',
          provider: this.id,
          description: '',
          error: 'ollama_vision_empty_description',
          elapsedMs: Date.now() - startedAt,
        };
  }
}

export type ImageDescriptionUnavailableCode =
  'VISION_BACKEND_TEXT_ONLY' | 'NO_IMAGE_DESCRIPTION_PROVIDER';

/** Raised when no provider can actually look at the image — never degraded to a text prompt. */
export class ImageDescriptionUnavailableError extends Error {
  readonly code: ImageDescriptionUnavailableCode;

  constructor(code: ImageDescriptionUnavailableCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'ImageDescriptionUnavailableError';
    this.code = code;
  }
}

export type PayloadTier = ReasoningPayloadScope['tier'];
export type ReasoningBackendResolver = () => ReasoningBackend | Promise<ReasoningBackend>;

/** An image copy that is safe to send off-machine, removed by dispose(). */
export interface EgressImage {
  path: string;
  dispose: () => void;
}

export interface ReasoningVisionOptions {
  /** Declared tier of the image; raised (never lowered) to the tier implied by its path. */
  tier?: PayloadTier;
  tenant_slug?: string;
  /**
   * Turns the image into the copy that actually leaves the machine (e.g. a
   * screen-redacted PNG). Runs after the vision channel is confirmed; a
   * failure means nothing is sent.
   */
  prepare_egress_image?: (absolutePath: string) => Promise<EgressImage>;
  /** Defaults to the active reasoning backend. Injected in tests. */
  resolveBackend?: ReasoningBackendResolver;
}

import { KNOWLEDGE_TIER_RANK as TIER_RANK } from '../foundation/knowledge-tier.js';

/** Tier implied by where the image lives under the project root. */
export function inferImagePayloadTier(absolutePath: string): PayloadTier {
  const relative = path.relative(pathResolver.rootDir(), absolutePath).replace(/\\/g, '/');
  const segments = relative.split('/');
  if (segments.includes('personal')) return 'personal';
  if (segments.includes('confidential')) return 'confidential';
  return 'public';
}

function effectiveTier(absolutePath: string, declared?: PayloadTier): PayloadTier {
  const inferred = inferImagePayloadTier(absolutePath);
  if (!declared) return inferred;
  return TIER_RANK[declared] >= TIER_RANK[inferred] ? declared : inferred;
}

const MEDIA_TYPES: Record<string, ReasoningImageAttachment['media_type']> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

const KIND_PROMPTS: Record<NonNullable<ImageDescriptionRequest['kind']>, string> = {
  brief: 'Describe this image in one or two sentences.',
  detailed:
    'Describe this image in detail: the main subjects, visible text, layout, and any notable state.',
  diagram:
    'This image is a diagram. Describe its components, how they connect, and what the diagram conveys.',
  accessible:
    'Write alt text for this image for a screen-reader user: concise, factual, including any visible text.',
};

export function imageDescriptionPrompt(kind: ImageDescriptionRequest['kind']): string {
  return `${KIND_PROMPTS[kind ?? 'brief']} Reply with the description only.`;
}

async function defaultBackendResolver(): Promise<ReasoningBackend> {
  // Loaded lazily so this bridge does not pull the reasoning runtime into
  // every importer's module graph.
  const { getReasoningBackend } = await import('../reasoning/reasoning-backend.js');
  return getReasoningBackend();
}

function supportsVision(backend: ReasoningBackend): boolean {
  return backend.supportsVision !== false && typeof backend.promptWithImages === 'function';
}

/**
 * Describes an image through the active reasoning backend's vision channel.
 * Available on every platform where the configured backend can see images;
 * a text-only backend is reported unavailable rather than asked to guess.
 */
export class ReasoningVisionImageDescriptionProvider implements ImageDescriptionProvider {
  readonly id = 'reasoning_vision';
  private readonly resolveBackend: ReasoningBackendResolver;

  constructor(private readonly options: ReasoningVisionOptions = {}) {
    this.resolveBackend = options.resolveBackend ?? defaultBackendResolver;
  }

  async isAvailable(): Promise<boolean> {
    return supportsVision(await this.resolveBackend());
  }

  /** Throws ImageDescriptionUnavailableError when the backend is text-only. */
  async describeWithPrompt(imagePath: string, prompt: string): Promise<string> {
    const backend = await this.resolveBackend();
    if (!supportsVision(backend)) {
      throw new ImageDescriptionUnavailableError(
        'VISION_BACKEND_TEXT_ONLY',
        `reasoning backend "${backend.name}" has no vision channel; the image was not described`
      );
    }
    const absolutePath = pathResolver.rootResolve(imagePath);
    const mediaType = MEDIA_TYPES[path.extname(absolutePath).toLowerCase()];
    if (!mediaType) {
      throw new Error(
        `[VISION_UNSUPPORTED_MEDIA_TYPE] cannot attach ${path.extname(absolutePath) || 'extensionless'} images`
      );
    }
    const tier = effectiveTier(absolutePath, this.options.tier);
    const prepared = this.options.prepare_egress_image
      ? await this.options.prepare_egress_image(absolutePath)
      : undefined;
    try {
      const attachment = prepared
        ? {
            path: prepared.path,
            media_type: MEDIA_TYPES[path.extname(prepared.path).toLowerCase()],
          }
        : { path: absolutePath, media_type: mediaType };
      if (!attachment.media_type) {
        throw new Error('[VISION_UNSUPPORTED_MEDIA_TYPE] prepared egress image has no image type');
      }
      const reply = await withReasoningPayloadScope(
        {
          tier: prepared ? effectiveTier(prepared.path, tier) : tier,
          ...(this.options.tenant_slug ? { tenant_slug: this.options.tenant_slug } : {}),
          purpose: 'image description',
          attachment_count: 1,
        },
        () =>
          backend.promptWithImages!(prompt, [
            { path: attachment.path, media_type: attachment.media_type },
          ])
      );
      return reply.trim();
    } finally {
      prepared?.dispose();
    }
  }

  async describe(request: ImageDescriptionRequest): Promise<ImageDescriptionResult> {
    const startedAt = Date.now();
    try {
      const description = await this.describeWithPrompt(
        request.path,
        imageDescriptionPrompt(request.kind)
      );
      if (!description) {
        return {
          status: 'failed',
          provider: this.id,
          description: '',
          error: 'reasoning_vision_empty_description',
          elapsedMs: Date.now() - startedAt,
        };
      }
      return {
        status: 'succeeded',
        provider: this.id,
        description,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error) {
      if (error instanceof ImageDescriptionUnavailableError) throw error;
      return {
        status: 'failed',
        provider: this.id,
        description: '',
        error: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - startedAt,
      };
    }
  }
}

export interface DescribeImageOptions extends ReasoningVisionOptions {
  /** Override the provider chain (tests). */
  providers?: ImageDescriptionProvider[];
}

export async function describeImage(
  request: ImageDescriptionRequest,
  options: DescribeImageOptions = {}
): Promise<ImageDescriptionResult> {
  if (!options.providers) {
    const original = assertSafeRepositoryPath(pathResolver.rootResolve(request.path));
    validateFileSize(original, 512);
  }
  const providers = options.providers ?? [
    new WindowsNativeImageDescriptionProvider(),
    new OllamaVisionImageDescriptionProvider(undefined, undefined, options),
    new ReasoningVisionImageDescriptionProvider(options),
  ];
  for (const provider of providers) {
    if (await provider.isAvailable()) return provider.describe(request);
  }
  throw new ImageDescriptionUnavailableError(
    'NO_IMAGE_DESCRIPTION_PROVIDER',
    'No available image description provider could be resolved (no native describer and the reasoning backend has no vision channel).'
  );
}

/** Describes one image file and returns the text; throws on any failure. */
export type DescribeFn = (request: {
  path: string;
  kind?: ImageDescriptionRequest['kind'];
  prompt?: string;
}) => Promise<string>;

/** Default DescribeFn: the reasoning backend's vision channel under a payload scope. */
export function createReasoningVisionDescribeFn(options: ReasoningVisionOptions = {}): DescribeFn {
  const provider = new ReasoningVisionImageDescriptionProvider(options);
  return async (request) => {
    const description = await provider.describeWithPrompt(
      request.path,
      request.prompt ?? imageDescriptionPrompt(request.kind)
    );
    if (!description) {
      throw new Error('[VISION_EMPTY_DESCRIPTION] vision backend returned an empty description');
    }
    return description;
  };
}

/** Explicit experimental opt-in only: Apple captions with the scoped reasoning fallback.
 * Native captions can hallucinate text and UI state, so default perception never selects this factory.
 */
export function createExperimentalAppleImageDescribeFn(
  options: ReasoningVisionOptions = {}
): DescribeFn {
  const apple = new AppleNativeImageDescriptionProvider(options);
  const reasoning = createReasoningVisionDescribeFn(options);
  return async (request) => {
    // Authorize before capability detection or any caller-supplied preparation.
    const original = assertSafeRepositoryPath(pathResolver.rootResolve(request.path));
    validateFileSize(original, 512);
    if (await apple.isAvailable()) {
      const description = await apple.describeWithPrompt(
        request.path,
        request.prompt ?? imageDescriptionPrompt(request.kind)
      );
      if (description) return description;
    }
    return reasoning(request);
  };
}
