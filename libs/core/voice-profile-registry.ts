import * as path from 'node:path';
import { logger } from './core.js';
import * as customerResolver from './customer-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeCopyFileSync,
  safeExistsSync,
  safeReaddir,
  safeMkdir,
  safeRmSync,
  safeWriteFile,
} from './secure-io.js';
import { getRegisteredEnvText } from './foundation/env.js';

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

const DEFAULT_REGISTRY_PATH = pathResolver.knowledge(
  'product/governance/voice-profile-registry.json'
);
const VOICE_PROFILE_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/voice-profile-registry.schema.json'
);
const VOICE_PROFILE_OVERLAY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/voice-profile-registry-overlay.schema.json'
);
const DEFAULT_REGISTRY_DIR = pathResolver.knowledge('product/governance/voice-profiles');
const DEFAULT_CUSTOMER_OVERLAY_PATH = 'voice/profile-registry.json';
const DEFAULT_PERSONAL_OVERLAY_PATH = pathResolver.knowledge(
  'personal/voice/profile-registry.json'
);

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
    profiles: [...registry.profiles].sort((left, right) =>
      left.profile_id.localeCompare(right.profile_id)
    ),
  };
}

function requireSafePathSegment(value: string, label: string): string {
  const normalized = String(value || '').trim();
  if (!normalized || normalized === '.' || normalized === '..' || /[\\/]/u.test(normalized)) {
    throw new Error(`${label} must be a single safe path segment`);
  }
  return normalized;
}

