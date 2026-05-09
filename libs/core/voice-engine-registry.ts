import { logger } from './core.js';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeReaddir, safeStat } from './secure-io.js';
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
const DEFAULT_REGISTRY_DIR = pathResolver.knowledge('public/governance/voice-engines');

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
let cachedRegistryDir: string | null = null;
let cachedRegistry: VoiceEngineRegistry | null = null;

function getRegistryPath(): string {
  return process.env.KYBERION_VOICE_ENGINE_REGISTRY_PATH?.trim() || DEFAULT_REGISTRY_PATH;
}

function getRegistryDir(): string {
  return process.env.KYBERION_VOICE_ENGINE_REGISTRY_DIR?.trim() || DEFAULT_REGISTRY_DIR;
}

function loadRegistryFromPath(registryPath: string): VoiceEngineRegistry {
  const raw = safeReadFile(registryPath, { encoding: 'utf8' }) as string;
  return safeJsonParse<VoiceEngineRegistry>(raw, 'voice engine registry');
}

function loadRegistryDirectory(registryDir: string): VoiceEngineRegistry {
  const dir = pathResolver.rootResolve(registryDir);
  if (!safeExistsSync(dir)) {
    throw new Error(`Voice engine registry directory not found: ${dir}`);
  }

  const files = safeReaddir(dir).filter((entry) => entry.endsWith('.json')).sort();
  if (!files.length) {
    throw new Error(`Voice engine registry directory is empty: ${dir}`);
  }

  const engines: VoiceEngineRecord[] = [];
  let version = '';
  let defaultEngineId = '';

  for (const file of files) {
    const filePath = pathResolver.rootResolve(path.join(dir, file));
    if (!safeStat(filePath).isFile()) {
      continue;
    }

    const parsed = loadRegistryFromPath(filePath);
    if (!defaultEngineId) {
      defaultEngineId = parsed.default_engine_id;
      version = parsed.version;
    } else if (parsed.default_engine_id !== defaultEngineId) {
      throw new Error(`Voice engine registry default_engine_id mismatch in ${file}`);
    }
    if (parsed.version !== version) {
      throw new Error(`Voice engine registry version mismatch in ${file}`);
    }

    const record = parsed.engines?.[0];
    if (!record) {
      throw new Error(`Voice engine registry file ${file} must contain exactly one engine`);
    }
    if (file.replace(/\.json$/i, '') !== record.engine_id) {
      throw new Error(`Voice engine registry file ${file} must match engine_id ${record.engine_id}`);
    }
    engines.push(record);
  }

  if (!defaultEngineId) {
    throw new Error(`Voice engine registry directory produced no engines: ${dir}`);
  }

  return {
    version,
    default_engine_id: defaultEngineId,
    engines,
  };
}

export function resetVoiceEngineRegistryCache(): void {
  cachedRegistryPath = null;
  cachedRegistryDir = null;
  cachedRegistry = null;
}

export function getVoiceEngineRegistry(): VoiceEngineRegistry {
  const registryPath = getRegistryPath();
  const registryDir = getRegistryDir();
  if (cachedRegistryPath === registryPath && cachedRegistryDir === registryDir && cachedRegistry) return cachedRegistry;

  if (registryPath === DEFAULT_REGISTRY_PATH && safeExistsSync(pathResolver.rootResolve(registryDir))) {
    try {
      const parsed = loadRegistryDirectory(registryDir);
      cachedRegistryPath = registryPath;
      cachedRegistryDir = registryDir;
      cachedRegistry = parsed;
      return parsed;
    } catch (error: any) {
      logger.warn(`[VOICE_ENGINE_REGISTRY] Failed to load registry directory at ${registryDir}: ${error.message}`);
    }
  }

  if (!safeExistsSync(registryPath)) {
    cachedRegistryPath = registryPath;
    cachedRegistryDir = registryDir;
    cachedRegistry = FALLBACK_REGISTRY;
    return cachedRegistry;
  }

  try {
    const parsed = loadRegistryFromPath(registryPath);
    cachedRegistryPath = registryPath;
    cachedRegistryDir = registryDir;
    cachedRegistry = parsed;
    return parsed;
  } catch (error: any) {
    logger.warn(`[VOICE_ENGINE_REGISTRY] Failed to load registry at ${registryPath}: ${error.message}`);
    cachedRegistryPath = registryPath;
    cachedRegistryDir = registryDir;
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
