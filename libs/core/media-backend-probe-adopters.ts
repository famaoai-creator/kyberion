import { probeAppleImageGeneration } from './apple-intelligence-bridge.js';
import { probeServiceRuntime } from './service-runtime-registry.js';
import { probeToolRuntime } from './tool-runtime-registry.js';
import type {
  MediaBackendProbeAdapterId,
  MediaBackendProbeKind,
  MediaBackendRecord,
} from './media-backend-registry.js';

export interface MediaBackendProbeAdopterResult {
  available: boolean;
  probe_kind: MediaBackendProbeKind;
  reason: string;
}

export interface MediaBackendProbeAdopter {
  readonly adapter_id: MediaBackendProbeAdapterId;
  probe(
    backend: MediaBackendRecord,
    platform: NodeJS.Platform
  ): Promise<MediaBackendProbeAdopterResult>;
}

const serviceRuntimeAdopter: MediaBackendProbeAdopter = {
  adapter_id: 'service_runtime',
  async probe(backend, platform) {
    if (!backend.service_id) {
      return { available: false, probe_kind: 'registry', reason: 'service_id is not configured' };
    }
    const result = await probeServiceRuntime(backend.service_id, 'trial', platform);
    return { available: result.available, probe_kind: 'service_runtime', reason: result.reason };
  },
};

const toolRuntimeAdopter: MediaBackendProbeAdopter = {
  adapter_id: 'tool_runtime',
  async probe(backend, platform) {
    if (!backend.runtime_id) {
      return { available: false, probe_kind: 'registry', reason: 'runtime_id is not configured' };
    }
    const result = probeToolRuntime(backend.runtime_id, 'trial', platform);
    return {
      available: result.selected_action !== 'install',
      probe_kind: 'tool_runtime',
      reason: result.reason,
    };
  },
};

const appleImageGenerationAdopter: MediaBackendProbeAdopter = {
  adapter_id: 'apple_image_generation',
  async probe() {
    const result = await probeAppleImageGeneration();
    return {
      available: result.available,
      probe_kind: 'native_bridge',
      reason: result.reason || 'Image generation probe completed',
    };
  },
};

const unavailableAdopter: MediaBackendProbeAdopter = {
  adapter_id: 'unavailable',
  async probe() {
    return { available: false, probe_kind: 'registry', reason: 'No runtime adopter is available' };
  },
};

const MEDIA_BACKEND_PROBE_ADOPTERS: Readonly<
  Record<MediaBackendProbeAdapterId, MediaBackendProbeAdopter>
> = {
  service_runtime: serviceRuntimeAdopter,
  tool_runtime: toolRuntimeAdopter,
  apple_image_generation: appleImageGenerationAdopter,
  unavailable: unavailableAdopter,
};

export function resolveMediaBackendProbeAdopter(
  adapterId: MediaBackendProbeAdapterId | undefined
): MediaBackendProbeAdopter | undefined {
  return adapterId ? MEDIA_BACKEND_PROBE_ADOPTERS[adapterId] : undefined;
}