function readRegistryFile(
  registryPath: string,
  label: string,
  schemaPath = VOICE_PROFILE_SCHEMA_PATH
): VoiceProfileRegistry {
  const safeRegistryPath = assertSafeRepositoryPath(registryPath);
  try {
    return defineCatalog<VoiceProfileRegistry>({
      id: 'voice-profile-registry',
      path: safeRegistryPath,
      schema: schemaPath,
    }).load();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid ${label}: ${error.message}`);
    }
    throw error;
  }
}

function loadRegistryDirectory(
  dirPath: string,
  fallbackDefaultProfileId = ''
): VoiceProfileRegistry | null {
  const safeDirPath = assertSafeRepositoryPath(dirPath, { allowMissingLeaf: true });
  if (!safeExistsSync(safeDirPath)) return null;
  const files = safeReaddir(safeDirPath)
    .filter((entry) => entry.endsWith('.json'))
    .sort();
  if (!files.length) return null;

  const profiles = new Map<string, VoiceProfileRecord>();
  let defaultProfileId = '';
  for (const file of files) {
    const fullPath = path.join(safeDirPath, file);
    const payload = readRegistryFile(fullPath, `voice profile registry item ${file}`);
    const records = payload.profiles || [];
    if (records.length !== 1) {
      throw new Error(`Voice profile file ${file} must contain exactly one profile`);
    }
    const profile = records[0];
    if (profile.profile_id !== file.replace(/\.json$/i, '')) {
      throw new Error(
        `Voice profile file ${file} must match its profile id (${profile.profile_id})`
      );
    }
    profiles.set(profile.profile_id, profile);
    if (!defaultProfileId && payload.default_profile_id) {
      defaultProfileId = payload.default_profile_id;
    }
  }

  const resolvedDefault =
    fallbackDefaultProfileId && profiles.has(fallbackDefaultProfileId)
      ? fallbackDefaultProfileId
      : defaultProfileId && profiles.has(defaultProfileId)
        ? defaultProfileId
        : (profiles.keys().next().value as string | undefined);

  return resolvedDefault
    ? sortRegistry({
        version: '1.0.0',
        default_profile_id: resolvedDefault,
        profiles: [...profiles.values()],
      })
    : null;
}

function writeRegistryDirectory(dirPath: string, registry: VoiceProfileRegistry): void {
  const safeDirPath = assertSafeRepositoryPath(dirPath, { allowMissingLeaf: true });
  safeMkdir(safeDirPath, { recursive: true });
  const nextIds = new Set(registry.profiles.map((profile) => profile.profile_id));
  const existing = safeExistsSync(safeDirPath)
    ? safeReaddir(safeDirPath).filter((entry) => entry.endsWith('.json'))
    : [];
  for (const file of existing) {
    const profileId = file.replace(/\.json$/i, '');
    if (!nextIds.has(profileId)) {
      safeRmSync(path.join(safeDirPath, file), { force: true });
    }
  }
  for (const profile of registry.profiles) {
    const profileId = requireSafePathSegment(profile.profile_id, 'voice profile profile_id');
    const payload = {
      version: registry.version,
      default_profile_id:
        registry.default_profile_id === profile.profile_id
          ? profile.profile_id
          : registry.default_profile_id,
      profiles: [profile],
    };
    const profilePath = path.join(safeDirPath, `${profileId}.json`);
    safeWriteFile(
      assertSafeRepositoryPath(profilePath, { allowMissingLeaf: true }),
      JSON.stringify(payload, null, 2)
    );
  }
}

function getRegistryPath(): string {
  return (
    getRegisteredEnvText('KYBERION_VOICE_PROFILE_REGISTRY_PATH')?.trim() || DEFAULT_REGISTRY_PATH
  );
}

function getRegistryDir(): string {
  return (
    getRegisteredEnvText('KYBERION_VOICE_PROFILE_REGISTRY_DIR')?.trim() || DEFAULT_REGISTRY_DIR
  );
}

function getPersonalOverlayPath(): string | null {
  if (getRegisteredEnvText('KYBERION_VOICE_PROFILE_REGISTRY_PATH')?.trim()) return null;
  const configured =
    getRegisteredEnvText('KYBERION_PERSONAL_VOICE_PROFILE_REGISTRY_PATH')?.trim() ||
    DEFAULT_PERSONAL_OVERLAY_PATH;
  const safePath = assertSafeRepositoryPath(configured, { allowMissingLeaf: true });
  return safeExistsSync(safePath) ? safePath : null;
}

function getCustomerOverlayPath(): string | null {
  if (getRegisteredEnvText('KYBERION_VOICE_PROFILE_REGISTRY_PATH')?.trim()) return null;
  const configured = customerResolver.customerRoot(DEFAULT_CUSTOMER_OVERLAY_PATH);
  if (!configured) return null;
  const safePath = assertSafeRepositoryPath(configured, { allowMissingLeaf: true });
  return safeExistsSync(safePath) ? safePath : null;
}

export function getPersonalVoiceProfileRegistryPath(): string {
  return (
    getRegisteredEnvText('KYBERION_PERSONAL_VOICE_PROFILE_REGISTRY_PATH')?.trim() ||
    DEFAULT_PERSONAL_OVERLAY_PATH
  );
}

function mergeRegistries(
  base: VoiceProfileRegistry,
  overlay: VoiceProfileRegistry
): VoiceProfileRegistry {
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

function emptyRegistry(defaultProfileId = ''): VoiceProfileRegistry {
  return {
    version: '1.0.0',
    default_profile_id: defaultProfileId,
    profiles: [],
  };
}

function readRegistryFileIfPresent(
  registryPath: string,
  label: string,
  schemaPath = VOICE_PROFILE_SCHEMA_PATH
): VoiceProfileRegistry | null {
  const safePath = assertSafeRepositoryPath(registryPath, { allowMissingLeaf: true });
  if (!safeExistsSync(safePath)) return null;
  return readRegistryFile(safePath, label, schemaPath);
}

function loadBaseVoiceProfileRegistry(): VoiceProfileRegistry {
  const registryPath = getRegistryPath();
  const safeRegistryPath = assertSafeRepositoryPath(registryPath, { allowMissingLeaf: true });
  const useCanonicalDirectory =
    !getRegisteredEnvText('KYBERION_VOICE_PROFILE_REGISTRY_PATH')?.trim() ||
    registryPath === DEFAULT_REGISTRY_PATH;
  const registryDir = useCanonicalDirectory ? getRegistryDir() : null;

  if (!safeExistsSync(safeRegistryPath)) {
    return (
      (useCanonicalDirectory ? loadRegistryDirectory(registryDir || getRegistryDir()) : null) ||
      FALLBACK_REGISTRY
    );
  }

  let parsed: VoiceProfileRegistry;
  try {
    parsed = readRegistryFile(safeRegistryPath, 'voice profile registry');
  } catch (error: any) {
    logger.warn(
      `[VOICE_PROFILE_REGISTRY] Failed to load base registry at ${registryPath}: ${error.message}`
    );
    return FALLBACK_REGISTRY;
  }

  return (
    (useCanonicalDirectory
      ? loadRegistryDirectory(registryDir || getRegistryDir(), parsed.default_profile_id)
      : null) || parsed
  );
}

export function getWritableVoiceProfileRegistryForTier(tier: VoiceProfileRecord['tier']): {
  registry: VoiceProfileRegistry;
  registryPath: string;
} {
  if (
    tier === 'personal' &&
    !getRegisteredEnvText('KYBERION_VOICE_PROFILE_REGISTRY_PATH')?.trim()
  ) {
    const registryPath = getPersonalVoiceProfileRegistryPath();
    return {
      registry:
        readRegistryFileIfPresent(
          registryPath,
          'personal voice profile registry',
          VOICE_PROFILE_OVERLAY_SCHEMA_PATH
        ) || emptyRegistry(),
      registryPath,
    };
  }

  return {
    registry: loadBaseVoiceProfileRegistry(),
    registryPath: getRegistryPath(),
  };
}

function resolveVoiceProfileSampleStoreDir(
  profileId: string,
  tier: VoiceProfileRecord['tier']
): string | null {
  const normalizedProfileId = String(profileId || '').trim();
  requireSafePathSegment(normalizedProfileId, 'voice profile profile_id');

  return assertSafeRepositoryPath(
    pathResolver.shared(`runtime/voice-profiles/${normalizedProfileId}`),
    { allowMissingLeaf: true }
  );
}

export function materializeVoiceProfileSampleRefs(
  profile: Pick<VoiceProfileRecord, 'profile_id' | 'tier'>,
  samples: Array<{ sample_id: string; path: string }>
): string[] {
  const targetDir = resolveVoiceProfileSampleStoreDir(profile.profile_id, profile.tier);
  safeMkdir(targetDir, { recursive: true });
  return samples.map((sample) => {
    const sampleId = requireSafePathSegment(sample.sample_id, 'voice sample sample_id');
    const sourcePath = assertSafeRepositoryPath(String(sample.path || '').trim(), {
      allowMissingLeaf: true,
    });
    if (!safeExistsSync(sourcePath)) {
      throw new Error(`voice sample does not exist (${sample.path})`);
    }

    const ext = path.extname(sourcePath).replace(/^\./u, '').toLowerCase() || 'wav';
    const targetPath = assertSafeRepositoryPath(path.join(targetDir, `${sampleId}.${ext}`), {
      allowMissingLeaf: true,
    });
    if (sourcePath !== targetPath) {
      safeCopyFileSync(sourcePath, targetPath);
      const transcriptPath = assertSafeRepositoryPath(`${sourcePath}.transcript.txt`, {
        allowMissingLeaf: true,
      });
      if (safeExistsSync(transcriptPath)) {
        safeCopyFileSync(
          transcriptPath,
          assertSafeRepositoryPath(`${targetPath}.transcript.txt`, { allowMissingLeaf: true })
        );
      }
    }
    return targetPath;
  });
}

export function resetVoiceProfileRegistryCache(): void {
  cachedRegistryPath = null;
  cachedRegistry = null;
}

export function getVoiceProfileRegistry(): VoiceProfileRegistry {
  const registryPath = getRegistryPath();
  const safeRegistryPath = assertSafeRepositoryPath(registryPath, { allowMissingLeaf: true });
  const customerOverlayPath = getCustomerOverlayPath();
  const overlayPath = getPersonalOverlayPath();
  const useCanonicalDirectory =
    !getRegisteredEnvText('KYBERION_VOICE_PROFILE_REGISTRY_PATH')?.trim() ||
    registryPath === DEFAULT_REGISTRY_PATH;
  const registryDir = useCanonicalDirectory ? getRegistryDir() : null;
  const cacheKey = [registryPath, registryDir, customerOverlayPath, overlayPath]
    .filter(Boolean)
    .join('::');
  if (cachedRegistryPath === cacheKey && cachedRegistry) return cachedRegistry;

  if (!safeExistsSync(safeRegistryPath)) {
    const directoryRegistry = useCanonicalDirectory
      ? loadRegistryDirectory(registryDir || getRegistryDir())
      : null;
    cachedRegistryPath = cacheKey;
    cachedRegistry = directoryRegistry || FALLBACK_REGISTRY;
    return cachedRegistry;
  }

  let parsed: VoiceProfileRegistry;
  try {
    parsed = readRegistryFile(safeRegistryPath, 'voice profile registry');
  } catch (error: any) {
    logger.warn(
      `[VOICE_PROFILE_REGISTRY] Failed to load base registry at ${registryPath}: ${error.message}`
    );
    cachedRegistryPath = cacheKey;
    cachedRegistry = FALLBACK_REGISTRY;
    return cachedRegistry;
  }

  const directoryRegistry = useCanonicalDirectory
    ? loadRegistryDirectory(registryDir || getRegistryDir(), parsed.default_profile_id)
    : null;
  const baseRegistry = directoryRegistry || parsed;

  let customerOverlay: VoiceProfileRegistry | null = null;
  if (customerOverlayPath) {
    try {
      customerOverlay = readRegistryFile(
        customerOverlayPath,
        'customer voice profile registry',
        VOICE_PROFILE_OVERLAY_SCHEMA_PATH
      );
    } catch (error: any) {
      logger.warn(
        `[VOICE_PROFILE_REGISTRY] Customer overlay unavailable (${customerOverlayPath}): ${error.message} — using base registry only`
      );
    }
  }

  if (!overlayPath && !customerOverlay) {
    cachedRegistryPath = cacheKey;
    cachedRegistry = baseRegistry;
    return baseRegistry;
  }

  try {
    const personalOverlay = overlayPath
      ? readRegistryFile(
          overlayPath,
          'personal voice profile registry',
          VOICE_PROFILE_OVERLAY_SCHEMA_PATH
        )
      : null;
    const baseWithPersonal = personalOverlay
      ? mergeRegistries(baseRegistry, personalOverlay)
      : baseRegistry;
    const merged = customerOverlay
      ? mergeRegistries(baseWithPersonal, customerOverlay)
      : baseWithPersonal;
    cachedRegistryPath = cacheKey;
    cachedRegistry = merged;
    return merged;
  } catch (error: any) {
    logger.warn(
      `[VOICE_PROFILE_REGISTRY] Personal overlay unavailable (${overlayPath}): ${error.message} — using base registry only`
    );
    cachedRegistryPath = cacheKey;
    cachedRegistry = customerOverlay
      ? mergeRegistries(baseRegistry, customerOverlay)
      : baseRegistry;
    return cachedRegistry;
  }
}

export function listVoiceProfiles(
  status: VoiceProfileRecord['status'] | 'all' = 'active'
): VoiceProfileRecord[] {
  const registry = getVoiceProfileRegistry();
  if (status === 'all') return registry.profiles;
  return registry.profiles.filter((profile) => profile.status === status);
}

export function getVoiceProfileRecord(profileId?: string): VoiceProfileRecord {
  const registry = getVoiceProfileRegistry();
  const resolvedProfileId = profileId || registry.default_profile_id;
  return (
    registry.profiles.find((profile) => profile.profile_id === resolvedProfileId) ||
    registry.profiles.find((profile) => profile.profile_id === registry.default_profile_id) ||
    FALLBACK_REGISTRY.profiles[0]
  );
}

export function writeVoiceProfileRegistry(
  registry: VoiceProfileRegistry,
  registryPath = getRegistryPath()
): string {
  const safeRegistryPath = assertSafeRepositoryPath(registryPath, { allowMissingLeaf: true });
  const normalized = sortRegistry(registry);
  safeWriteFile(safeRegistryPath, JSON.stringify(normalized, null, 2));
  if (safeRegistryPath === DEFAULT_REGISTRY_PATH || safeRegistryPath === getRegistryPath()) {
    writeRegistryDirectory(getRegistryDir(), normalized);
  }
  cachedRegistryPath = null;
  cachedRegistry = null;
  return safeRegistryPath;
}
