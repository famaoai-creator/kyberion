import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { safeJsonParse } from './validators.js';
import { getToolRuntimeRecord } from './tool-runtime-registry.js';
import { probeToolRuntime } from './tool-runtime-registry.js';
import { probeServiceRuntime } from './service-runtime-registry.js';
import { probeAppleImageGeneration } from './apple-intelligence-bridge.js';
import {
  getVoiceEngineRegistry,
  resolveVoiceEngineForPlatform,
  type VoiceEngineRecord,
} from './voice-engine-registry.js';

export type MediaBackendModality = 'image' | 'voice' | 'video' | 'music';
export type MediaBackendStatus = 'active' | 'shadow' | 'disabled';
export type MediaBackendKind = 'service_preset' | 'api' | 'cli' | 'local';
export type MediaBackendPlatform = 'any' | 'darwin' | 'linux' | 'win32';
export type MediaBackendProbeKind =
  | 'service_runtime'
  | 'tool_runtime'
  | 'native_bridge'
  | 'registry';

export interface MediaBackendRecord {
  backend_id: string;
  modality: MediaBackendModality;
  display_name: string;
  kind: MediaBackendKind;
  provider: string;
  status: MediaBackendStatus;
  platforms: MediaBackendPlatform[];
  supports: {
    artifact_formats?: string[];
    async?: boolean;
    playback?: boolean;
    mux_audio?: boolean;
  };
  service_id?: string;
  action?: string;
  command?: string;
  args?: string[];
  fallback_backend_id?: string;
  notes?: string;
}

export interface MediaBackendRegistry {
  version: string;
  default_backend_ids: Record<MediaBackendModality, string>;
  backends: MediaBackendRecord[];
}

export interface MediaBackendAvailability {
  backend_id: string;
  modality: MediaBackendModality;
  available: boolean;
  probe_kind: MediaBackendProbeKind;
  reason: string;
  probe_id: string;
  probed_at: string;
  cache_expires_at: string;
  cache_hit: boolean;
}

export interface MediaBackendProbeOptions {
  force?: boolean;
  ttl_ms?: number;
}

type UncachedMediaBackendAvailability = Omit<
  MediaBackendAvailability,
  'probe_id' | 'probed_at' | 'cache_expires_at' | 'cache_hit'
>;

interface MediaBackendProbeCacheEntry {
  value: MediaBackendAvailability;
  expires_at_ms: number;
  in_flight?: Promise<MediaBackendAvailability>;
}

const mediaBackendProbeCache = new Map<string, MediaBackendProbeCacheEntry>();
let mediaBackendProbeSequence = 0;

export function resetMediaBackendAvailabilityCache(): void {
  mediaBackendProbeCache.clear();
}

function defaultMediaBackendProbeTtlMs(): number {
  const configured = Number(process.env.KYBERION_MEDIA_BACKEND_PROBE_TTL_MS || 30_000);
  return Number.isFinite(configured) ? Math.min(300_000, Math.max(1_000, configured)) : 30_000;
}

const DEFAULT_REGISTRY_PATH = pathResolver.knowledge(
  'product/governance/media-backend-registry.json'
);
const LOCAL_FLUX_TOOL_BACKEND = getToolRuntimeRecord('mflux').trial_backend;

