import path from 'node:path';
import {
  probeWindowsNativeImageRecognition,
  describeImageWithWindowsNativeApi,
} from './windows-native-image-recognition-bridge.js';
import {
  ImageDescriptionProvider,
  ImageDescriptionRequest,
  ImageDescriptionResult,
} from './image-description-types.js';
import { pathResolver } from './path-resolver.js';
import { withReasoningPayloadScope, type ReasoningPayloadScope } from './reasoning-egress-scope.js';
import type { ReasoningBackend, ReasoningImageAttachment } from './reasoning-backend-contracts.js';

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

export interface ReasoningVisionOptions {
  /** Declared tier of the image; raised (never lowered) to the tier implied by its path. */
  tier?: PayloadTier;
  tenant_slug?: string;
  /** Defaults to the active reasoning backend. Injected in tests. */
  resolveBackend?: ReasoningBackendResolver;
}

const TIER_RANK: Record<PayloadTier, number> = { public: 0, confidential: 1, personal: 2 };

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
  const { getReasoningBackend } = await import('./reasoning-backend.js');
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
    const reply = await withReasoningPayloadScope(
      {
        tier: effectiveTier(absolutePath, this.options.tier),
        ...(this.options.tenant_slug ? { tenant_slug: this.options.tenant_slug } : {}),
        purpose: 'image description',
      },
      () => backend.promptWithImages!(prompt, [{ path: absolutePath, media_type: mediaType }])
    );
    return reply.trim();
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
  /** Override the provider chain (tests). Defaults to windows_native, then reasoning_vision. */
  providers?: ImageDescriptionProvider[];
}

export async function describeImage(
  request: ImageDescriptionRequest,
  options: DescribeImageOptions = {}
): Promise<ImageDescriptionResult> {
  const providers = options.providers ?? [
    new WindowsNativeImageDescriptionProvider(),
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
