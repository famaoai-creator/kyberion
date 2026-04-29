import AjvModule, { type ValidateFunction } from 'ajv';
import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { safeExistsSync, safeReadFile, safeWriteFile } from './secure-io.js';
import {
  type PresentationPreferenceProfile,
} from './src/types/presentation-preference-profile.js';

export interface PresentationPreferenceRegistry {
  version: string;
  default_profile_id: string;
  profiles: PresentationPreferenceProfile[];
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const REGISTRY_SCHEMA_PATH = pathResolver.knowledge(
  'public/schemas/presentation-preference-registry.schema.json'
);
const DEFAULT_REGISTRY_PATH = pathResolver.knowledge(
  'public/governance/presentation-preference-registry.json'
);
const DEFAULT_PERSONAL_OVERLAY_PATH = pathResolver.knowledge(
  'personal/orchestration/presentation-preference-registry.json'
);

const FALLBACK_REGISTRY: PresentationPreferenceRegistry = {
  version: 'fallback',
  default_profile_id: 'business-deck-default',
  profiles: [
    {
      kind: 'presentation-preference-profile',
      profile_id: 'business-deck-default',
      scope: 'default',
      theme_selection_policy: {
        decision_mode: 'ask_when_uncertain',
        ask_user_when: [
          'audience_unclear',
          'brand_alignment_unclear',
          'chart_density_unclear',
          'executive_tone_unclear',
          'new_deck_category',
          'user_requested_precheck',
        ],
        default_theme_hint: 'executive_clean',
      },
      brief_question_sets: [
        {
          label: 'Proposal deck',
          deck_purposes: ['proposal'],
          questions: [
            '誰に見せる資料ですか?',
            '最終的に何を決めたいですか?',
            '何枚くらいでまとめたいですか?',
          ],
        },
      ],
      theme_sets: [
        {
          label: 'Executive clean',
          deck_purposes: ['proposal', 'briefing'],
          theme_hint: 'executive_clean',
          design_traits: ['executive', 'minimal', 'brand_aligned'],
        },
      ],
    },
  ],
};

let registryCacheKey: string | null = null;
let registryCache: PresentationPreferenceRegistry | null = null;
let registryValidateFn: ValidateFunction | null = null;

function ensureRegistryValidator(): ValidateFunction {
  if (registryValidateFn) return registryValidateFn;
  registryValidateFn = compileSchemaFromPath(ajv, REGISTRY_SCHEMA_PATH);
  return registryValidateFn;
}

function errorsFrom(validate: ValidateFunction): string[] {
  return (validate.errors || []).map((error) =>
    `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
  );
}

function loadRegistryFromPath(registryPath: string): PresentationPreferenceRegistry {
  const parsed = JSON.parse(
    safeReadFile(registryPath, { encoding: 'utf8' }) as string
  ) as PresentationPreferenceRegistry;
  const validate = ensureRegistryValidator();
  if (!validate(parsed)) {
    throw new Error(
      `Invalid presentation preference registry at ${registryPath}: ${errorsFrom(validate).join('; ')}`
    );
  }
  return parsed;
}

function getRegistryPath(): string {
  return process.env.KYBERION_PRESENTATION_PREFERENCE_REGISTRY_PATH?.trim() || DEFAULT_REGISTRY_PATH;
}

function getPersonalOverlayPath(): string | null {
  if (process.env.KYBERION_PRESENTATION_PREFERENCE_REGISTRY_PATH?.trim()) return null;
  return (
    process.env.KYBERION_PERSONAL_PRESENTATION_PREFERENCE_REGISTRY_PATH?.trim() ||
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
    process.env.KYBERION_PERSONAL_PRESENTATION_PREFERENCE_REGISTRY_PATH?.trim() ||
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

  if (!safeExistsSync(registryPath)) {
    registryCacheKey = cacheKey;
    registryCache = FALLBACK_REGISTRY;
    return registryCache;
  }

  try {
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
  } catch (error: any) {
    const target = overlayPath ? `${registryPath} or overlay ${overlayPath}` : registryPath;
    logger.warn(`[PRESENTATION_PREFERENCE_REGISTRY] Failed to load registry at ${target}: ${error.message}`);
    registryCacheKey = cacheKey;
    registryCache = FALLBACK_REGISTRY;
    return registryCache;
  }
}

export function getPresentationPreferenceProfile(
  profileId?: string
): PresentationPreferenceProfile {
  const registry = getPresentationPreferenceRegistry();
  const resolvedProfileId = profileId || registry.default_profile_id;
  return (
    registry.profiles.find((profile) => profile.profile_id === resolvedProfileId) ||
    registry.profiles.find((profile) => profile.profile_id === registry.default_profile_id) ||
    FALLBACK_REGISTRY.profiles[0]
  );
}

export function writePresentationPreferenceRegistry(
  registry: PresentationPreferenceRegistry,
  registryPath = getRegistryPath()
): string {
  safeWriteFile(registryPath, JSON.stringify(registry, null, 2), { mkdir: true });
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
