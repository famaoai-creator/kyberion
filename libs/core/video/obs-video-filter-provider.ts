import { createHmac, scryptSync } from 'node:crypto';
import {
  ObsVirtualCamera,
  type ObsSourceFilter,
  type ObsSourceFilterRequest,
  type ObsVirtualCameraOptions,
} from '../obs-virtual-camera-output.js';
import { getSecret } from '../secret/secret-guard.js';
import { resolveAuditChainKey } from '../chain-integrity.js';
import {
  validateVideoFilterRequest,
  validateVideoFilterSourceId,
  type VideoFilterInfo,
  type VideoFilterProvider,
  type VideoFilterRequest,
  type VideoFilterType,
} from './video-filter.js';

const TYPES = {
  color_filter_v2: 'color_correction',
  chroma_key_filter_v2: 'chroma_key',
  crop_filter: 'crop',
} as const;

/** OBS vec4_from_rgba consumes the red channel in the least-significant byte.
 * https://github.com/obsproject/obs-studio/blob/master/libobs/graphics/vec4.h */
function packedObsColor(rgb: string): number {
  const red = Number.parseInt(rgb.slice(1, 3), 16);
  const green = Number.parseInt(rgb.slice(3, 5), 16);
  const blue = Number.parseInt(rgb.slice(5, 7), 16);
  return 0xff000000 + blue * 65536 + green * 256 + red;
}

function info(filter: ObsSourceFilter): VideoFilterInfo {
  return {
    filter_id: filter.filterName,
    type: Object.hasOwn(TYPES, filter.filterKind)
      ? TYPES[filter.filterKind as keyof typeof TYPES]
      : 'unsupported',
    enabled: filter.filterEnabled,
    index: filter.filterIndex,
  };
}

/** Translation stays adapter-owned: common contracts never contain native filter ids. */
export function toObsVideoFilterRequest(input: VideoFilterRequest): ObsSourceFilterRequest {
  const request = validateVideoFilterRequest(input);
  const common = {
    sourceName: request.source_id,
    filterName: request.filter_id,
    enabled: request.enabled,
  };
  if (request.type === 'color_correction') {
    const { hue_degrees, ...settings } = request.settings;
    return {
      ...common,
      kind: 'color_filter_v2',
      settings: { ...settings, ...(hue_degrees === undefined ? {} : { hue_shift: hue_degrees }) },
    };
  }
  if (request.type === 'chroma_key') {
    const { color, custom_color, ...settings } = request.settings;
    return {
      ...common,
      kind: 'chroma_key_filter_v2',
      settings: {
        ...settings,
        ...(color === undefined ? {} : { key_color_type: color }),
        ...(custom_color === undefined ? {} : { key_color: packedObsColor(custom_color) }),
      },
    };
  }
  const { width, height, ...settings } = request.settings;
  return {
    ...common,
    kind: 'crop_filter',
    settings: {
      ...settings,
      ...(width === undefined ? {} : { cx: width }),
      ...(height === undefined ? {} : { cy: height }),
    },
  };
}

export interface ObsVideoFilterProviderOptions extends ObsVirtualCameraOptions {}

/** Config is selected by the trusted host/plugin, never by the generic action payload. */
export function createObsVideoFilterProvider(
  options: ObsVideoFilterProviderOptions = {}
): VideoFilterProvider {
  const captured = { ...options };
  const host = captured.host ?? '127.0.0.1';
  const port = captured.port ?? 4455;
  // The built-in provider is local-only. Remote transports require a separately governed provider.
  if (host !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(
      '[VIDEO_FILTER_TARGET_INVALID] Built-in OBS provider requires a loopback endpoint'
    );
  const configuration = () => ({
    ...captured,
    host,
    port,
    password: captured.password ?? getSecret('KYBERION_OBS_WS_PASSWORD') ?? '',
  });
  return {
    provider_id: 'obs',
    capabilities: Object.freeze({
      filter_types: Object.freeze(['color_correction', 'chroma_key', 'crop'] as VideoFilterType[]),
      local_only: true,
    }),
    probe: async () => {
      try {
        await new ObsVirtualCamera({ ...captured, host, port }).checkReachable();
        return { available: true };
      } catch {
        return { available: false, reason: 'Local video filter provider is unavailable' };
      }
    },
    list: async (sourceId) => {
      const source = validateVideoFilterSourceId(sourceId);
      return (await new ObsVirtualCamera(configuration()).listSourceFilters(source)).map(info);
    },
    prepareApply: async (input) => {
      const request = toObsVideoFilterRequest(input);
      const config = configuration();
      const key = resolveAuditChainKey({ createIfMissing: true });
      if (!key)
        throw new Error('[VIDEO_FILTER_TARGET_INVALID] A governed installation key is required');
      const salt = createHmac('sha256', key)
        .update(JSON.stringify(['video-filter:obs:v1', host, port]))
        .digest();
      const target_id = scryptSync(config.password, salt, 32).toString('hex');
      const client = new ObsVirtualCamera(config);
      return Object.freeze({
        target_id,
        commit: async () => info(await client.applySourceFilter(request)),
      });
    },
  };
}