const FALLBACK_REGISTRY: MediaBackendRegistry = {
  version: 'fallback',
  default_backend_ids: {
    image: 'media-generation.comfyui',
    voice: 'voice.local_say',
    video: 'video.hyperframes_cli',
    music: 'media-generation.comfyui.music',
  },
  backends: [
    {
      backend_id: 'media-generation.comfyui',
      modality: 'image',
      display_name: 'ComfyUI Media Generation',
      kind: 'service_preset',
      provider: 'comfyui',
      status: 'active',
      platforms: ['any'],
      supports: { artifact_formats: ['png', 'jpg', 'jpeg', 'webp'], async: true },
      service_id: 'media-generation',
      action: 'generate_image',
    },
    {
      backend_id: 'media-generation.comfyui.video',
      modality: 'video',
      display_name: 'ComfyUI Video Generation',
      kind: 'service_preset',
      provider: 'comfyui',
      status: 'active',
      platforms: ['any'],
      supports: { artifact_formats: ['mp4', 'mov', 'webm', 'gif'], async: true },
      service_id: 'media-generation',
      action: 'generate_video',
      fallback_backend_id: 'video.hyperframes_cli',
    },
    {
      backend_id: 'media-generation.comfyui.music',
      modality: 'music',
      display_name: 'ComfyUI Music Generation',
      kind: 'service_preset',
      provider: 'comfyui',
      status: 'active',
      platforms: ['any'],
      supports: { artifact_formats: ['mp3', 'wav', 'flac'], async: true },
      service_id: 'media-generation',
      action: 'generate_music',
    },
    {
      backend_id: 'media-generation.local_flux',
      modality: 'image',
      display_name: 'Local FLUX Image Generation',
      kind: 'cli',
      provider: 'mflux',
      status: 'active',
      platforms: ['darwin'],
      supports: { artifact_formats: ['png', 'jpg', 'jpeg', 'webp'], async: false },
      command: LOCAL_FLUX_TOOL_BACKEND.command,
      args: LOCAL_FLUX_TOOL_BACKEND.args,
      fallback_backend_id: 'media-generation.comfyui',
      notes: 'Apple Silicon local FLUX generation via the governed tool runtime registry.',
    },
    {
      backend_id: 'media-generation.apple_playground',
      modality: 'image',
      display_name: 'Apple Image Playground',
      kind: 'local',
      provider: 'apple_image_playground',
      status: 'active',
      platforms: ['darwin'],
      supports: { artifact_formats: ['png'], async: false },
      fallback_backend_id: 'media-generation.local_flux',
      notes: 'macOS Apple Silicon Image Playground through the native capability bridge.',
    },
    {
      backend_id: 'voice.local_say',
      modality: 'voice',
      display_name: 'Local System TTS',
      kind: 'local',
      provider: 'system_tts',
      status: 'active',
      platforms: ['darwin', 'linux', 'win32'],
      supports: { playback: true, artifact_formats: ['wav', 'aiff'] },
    },
    {
      backend_id: 'video.hyperframes_cli',
      modality: 'video',
      display_name: 'HyperFrames CLI Renderer',
      kind: 'cli',
      provider: 'hyperframes',
      status: 'active',
      platforms: ['any'],
      supports: { artifact_formats: ['mp4', 'mov', 'webm', 'gif'], async: true, mux_audio: true },
      command: 'npx',
      args: ['hyperframes', 'render'],
    },
  ],
};

let cachedRegistryPath: string | null = null;
let cachedRegistry: MediaBackendRegistry | null = null;

function getRegistryPath(): string {
  return process.env.KYBERION_MEDIA_BACKEND_REGISTRY_PATH?.trim() || DEFAULT_REGISTRY_PATH;
}

function loadRegistryFromPath(registryPath: string): MediaBackendRegistry {
  const raw = safeReadFile(registryPath, { encoding: 'utf8' }) as string;
  return safeJsonParse<MediaBackendRegistry>(raw, 'media backend registry');
}

function inferVoiceBackendRecords(): MediaBackendRecord[] {
  return getVoiceEngineRegistry().engines.map((engine) => mapVoiceEngineToBackend(engine));
}

function mapVoiceEngineToBackend(engine: VoiceEngineRecord): MediaBackendRecord {
  return {
    backend_id: `voice.${engine.engine_id}`,
    modality: 'voice',
    display_name: engine.display_name,
    kind: engine.kind === 'voice_clone_service' ? 'api' : 'local',
    provider: engine.provider,
    status: engine.status,
    platforms: engine.platforms,
    supports: {
      playback: engine.supports.playback,
      artifact_formats: engine.supports.artifact_formats,
    },
    fallback_backend_id: engine.fallback_engine_id
      ? `voice.${engine.fallback_engine_id}`
      : undefined,
    notes: engine.notes,
  };
}

