import { coreSeamCatalog, createSeam, type SeamProviderMetadata } from '../seam.js';
import { runExternalOperation } from '../governance/external-operation.js';

export const VIDEO_FILTER_TYPES = ['color_correction', 'chroma_key', 'crop'] as const;
export type VideoFilterType = (typeof VIDEO_FILTER_TYPES)[number];

/** Tuning ranges describe this contract, not identical pixel algorithms across providers. */
export interface VideoFilterSettings {
  color_correction: {
    gamma?: number;
    contrast?: number;
    brightness?: number;
    saturation?: number;
    hue_degrees?: number;
    opacity?: number;
  };
  chroma_key: {
    color?: 'green' | 'blue' | 'magenta' | 'custom';
    /** Opaque RGB color in canonical CSS-style #RRGGBB notation; no native packed bytes. */
    custom_color?: string;
    similarity?: number;
    smoothness?: number;
    spill?: number;
  };
  crop: {
    relative?: boolean;
    left?: number;
    right?: number;
    top?: number;
    bottom?: number;
    width?: number;
    height?: number;
  };
}

export type VideoFilterRequest = {
  [K in VideoFilterType]: {
    source_id: string;
    filter_id: string;
    type: K;
    settings: VideoFilterSettings[K];
    enabled?: boolean;
  };
}[VideoFilterType];

export interface VideoFilterInfo {
  filter_id: string;
  /** Unknown native filter kinds stay opaque; native identifiers never become the public contract. */
  type: VideoFilterType | 'unsupported';
  enabled: boolean;
  index: number;
}

export interface PreparedVideoFilterApplication {
  /** Opaque SHA-256-sized identity bound to provider endpoint/config/credential. Never a secret. */
  readonly target_id: string;
  commit(): Promise<VideoFilterInfo>;
}

export interface VideoFilterProvider {
  readonly provider_id: string;
  readonly capabilities: {
    readonly filter_types: readonly VideoFilterType[];
    readonly local_only: boolean;
  };
  probe(): Promise<{ available: boolean; reason?: string }>;
  list(sourceId: string): Promise<VideoFilterInfo[]>;
  /** Pure preparation/credential resolution only. No external mutation before commit. */
  prepareApply(request: VideoFilterRequest): Promise<PreparedVideoFilterApplication>;
}

const LIMITS: Record<VideoFilterType, Record<string, readonly [number, number, boolean?]>> = {
  color_correction: {
    gamma: [-3, 3],
    contrast: [-4, 4],
    brightness: [-1, 1],
    saturation: [-1, 5],
    hue_degrees: [-180, 180],
    opacity: [0, 1],
  },
  chroma_key: {
    similarity: [1, 1000, true],
    smoothness: [1, 1000, true],
    spill: [1, 1000, true],
  },
  crop: {
    left: [-8192, 8192, true],
    right: [-8192, 8192, true],
    top: [-8192, 8192, true],
    bottom: [-8192, 8192, true],
    width: [0, 8192, true],
    height: [0, 8192, true],
  },
};

function record(input: unknown): input is Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) return false;
  return Reflect.ownKeys(input).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    return typeof key === 'string' && descriptor && 'value' in descriptor && descriptor.enumerable;
  });
}

export function validateVideoFilterSourceId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 512 ||
    /[\u0000-\u001f]/u.test(value)
  )
    throw new Error('[VIDEO_FILTER_INVALID] A bounded nonempty source/filter id is required');
  return value;
}

