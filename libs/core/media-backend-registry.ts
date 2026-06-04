import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { safeJsonParse } from './validators.js';
import { getToolRuntimeRecord } from './tool-runtime-registry.js';
import { getVoiceEngineRegistry, resolveVoiceEngineForPlatform, type VoiceEngineRecord } from './voice-engine-registry.js';

export type MediaBackendModality = 'image' | 'voice' | 'video' | 'music';
export type MediaBackendStatus = 'active' | 'shadow' | 'disabled';
export type MediaBackendKind = 'service_preset' | 'api' | 'cli' | 'local';
export type MediaBackendPlatform = 'any' | 'darwin' | 'linux' | 'win32';

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

const DEFAULT_REGISTRY_PATH = pathResolver.knowledge('product/governance/media-backend-registry.json');
const LOCAL_FLUX_TOOL_BACKEND = getToolRuntimeRecord('mflux').trial_backend;

const FALLBACK_REGISTRY: MediaBackendRegistry = {
  version: 'fallback',
  default_backend_ids: {
    image: 'media-generation.comfyui',
    voice: 'voice.local_say',
    video: 'video.hyperframes_cli',
    music: 'media-generation.comfyui',
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
    fallback_backend_id: engine.fallback_engine_id ? `voice.${engine.fallback_engine_id}` : undefined,
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

function resolveVoiceBackendRecord(backendId?: string, platform: NodeJS.Platform = process.platform): MediaBackendRecord {
  const engine = resolveVoiceEngineForPlatform(backendId?.replace(/^voice\./u, '') || undefined, platform);
  return mapVoiceEngineToBackend(engine);
}

function getRegistry(): MediaBackendRegistry {
  const registryPath = getRegistryPath();
  if (cachedRegistryPath === registryPath && cachedRegistry) return cachedRegistry;

  if (!safeExistsSync(registryPath)) {
    cachedRegistryPath = registryPath;
    cachedRegistry = {
      ...FALLBACK_REGISTRY,
      backends: mergeVoiceBackends([FALLBACK_REGISTRY.backends[0], FALLBACK_REGISTRY.backends[2]]),
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
    logger.warn(`[MEDIA_BACKEND_REGISTRY] Failed to load registry at ${registryPath}: ${error.message}`);
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
  const backends = registry.backends.length > 0
    ? registry.backends
    : mergeVoiceBackends([]);
  return modality ? backends.filter((backend) => backend.modality === modality) : backends;
}

export function getMediaBackendRecord(
  backendId?: string,
  modality?: MediaBackendModality,
): MediaBackendRecord {
  const registry = getRegistry();
  const defaultBackendId = modality ? registry.default_backend_ids[modality] : undefined;
  const resolvedId = backendId || defaultBackendId || registry.default_backend_ids.image;
  const aliasId =
    modality === 'image' && resolvedId === 'local_flux'
      ? 'media-generation.local_flux'
      : resolvedId;

  const voiceBackendMatch = aliasId.startsWith('voice.') && !registry.backends.find((backend) => backend.backend_id === aliasId);
  if (voiceBackendMatch || modality === 'voice') {
    return resolveVoiceBackendRecord(aliasId);
  }

  return (
    registry.backends.find((backend) => backend.backend_id === aliasId)
    || registry.backends.find((backend) => modality ? backend.modality === modality && backend.backend_id === defaultBackendId : false)
    || registry.backends[0]
    || FALLBACK_REGISTRY.backends[0]
  );
}

function isSupportedPlatform(backend: MediaBackendRecord, platform: NodeJS.Platform): boolean {
  return backend.platforms.includes('any') || backend.platforms.includes(platform as MediaBackendPlatform);
}

export function resolveMediaBackendForPlatform(
  modality: MediaBackendModality,
  backendId?: string,
  platform: NodeJS.Platform = process.platform,
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

  throw new Error(`No compatible active media backend found for modality=${modality} on platform ${platform}`);
}

export function resolveImageBackend(backendId?: string, platform: NodeJS.Platform = process.platform): MediaBackendRecord {
  return resolveMediaBackendForPlatform('image', backendId, platform);
}

export function resolveVoiceBackend(backendId?: string, platform: NodeJS.Platform = process.platform): MediaBackendRecord {
  return resolveMediaBackendForPlatform('voice', backendId, platform);
}

export function resolveVideoBackend(backendId?: string, platform: NodeJS.Platform = process.platform): MediaBackendRecord {
  return resolveMediaBackendForPlatform('video', backendId, platform);
}