function mergeVoiceBackends(backends: MediaBackendRecord[]): MediaBackendRecord[] {
  const voiceBackends = inferVoiceBackendRecords();
  const existing = new Set(backends.map((backend) => backend.backend_id));
  const merged = [...backends];
  for (const backend of voiceBackends) {
    if (!existing.has(backend.backend_id)) {
      merged.push(backend);
    }
  }
  return merged;
}

function resolveVoiceBackendRecord(
  backendId?: string,
  platform: NodeJS.Platform = process.platform
): MediaBackendRecord {
  const engine = resolveVoiceEngineForPlatform(
    backendId?.replace(/^voice\./u, '') || undefined,
    platform
  );
  return mapVoiceEngineToBackend(engine);
}

function getRegistry(): MediaBackendRegistry {
  const registryPath = getRegistryPath();
  if (cachedRegistryPath === registryPath && cachedRegistry) return cachedRegistry;

  if (!safeExistsSync(registryPath)) {
    cachedRegistryPath = registryPath;
    cachedRegistry = {
      ...FALLBACK_REGISTRY,
      backends: mergeVoiceBackends(FALLBACK_REGISTRY.backends),
    };
    return cachedRegistry;
  }

  try {
    const parsed = loadRegistryFromPath(registryPath);
    cachedRegistryPath = registryPath;
    cachedRegistry = {
      ...parsed,
      backends: mergeVoiceBackends(parsed.backends || []),
    };
    return cachedRegistry;
  } catch (error: any) {
    logger.warn(
      `[MEDIA_BACKEND_REGISTRY] Failed to load registry at ${registryPath}: ${error.message}`
    );
    cachedRegistryPath = registryPath;
    cachedRegistry = FALLBACK_REGISTRY;
    return cachedRegistry;
  }
}

export function resetMediaBackendRegistryCache(): void {
  cachedRegistryPath = null;
  cachedRegistry = null;
}

export function getMediaBackendRegistry(): MediaBackendRegistry {
  return getRegistry();
}

export function listMediaBackends(modality?: MediaBackendModality): MediaBackendRecord[] {
  const registry = getRegistry();
  const backends = registry.backends.length > 0 ? registry.backends : mergeVoiceBackends([]);
  return modality ? backends.filter((backend) => backend.modality === modality) : backends;
}

export function getMediaBackendRecord(
  backendId?: string,
  modality?: MediaBackendModality
): MediaBackendRecord {
  const registry = getRegistry();
  const defaultBackendId = modality ? registry.default_backend_ids[modality] : undefined;
  const resolvedId = backendId || defaultBackendId || registry.default_backend_ids.image;
  const aliasId =
    modality === 'video' && resolvedId === 'media-generation.comfyui'
      ? 'media-generation.comfyui.video'
      : modality === 'music' && resolvedId === 'media-generation.comfyui'
        ? 'media-generation.comfyui.music'
        : modality === 'image' && resolvedId === 'local_flux'
          ? 'media-generation.local_flux'
          : modality === 'image' && resolvedId === 'apple_playground'
            ? 'media-generation.apple_playground'
            : resolvedId;

  const voiceBackendMatch =
    aliasId.startsWith('voice.') &&
    !registry.backends.find((backend) => backend.backend_id === aliasId);
  if (voiceBackendMatch || modality === 'voice') {
    return resolveVoiceBackendRecord(aliasId);
  }

  return (
    registry.backends.find(
      (backend) => backend.backend_id === aliasId && (!modality || backend.modality === modality)
    ) ||
    registry.backends.find((backend) =>
      modality ? backend.modality === modality && backend.backend_id === defaultBackendId : false
    ) ||
    (modality
      ? registry.backends.find((backend) => backend.modality === modality)
      : registry.backends[0]) ||
    FALLBACK_REGISTRY.backends[0]
  );
}