/** Snapshot a vendor-neutral contract before provider selection, credentials or approval. */
export function validateVideoFilterRequest(input: unknown): VideoFilterRequest {
  if (
    !record(input) ||
    Object.keys(input).some(
      (key) => !['source_id', 'filter_id', 'type', 'settings', 'enabled'].includes(key)
    )
  )
    throw new Error('[VIDEO_FILTER_INVALID] Expected exact video filter fields');
  if (typeof input.type !== 'string' || !Object.hasOwn(LIMITS, input.type))
    throw new Error('[VIDEO_FILTER_INVALID] Unsupported filter type');
  if (!record(input.settings)) throw new Error('[VIDEO_FILTER_INVALID] Expected plain settings');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean')
    throw new Error('[VIDEO_FILTER_INVALID] enabled must be boolean');
  const limits = LIMITS[input.type as VideoFilterType];
  const settings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.settings)) {
    const range = Object.hasOwn(limits, key) ? limits[key] : undefined;
    if (range) {
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < range[0] ||
        value > range[1] ||
        (range[2] && !Number.isInteger(value))
      )
        throw new Error(`[VIDEO_FILTER_INVALID] Invalid ${key}`);
    } else if (input.type === 'chroma_key' && key === 'custom_color') {
      if (typeof value !== 'string' || !/^#[a-fA-F0-9]{6}$/u.test(value))
        throw new Error('[VIDEO_FILTER_INVALID] custom_color must use #RRGGBB');
    } else if (input.type === 'chroma_key' && key === 'color') {
      if (typeof value !== 'string' || !['green', 'blue', 'magenta', 'custom'].includes(value))
        throw new Error('[VIDEO_FILTER_INVALID] Invalid chroma color');
    } else if (input.type === 'crop' && key === 'relative') {
      if (typeof value !== 'boolean')
        throw new Error('[VIDEO_FILTER_INVALID] relative must be boolean');
    } else throw new Error(`[VIDEO_FILTER_INVALID] Unsupported setting: ${key}`);
    settings[key] = value;
  }
  if (input.type === 'chroma_key') {
    if ((settings.color === 'custom') !== (settings.custom_color !== undefined))
      throw new Error(
        '[VIDEO_FILTER_INVALID] Custom chroma color requires color and custom_color together'
      );
  }
  if (input.type === 'crop') {
    const geometry = ['left', 'right', 'top', 'bottom', 'width', 'height'];
    if (geometry.some((key) => Object.hasOwn(settings, key)) && settings.relative === undefined)
      throw new Error('[VIDEO_FILTER_INVALID] Crop geometry requires an explicit relative mode');
    if (
      settings.relative === true &&
      (settings.width !== undefined || settings.height !== undefined)
    )
      throw new Error('[VIDEO_FILTER_INVALID] Relative crop uses edges, not rectangle dimensions');
    if (
      settings.relative === false &&
      (settings.right !== undefined ||
        settings.bottom !== undefined ||
        !(Number(settings.width) > 0) ||
        !(Number(settings.height) > 0))
    )
      throw new Error(
        '[VIDEO_FILTER_INVALID] Absolute crop requires positive width/height and left/top only'
      );
  }
  return Object.freeze({
    source_id: validateVideoFilterSourceId(input.source_id),
    filter_id: validateVideoFilterSourceId(input.filter_id),
    type: input.type,
    settings: Object.freeze(settings),
    enabled: input.enabled ?? true,
  }) as VideoFilterRequest;
}

const videoFilterSeam = createSeam<VideoFilterProvider>({
  key: 'video-filter-provider',
  multiplicity: 'named',
  catalog: coreSeamCatalog,
  owner: 'libs/core/video/video-filter.ts',
});
const disposers = new Set<() => void>();

export function registerVideoFilterProvider(
  provider: VideoFilterProvider,
  metadata: SeamProviderMetadata = { provenance: 'plugin', source: 'video-filter-extension' }
): () => void {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(provider.provider_id))
    throw new Error('[VIDEO_FILTER_PROVIDER_INVALID] Invalid provider id');
  if (
    !Array.isArray(provider.capabilities.filter_types) ||
    provider.capabilities.filter_types.some((kind) => !VIDEO_FILTER_TYPES.includes(kind)) ||
    typeof provider.capabilities.local_only !== 'boolean'
  )
    throw new Error('[VIDEO_FILTER_PROVIDER_INVALID] Invalid provider capabilities');
  const remove = videoFilterSeam.register(provider.provider_id, provider, metadata);
  const dispose = () => {
    remove();
    disposers.delete(dispose);
  };
  disposers.add(dispose);
  return dispose;
}

