import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
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

export function resetVoiceProfileRegistryCache(): void {
  cachedRegistryPath = null;
  cachedRegistry = null;
}

export function getVoiceProfileRegistry(): VoiceProfileRegistry {
  const registryPath = getRegistryPath();
  if (cachedRegistryPath === registryPath && cachedRegistry) return cachedRegistry;

  if (!safeExistsSync(registryPath)) {
    cachedRegistryPath = registryPath;
    cachedRegistry = FALLBACK_REGISTRY;
    return cachedRegistry;
  }

  try {
    const raw = safeReadFile(registryPath, { encoding: 'utf8' }) as string;
    const parsed = safeJsonParse<VoiceProfileRegistry>(raw, 'voice profile registry');
    cachedRegistryPath = registryPath;
    cachedRegistry = parsed;
    return parsed;
  } catch (error: any) {
    logger.warn(`[VOICE_PROFILE_REGISTRY] Failed to load registry at ${registryPath}: ${error.message}`);
    cachedRegistryPath = registryPath;
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