function isSupportedPlatform(backend: MediaBackendRecord, platform: NodeJS.Platform): boolean {
  return (
    backend.platforms.includes('any') ||
    backend.platforms.includes(platform as MediaBackendPlatform)
  );
}

/**
 * One availability contract for media backends. The registry remains the
 * source of truth for identity and modality; governed runtime registries are
 * the source of truth for live service/tool probes.
 */
async function probeMediaBackendAvailabilityUncached(
  backend: MediaBackendRecord,
  platform: NodeJS.Platform
): Promise<UncachedMediaBackendAvailability> {
  if (backend.status !== 'active') {
    return {
      backend_id: backend.backend_id,
      modality: backend.modality,
      available: false,
      probe_kind: 'registry',
      reason: `backend status is ${backend.status}`,
    };
  }
  if (!isSupportedPlatform(backend, platform)) {
    return {
      backend_id: backend.backend_id,
      modality: backend.modality,
      available: false,
      probe_kind: 'registry',
      reason: `backend is not supported on platform ${platform}`,
    };
  }

  if (backend.provider === 'comfyui') {
    const resolution = await probeServiceRuntime('comfyui', 'trial', platform);
    return {
      backend_id: backend.backend_id,
      modality: backend.modality,
      available: resolution.available,
      probe_kind: 'service_runtime',
      reason: resolution.reason,
    };
  }
  if (backend.provider === 'mflux') {
    const resolution = probeToolRuntime('mflux', 'trial', platform);
    return {
      backend_id: backend.backend_id,
      modality: backend.modality,
      available: resolution.selected_action !== 'install',
      probe_kind: 'tool_runtime',
      reason: resolution.reason,
    };
  }
  if (backend.provider === 'apple_image_playground') {
    const resolution = await probeAppleImageGeneration();
    return {
      backend_id: backend.backend_id,
      modality: backend.modality,
      available: resolution.available,
      probe_kind: 'native_bridge',
      reason: resolution.reason || 'Image Playground probe completed',
    };
  }

  return {
    backend_id: backend.backend_id,
    modality: backend.modality,
    available: true,
    probe_kind: 'registry',
    reason: 'no live probe is registered; active registry record is usable',
  };
}

export async function probeMediaBackendAvailability(
  backendId?: string,
  modality?: MediaBackendModality,
  platform: NodeJS.Platform = process.platform,
  options: MediaBackendProbeOptions = {}
): Promise<MediaBackendAvailability> {
  const backend = getMediaBackendRecord(backendId, modality);
  const key = `${backend.backend_id}:${backend.modality}:${platform}`;
  const now = Date.now();
  const cached = mediaBackendProbeCache.get(key);
  if (!options.force && cached?.in_flight) return cached.in_flight;
  if (!options.force && cached && cached.expires_at_ms > now) {
    return { ...cached.value, cache_hit: true };
  }

  const ttlMs = Number.isFinite(options.ttl_ms)
    ? Math.min(300_000, Math.max(1_000, Number(options.ttl_ms)))
    : defaultMediaBackendProbeTtlMs();
  const probedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ttlMs).toISOString();
  const probeId = `media-probe-${++mediaBackendProbeSequence}`;
  const probe = probeMediaBackendAvailabilityUncached(backend, platform)
    .then((value) => {
      const result: MediaBackendAvailability = {
        ...value,
        probe_id: probeId,
        probed_at: probedAt,
        cache_expires_at: expiresAt,
        cache_hit: false,
      };
      mediaBackendProbeCache.set(key, { value: result, expires_at_ms: now + ttlMs });
      return result;
    })
    .catch((error: unknown) => {
      const current = mediaBackendProbeCache.get(key);
      if (current?.value.probe_id === probeId) mediaBackendProbeCache.delete(key);
      throw error;
    });
  mediaBackendProbeCache.set(key, {
    value: {
      backend_id: backend.backend_id,
      modality: backend.modality,
      available: false,
      probe_kind: 'registry',
      reason: 'availability probe in flight',
      probe_id: probeId,
      probed_at: probedAt,
      cache_expires_at: expiresAt,
      cache_hit: false,
    },
    expires_at_ms: now + ttlMs,
    in_flight: probe,
  });
  return probe;
}