export function resetVideoFilterProviders(): void {
  for (const dispose of [...disposers]) dispose();
}
export function listVideoFilterProviders(): VideoFilterProvider[] {
  return videoFilterSeam.list().map((entry) => entry.implementation);
}

/** Auto is permitted only when selection is unambiguous; errors never redispatch to another provider. */
export function resolveVideoFilterProvider(providerId = 'auto'): VideoFilterProvider {
  const providers = listVideoFilterProviders();
  if (providerId === 'auto') {
    if (providers.length !== 1)
      throw new Error(
        '[VIDEO_FILTER_SELECTION_REQUIRED] Select one registered video filter provider'
      );
    return providers[0]!;
  }
  const provider = providers.find((entry) => entry.provider_id === providerId);
  if (!provider) throw new Error(`[VIDEO_FILTER_PROVIDER_UNKNOWN] ${providerId}`);
  return provider;
}

function validateInfo(input: VideoFilterInfo): VideoFilterInfo {
  if (
    !input ||
    (input.type !== 'unsupported' && !VIDEO_FILTER_TYPES.includes(input.type)) ||
    typeof input.enabled !== 'boolean' ||
    !Number.isInteger(input.index) ||
    input.index < 0
  )
    throw new Error('[VIDEO_FILTER_UNVERIFIED] Invalid filter metadata');
  return {
    filter_id: validateVideoFilterSourceId(input.filter_id),
    type: input.type,
    enabled: input.enabled,
    index: input.index,
  };
}

export async function listVideoFilters(
  sourceId: string,
  providerId = 'auto'
): Promise<VideoFilterInfo[]> {
  const source = validateVideoFilterSourceId(sourceId);
  const filters = await resolveVideoFilterProvider(providerId).list(source);
  if (!Array.isArray(filters) || filters.length > 256)
    throw new Error('[VIDEO_FILTER_UNVERIFIED] Invalid filter list');
  return filters.map(validateInfo);
}

export const VIDEO_FILTER_APPLY_OPERATION_ID = 'video:filter_apply';

export async function applyVideoFilter(
  input: unknown,
  providerId = 'auto'
): Promise<VideoFilterInfo> {
  const request = validateVideoFilterRequest(input);
  const provider = resolveVideoFilterProvider(providerId);
  const selectedId = provider.provider_id;
  if (!provider.capabilities.filter_types.includes(request.type))
    throw new Error(`[VIDEO_FILTER_UNSUPPORTED] ${selectedId} does not support ${request.type}`);
  let available = false;
  try {
    available = (await provider.probe()).available === true;
  } catch {
    /* A failed probe never authorizes a different provider. */
  }
  if (!available)
    throw new Error(`[VIDEO_FILTER_UNAVAILABLE] ${selectedId} is not ready; check provider setup`);
  const prepared = await provider.prepareApply(request);
  const target = prepared.target_id;
  if (typeof target !== 'string' || !/^[a-f0-9]{64}$/u.test(target))
    throw new Error('[VIDEO_FILTER_TARGET_INVALID] Provider must supply a nonsecret target digest');
  const commit = prepared.commit.bind(prepared);
  return runExternalOperation(
    {
      operationId: VIDEO_FILTER_APPLY_OPERATION_ID,
      effect: { provider_id: selectedId, target_id: target, request },
      requiresApproval: true,
      delegable: false,
    },
    async () => {
      const result = validateInfo(await commit());
      if (
        result.filter_id !== request.filter_id ||
        result.type !== request.type ||
        result.enabled !== request.enabled
      )
        throw new Error('[VIDEO_FILTER_UNVERIFIED] Provider did not confirm the requested filter');
      return result;
    },
    () => 'succeeded'
  );
}
