import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeWriteFile } from './secure-io.js';
import { safeJsonParse } from './validators.js';

export interface VoiceProfileRecord {
  profile_id: string;
  display_name: string;
  tier: 'personal' | 'confidential' | 'public';
  languages: string[];
  sample_refs?: string[];
  default_engine_id: string;
  default_effects_preset_id?: string;
  status: 'active' | 'shadow' | 'disabled';
  notes?: string;
}

export interface VoiceProfileRegistry {
  version: string;
  default_profile_id: string;
  profiles: VoiceProfileRecord[];
}

const DEFAULT_REGISTRY_PATH = pathResolver.knowledge('public/governance/voice-profile-registry.json');
const DEFAULT_PERSONAL_OVERLAY_PATH = pathResolver.knowledge('personal/voice/profile-registry.json');

const FALLBACK_REGISTRY: VoiceProfileRegistry = {
  version: 'fallback',
  default_profile_id: 'operator-en-default',
  profiles: [
    {
      profile_id: 'operator-en-default',
      display_name: 'Operator English Default',
      tier: 'public',
      languages: ['en'],
      default_engine_id: 'local_say',
      status: 'active',
    },
  ],
};

let cachedRegistryPath: string | null = null;
let cachedRegistry: VoiceProfileRegistry | null = null;

function getRegistryPath(): string {
  return process.env.KYBERION_VOICE_PROFILE_REGISTRY_PATH?.trim() || DEFAULT_REGISTRY_PATH;
}

function getPersonalOverlayPath(): string | null {
  if (process.env.KYBERION_VOICE_PROFILE_REGISTRY_PATH?.trim()) return null;
  const configured = process.env.KYBERION_PERSONAL_VOICE_PROFILE_REGISTRY_PATH?.trim() || DEFAULT_PERSONAL_OVERLAY_PATH;
  return safeExistsSync(configured) ? configured : null;
}

export function getPersonalVoiceProfileRegistryPath(): string {
  return process.env.KYBERION_PERSONAL_VOICE_PROFILE_REGISTRY_PATH?.trim() || DEFAULT_PERSONAL_OVERLAY_PATH;
}

function mergeRegistries(base: VoiceProfileRegistry, overlay: VoiceProfileRegistry): VoiceProfileRegistry {
  const profiles = new Map<string, VoiceProfileRecord>();
  for (const profile of base.profiles) profiles.set(profile.profile_id, profile);
  for (const profile of overlay.profiles) profiles.set(profile.profile_id, profile);

  const defaultProfileId = overlay.default_profile_id || base.default_profile_id;
  return {
    ...base,
    ...overlay,
    default_profile_id: profiles.has(defaultProfileId) ? defaultProfileId : base.default_profile_id,
    profiles: [...profiles.values()],
  };
}

export function getVoiceProfileRegistryPath(): string {
  return getRegistryPath();
}

export function resetVoiceProfileRegistryCache(): void {
  cachedRegistryPath = null;
  cachedRegistry = null;
}

export function getVoiceProfileRegistry(): VoiceProfileRegistry {
  const registryPath = getRegistryPath();
  const overlayPath = getPersonalOverlayPath();
  const cacheKey = overlayPath ? `${registryPath}::${overlayPath}` : registryPath;
  if (cachedRegistryPath === cacheKey && cachedRegistry) return cachedRegistry;

  if (!safeExistsSync(registryPath)) {
    cachedRegistryPath = cacheKey;
    cachedRegistry = FALLBACK_REGISTRY;
    return cachedRegistry;
  }

  try {
    const raw = safeReadFile(registryPath, { encoding: 'utf8' }) as string;
    const parsed = safeJsonParse<VoiceProfileRegistry>(raw, 'voice profile registry');
    if (!overlayPath) {
      cachedRegistryPath = cacheKey;
      cachedRegistry = parsed;
      return parsed;
    }

    const overlayRaw = safeReadFile(overlayPath, { encoding: 'utf8' }) as string;
    const overlay = safeJsonParse<VoiceProfileRegistry>(overlayRaw, 'personal voice profile registry');
    const merged = mergeRegistries(parsed, overlay);
    cachedRegistryPath = cacheKey;
    cachedRegistry = merged;
    return merged;
  } catch (error: any) {
    const target = overlayPath ? `${registryPath} or overlay ${overlayPath}` : registryPath;
    logger.warn(`[VOICE_PROFILE_REGISTRY] Failed to load registry at ${target}: ${error.message}`);
    cachedRegistryPath = cacheKey;
    cachedRegistry = FALLBACK_REGISTRY;
    return cachedRegistry;
  }
}

export function listVoiceProfiles(status: VoiceProfileRecord['status'] | 'all' = 'active'): VoiceProfileRecord[] {
  const registry = getVoiceProfileRegistry();
  if (status === 'all') return registry.profiles;
  return registry.profiles.filter((profile) => profile.status === status);
}

export function getVoiceProfileRecord(profileId?: string): VoiceProfileRecord {
  const registry = getVoiceProfileRegistry();
  const resolvedProfileId = profileId || registry.default_profile_id;
  return (
    registry.profiles.find((profile) => profile.profile_id === resolvedProfileId)
    || registry.profiles.find((profile) => profile.profile_id === registry.default_profile_id)
    || FALLBACK_REGISTRY.profiles[0]
  );
}

export function writeVoiceProfileRegistry(registry: VoiceProfileRegistry, registryPath = getRegistryPath()): string {
  safeWriteFile(registryPath, JSON.stringify(registry, null, 2));
  cachedRegistryPath = null;
  cachedRegistry = null;
  return registryPath;
}