/**
 * Resolve an execution candidate using the same explicit-fallback policy as
 * the synchronous resolver, while consulting live availability probes.
 * An unavailable backend without a governed fallback is returned as-is so
 * the caller can preserve provider-specific error semantics.
 */
export async function resolveMediaBackendWithAvailability(
  modality: MediaBackendModality,
  backendId?: string,
  platform: NodeJS.Platform = process.platform
): Promise<{
  backend: MediaBackendRecord;
  availability: MediaBackendAvailability;
  fallback_used: boolean;
}> {
  const visited = new Set<string>();
  let current = getMediaBackendRecord(backendId, modality);
  let fallbackUsed = false;
  while (!visited.has(current.backend_id)) {
    visited.add(current.backend_id);
    const availability = await probeMediaBackendAvailability(
      current.backend_id,
      modality,
      platform
    );
    if (availability.available) {
      return { backend: current, availability, fallback_used: fallbackUsed };
    }
    if (!current.fallback_backend_id) {
      return { backend: current, availability, fallback_used: fallbackUsed };
    }
    current = getMediaBackendRecord(current.fallback_backend_id, modality);
    fallbackUsed = true;
  }
  const backend = getMediaBackendRecord(backendId, modality);
  const availability = await probeMediaBackendAvailability(backend.backend_id, modality, platform);
  return { backend, availability, fallback_used: fallbackUsed };
}

export function resolveMediaBackendForPlatform(
  modality: MediaBackendModality,
  backendId?: string,
  platform: NodeJS.Platform = process.platform
): MediaBackendRecord {
  const registry = getRegistry();
  const defaultBackendId = registry.default_backend_ids[modality];
  const visited = new Set<string>();
  let current = getMediaBackendRecord(backendId || defaultBackendId, modality);

  while (current) {
    if (visited.has(current.backend_id)) break;
    visited.add(current.backend_id);
    if (current.status === 'active' && isSupportedPlatform(current, platform)) {
      return current;
    }
    if (current.fallback_backend_id) {
      current = getMediaBackendRecord(current.fallback_backend_id, modality);
      continue;
    }
    break;
  }

  const defaultBackend = getMediaBackendRecord(defaultBackendId, modality);
  if (defaultBackend.status === 'active' && isSupportedPlatform(defaultBackend, platform)) {
    return defaultBackend;
  }

  throw new Error(
    `No compatible active media backend found for modality=${modality} on platform ${platform}`
  );
}

export function resolveImageBackend(
  backendId?: string,
  platform: NodeJS.Platform = process.platform
): MediaBackendRecord {
  return resolveMediaBackendForPlatform('image', backendId, platform);
}

export function resolveVoiceBackend(
  backendId?: string,
  platform: NodeJS.Platform = process.platform
): MediaBackendRecord {
  return resolveMediaBackendForPlatform('voice', backendId, platform);
}

export function resolveVideoBackend(
  backendId?: string,
  platform: NodeJS.Platform = process.platform
): MediaBackendRecord {
  return resolveMediaBackendForPlatform('video', backendId, platform);
}

export function resolveMusicBackend(
  backendId?: string,
  platform: NodeJS.Platform = process.platform
): MediaBackendRecord {
  return resolveMediaBackendForPlatform('music', backendId, platform);
}
