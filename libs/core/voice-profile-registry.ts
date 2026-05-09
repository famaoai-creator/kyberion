import { logger } from './core.js';
import * as customerResolver from './customer-resolver.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeReaddir, safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
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
const DEFAULT_REGISTRY_DIR = pathResolver.knowledge('public/governance/voice-profiles');
const DEFAULT_CUSTOMER_OVERLAY_PATH = 'voice/profile-registry.json';
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

function sortRegistry(registry: VoiceProfileRegistry): VoiceProfileRegistry {
  return {
    ...registry,
    profiles: [...registry.profiles].sort((left, right) => left.profile_id.localeCompare(right.profile_id)),
  };
}

function readRegistryFile(registryPath: string, label: string): VoiceProfileRegistry {
  return safeJsonParse<VoiceProfileRegistry>(safeReadFile(registryPath, { encoding: 'utf8' }) as string, label);
}

function loadRegistryDirectory(dirPath: string, fallbackDefaultProfileId = ''): VoiceProfileRegistry | null {
  if (!safeExistsSync(dirPath)) return null;
  const files = safeReaddir(dirPath).filter((entry) => entry.endsWith('.json')).sort();
  if (!files.length) return null;

  const profiles = new Map<string, VoiceProfileRecord>();
  let defaultProfileId = '';
  for (const file of files) {
    const fullPath = `${dirPath}/${file}`;
    const payload = readRegistryFile(fullPath, `voice profile registry item ${file}`);
    const records = payload.profiles || [];
    if (records.length !== 1) {
      throw new Error(`Voice profile file ${file} must contain exactly one profile`);
    }
    const profile = records[0];
    if (profile.profile_id !== file.replace(/\.json$/i, '')) {
      throw new Error(`Voice profile file ${file} must match its profile id (${profile.profile_id})`);
    }
    profiles.set(profile.profile_id, profile);
    if (!defaultProfileId && payload.default_profile_id) {
      defaultProfileId = payload.default_profile_id;
    }
  }

  const resolvedDefault = (fallbackDefaultProfileId && profiles.has(fallbackDefaultProfileId))
    ? fallbackDefaultProfileId
    : (defaultProfileId && profiles.has(defaultProfileId))
      ? defaultProfileId
      : profiles.keys().next().value as string | undefined;

  return resolvedDefault
    ? sortRegistry({
        version: '1.0.0',
        default_profile_id: resolvedDefault,
        profiles: [...profiles.values()],
      })
    : null;
}

function writeRegistryDirectory(dirPath: string, registry: VoiceProfileRegistry): void {
  safeMkdir(dirPath, { recursive: true });
  const nextIds = new Set(registry.profiles.map((profile) => profile.profile_id));
  const existing = safeExistsSync(dirPath) ? safeReaddir(dirPath).filter((entry) => entry.endsWith('.json')) : [];
  for (const file of existing) {
    const profileId = file.replace(/\.json$/i, '');
    if (!nextIds.has(profileId)) {
      safeRmSync(`${dirPath}/${file}`, { force: true });
    }
  }
  for (const profile of registry.profiles) {
    const payload = {
      version: registry.version,
      default_profile_id: registry.default_profile_id === profile.profile_id ? profile.profile_id : registry.default_profile_id,
      profiles: [profile],
    };
    safeWriteFile(`${dirPath}/${profile.profile_id}.json`, JSON.stringify(payload, null, 2));
  }
}

function getRegistryPath(): string {
  return process.env.KYBERION_VOICE_PROFILE_REGISTRY_PATH?.trim() || DEFAULT_REGISTRY_PATH;
}

function getRegistryDir(): string {
  return process.env.KYBERION_VOICE_PROFILE_REGISTRY_DIR?.trim() || DEFAULT_REGISTRY_DIR;
}

function getPersonalOverlayPath(): string | null {
  if (process.env.KYBERION_VOICE_PROFILE_REGISTRY_PATH?.trim()) return null;
  const configured = process.env.KYBERION_PERSONAL_VOICE_PROFILE_REGISTRY_PATH?.trim() || DEFAULT_PERSONAL_OVERLAY_PATH;
  return safeExistsSync(configured) ? configured : null;
}

