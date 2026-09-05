import { defineCatalog } from './foundation/governed-catalog.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeWriteFile } from './secure-io.js';
import { type PresentationPreferenceProfile } from './src/types/presentation-preference-profile.js';

export interface PresentationPreferenceRegistry {
  version: string;
  default_profile_id: string;
  profiles: PresentationPreferenceProfile[];
}

const REGISTRY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/presentation-preference-registry.schema.json'
);
const PROFILE_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/presentation-preference-profile.schema.json'
);
const DEFAULT_REGISTRY_PATH = pathResolver.knowledge(
  'product/governance/presentation-preference-registry.json'
);
const DEFAULT_PERSONAL_OVERLAY_PATH = pathResolver.knowledge(
  'personal/orchestration/presentation-preference-registry.json'
);

let registryCacheKey: string | null = null;
let registryCache: PresentationPreferenceRegistry | null = null;
function loadRegistryFromPath(registryPath: string): PresentationPreferenceRegistry {
  return defineCatalog<PresentationPreferenceRegistry>({
    id: 'presentation-preference-registry',
    path: registryPath,
    schema: REGISTRY_SCHEMA_PATH,
  }).load();
}

export function validatePresentationPreferenceProfile(
  value: unknown,
  sourcePath = '<inline>'
): PresentationPreferenceProfile {
  return defineCatalog<PresentationPreferenceProfile>({
    id: 'presentation-preference-profile',
    path: sourcePath,
    schema: PROFILE_SCHEMA_PATH,
  }).validate(value, sourcePath);
}

export function loadPresentationPreferenceProfileFromPath(
  profilePath: string
): PresentationPreferenceProfile {
  return defineCatalog<PresentationPreferenceProfile>({
    id: 'presentation-preference-profile',
    path: profilePath,
    schema: PROFILE_SCHEMA_PATH,
  }).load();
}

function getRegistryPath(): string {
  return (
    getRegisteredEnvText('KYBERION_PRESENTATION_PREFERENCE_REGISTRY_PATH')?.trim() ||
    DEFAULT_REGISTRY_PATH
  );
}

function getPersonalOverlayPath(): string | null {
  if (getRegisteredEnvText('KYBERION_PRESENTATION_PREFERENCE_REGISTRY_PATH')?.trim()) return null;
  return (
    getRegisteredEnvText('KYBERION_PERSONAL_PRESENTATION_PREFERENCE_REGISTRY_PATH')?.trim() ||
    DEFAULT_PERSONAL_OVERLAY_PATH
  );
}

function mergeRegistries(
  base: PresentationPreferenceRegistry,
  overlay: PresentationPreferenceRegistry
): PresentationPreferenceRegistry {
  const profiles = new Map<string, PresentationPreferenceProfile>();
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

export function getPresentationPreferenceRegistryPath(): string {
  return getRegistryPath();
}

export function getPersonalPresentationPreferenceRegistryPath(): string {
  return (
    getRegisteredEnvText('KYBERION_PERSONAL_PRESENTATION_PREFERENCE_REGISTRY_PATH')?.trim() ||
    DEFAULT_PERSONAL_OVERLAY_PATH
  );
}

export function resetPresentationPreferenceRegistryCache(): void {
  registryCacheKey = null;
  registryCache = null;
}

export function getPresentationPreferenceRegistry(): PresentationPreferenceRegistry {
  const registryPath = getRegistryPath();
  const overlayPath = getPersonalOverlayPath();
  const cacheKey = overlayPath ? `${registryPath}::${overlayPath}` : registryPath;
  if (registryCacheKey === cacheKey && registryCache) return registryCache;

  const base = loadRegistryFromPath(registryPath);
  if (!overlayPath || !safeExistsSync(overlayPath)) {
    registryCacheKey = cacheKey;
    registryCache = base;
    return base;
  }

  const overlay = loadRegistryFromPath(overlayPath);
  const merged = mergeRegistries(base, overlay);
  registryCacheKey = cacheKey;
  registryCache = merged;
  return merged;
}

export function getPresentationPreferenceProfile(
  profileId?: string
): PresentationPreferenceProfile {
  const registry = getPresentationPreferenceRegistry();
  const resolvedProfileId = profileId || registry.default_profile_id;
  return (
    registry.profiles.find((profile) => profile.profile_id === resolvedProfileId) ||
    registry.profiles.find((profile) => profile.profile_id === registry.default_profile_id) ||
    registry.profiles[0]
  );
}

export function writePresentationPreferenceRegistry(
  registry: PresentationPreferenceRegistry,
  registryPath = getRegistryPath()
): string {
  const validated = defineCatalog<PresentationPreferenceRegistry>({
    id: 'presentation-preference-registry',
    path: registryPath,
    schema: REGISTRY_SCHEMA_PATH,
  }).validate(registry, registryPath);
  safeWriteFile(registryPath, JSON.stringify(validated, null, 2), { mkdir: true });
  resetPresentationPreferenceRegistryCache();
  return registryPath;
}

export function registerPresentationPreferenceProfile(
  profile: PresentationPreferenceProfile,
  registryPath = getPersonalPresentationPreferenceRegistryPath()
): string {
  const existing = safeExistsSync(registryPath)
    ? loadRegistryFromPath(registryPath)
    : {
        version: '1.0.0',
        default_profile_id: profile.profile_id,
        profiles: [],
      };

  const profiles = new Map<string, PresentationPreferenceProfile>();
  for (const entry of existing.profiles) profiles.set(entry.profile_id, entry);
  profiles.set(profile.profile_id, profile);

  const nextDefaultProfileId = profiles.has(existing.default_profile_id)
    ? existing.default_profile_id
    : profile.profile_id;

  return writePresentationPreferenceRegistry(
    {
      ...existing,
      default_profile_id: nextDefaultProfileId,
      profiles: [...profiles.values()],
    },
    registryPath
  );
}
