import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { safeJsonParse } from './validators.js';

export type VoiceEngineStatus = 'active' | 'shadow' | 'disabled';
export type VoiceEngineKind = 'native_local' | 'voice_clone_service';
export type VoiceEnginePlatform = 'any' | 'darwin' | 'linux' | 'win32';
export type VoiceEngineArtifactFormat = 'wav' | 'mp3' | 'ogg' | 'aiff';

export interface VoiceEngineRecord {
  engine_id: string;
  display_name: string;
  kind: VoiceEngineKind;
  provider: string;
  status: VoiceEngineStatus;
  platforms: VoiceEnginePlatform[];
  supports: {
    list_voices: boolean;
    playback: boolean;
    artifact_formats: VoiceEngineArtifactFormat[];
  };
  fallback_engine_id?: string;
  notes?: string;
}

export interface VoiceEngineRegistry {
  version: string;
  default_engine_id: string;
  engines: VoiceEngineRecord[];
}

const DEFAULT_REGISTRY_PATH = pathResolver.knowledge('public/governance/voice-engine-registry.json');

const FALLBACK_REGISTRY: VoiceEngineRegistry = {
  version: 'fallback',
  default_engine_id: 'local_say',
  engines: [
    {
      engine_id: 'local_say',
      display_name: 'Local System TTS',
      kind: 'native_local',
      provider: 'system_tts',
      status: 'active',
      platforms: ['darwin', 'linux', 'win32'],
      supports: {
        list_voices: true,
        playback: true,
        artifact_formats: ['wav', 'aiff'],
      },
    },
  ],
};

let cachedRegistryPath: string | null = null;
let cachedRegistry: VoiceEngineRegistry | null = null;

function getRegistryPath(): string {
  return process.env.KYBERION_VOICE_ENGINE_REGISTRY_PATH?.trim() || DEFAULT_REGISTRY_PATH;
}

export function resetVoiceEngineRegistryCache(): void {
  cachedRegistryPath = null;
  cachedRegistry = null;
}

export function getVoiceEngineRegistry(): VoiceEngineRegistry {
  const registryPath = getRegistryPath();
  if (cachedRegistryPath === registryPath && cachedRegistry) return cachedRegistry;

  if (!safeExistsSync(registryPath)) {
    cachedRegistryPath = registryPath;
    cachedRegistry = FALLBACK_REGISTRY;
    return cachedRegistry;
  }

  try {
    const raw = safeReadFile(registryPath, { encoding: 'utf8' }) as string;
    const parsed = safeJsonParse<VoiceEngineRegistry>(raw, 'voice engine registry');
    cachedRegistryPath = registryPath;
    cachedRegistry = parsed;
    return parsed;
  } catch (error: any) {
    logger.warn(`[VOICE_ENGINE_REGISTRY] Failed to load registry at ${registryPath}: ${error.message}`);
    cachedRegistryPath = registryPath;
    cachedRegistry = FALLBACK_REGISTRY;
    return cachedRegistry;
  }
}

export function listVoiceEngines(status: VoiceEngineStatus | 'all' = 'active'): VoiceEngineRecord[] {
  const registry = getVoiceEngineRegistry();
  if (status === 'all') return registry.engines;
  return registry.engines.filter((engine) => engine.status === status);
}

export function getVoiceEngineRecord(engineId?: string): VoiceEngineRecord {
  const registry = getVoiceEngineRegistry();
  const resolvedEngineId = engineId || registry.default_engine_id;
  return (
    registry.engines.find((engine) => engine.engine_id === resolvedEngineId)
    || registry.engines.find((engine) => engine.engine_id === registry.default_engine_id)
    || FALLBACK_REGISTRY.engines[0]
  );
}

function isSupportedPlatform(engine: VoiceEngineRecord, platform: NodeJS.Platform): boolean {
  return engine.platforms.includes('any') || engine.platforms.includes(platform as VoiceEnginePlatform);
}

export function resolveVoiceEngineForPlatform(engineId?: string, platform: NodeJS.Platform = process.platform): VoiceEngineRecord {
  const registry = getVoiceEngineRegistry();
  const defaultEngine = getVoiceEngineRecord(registry.default_engine_id);
  const visited = new Set<string>();
  let current = getVoiceEngineRecord(engineId);

  while (current) {
    if (visited.has(current.engine_id)) break;
    visited.add(current.engine_id);
    if (current.status === 'active' && isSupportedPlatform(current, platform)) {
      return current;
    }
    if (current.fallback_engine_id) {
      current = getVoiceEngineRecord(current.fallback_engine_id);
      continue;
    }
    break;
  }

  if (defaultEngine.status === 'active' && isSupportedPlatform(defaultEngine, platform)) {
    return defaultEngine;
  }

  throw new Error(`No compatible active voice engine found for platform ${platform}`);
}