function getCustomerOverlayPath(): string | null {
  if (process.env.KYBERION_VOICE_PROFILE_REGISTRY_PATH?.trim()) return null;
  const configured = customerResolver.customerRoot(DEFAULT_CUSTOMER_OVERLAY_PATH);
  return configured && safeExistsSync(configured) ? configured : null;
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
  const customerOverlayPath = getCustomerOverlayPath();
  const overlayPath = getPersonalOverlayPath();
  const useCanonicalDirectory = !process.env.KYBERION_VOICE_PROFILE_REGISTRY_PATH?.trim() || registryPath === DEFAULT_REGISTRY_PATH;
  const registryDir = useCanonicalDirectory ? getRegistryDir() : null;
  const cacheKey = [registryPath, registryDir, customerOverlayPath, overlayPath].filter(Boolean).join('::');
  if (cachedRegistryPath === cacheKey && cachedRegistry) return cachedRegistry;

  if (!safeExistsSync(registryPath)) {
    const directoryRegistry = useCanonicalDirectory ? loadRegistryDirectory(registryDir || getRegistryDir()) : null;
    cachedRegistryPath = cacheKey;
    cachedRegistry = directoryRegistry || FALLBACK_REGISTRY;
    return cachedRegistry;
  }

  let parsed: VoiceProfileRegistry;
  try {
    parsed = readRegistryFile(registryPath, 'voice profile registry');
  } catch (error: any) {
    logger.warn(`[VOICE_PROFILE_REGISTRY] Failed to load base registry at ${registryPath}: ${error.message}`);
    cachedRegistryPath = cacheKey;
    cachedRegistry = FALLBACK_REGISTRY;
    return cachedRegistry;
  }

  const directoryRegistry = useCanonicalDirectory ? loadRegistryDirectory(registryDir || getRegistryDir(), parsed.default_profile_id) : null;
  const baseRegistry = directoryRegistry || parsed;

  let customerOverlay: VoiceProfileRegistry | null = null;
  if (customerOverlayPath) {
    try {
      const customerRaw = safeReadFile(customerOverlayPath, { encoding: 'utf8' }) as string;
      customerOverlay = safeJsonParse<VoiceProfileRegistry>(customerRaw, 'customer voice profile registry');
    } catch (error: any) {
      logger.warn(`[VOICE_PROFILE_REGISTRY] Customer overlay unavailable (${customerOverlayPath}): ${error.message} — using base registry only`);
    }
  }

  if (!overlayPath && !customerOverlay) {
    cachedRegistryPath = cacheKey;
    cachedRegistry = baseRegistry;
    return baseRegistry;
  }

  try {
    const personalOverlay = overlayPath
      ? safeJsonParse<VoiceProfileRegistry>(
          safeReadFile(overlayPath, { encoding: 'utf8' }) as string,
          'personal voice profile registry',
        )
      : null;
    const baseWithPersonal = personalOverlay ? mergeRegistries(baseRegistry, personalOverlay) : baseRegistry;
    const merged = customerOverlay ? mergeRegistries(baseWithPersonal, customerOverlay) : baseWithPersonal;
    cachedRegistryPath = cacheKey;
    cachedRegistry = merged;
    return merged;
  } catch (error: any) {
    logger.warn(`[VOICE_PROFILE_REGISTRY] Personal overlay unavailable (${overlayPath}): ${error.message} — using base registry only`);
    cachedRegistryPath = cacheKey;
    cachedRegistry = customerOverlay ? mergeRegistries(baseRegistry, customerOverlay) : baseRegistry;
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
  const normalized = sortRegistry(registry);
  safeWriteFile(registryPath, JSON.stringify(normalized, null, 2));
  if (registryPath === DEFAULT_REGISTRY_PATH || registryPath === getRegistryPath()) {
    writeRegistryDirectory(getRegistryDir(), normalized);
  }
  cachedRegistryPath = null;
  cachedRegistry = null;
  return registryPath;
}
