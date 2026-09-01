import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { assertSafeRepositoryPath, safeExistsSync } from './secure-io.js';
import { getRegisteredEnvText } from './foundation/env.js';

export interface PresenceAvatarProfile {
  agentId: string;
  displayName: string;
  defaultAvatarAssetPath: string;
  expressionAvatarMap: Record<string, string>;
}

interface PresenceAvatarProfileRegistry {
  defaultAgentId?: string;
  aliases?: Record<string, string>;
  profiles?: PresenceAvatarProfile[];
}

const DEFAULT_REGISTRY_PATH = pathResolver.knowledge('product/presence/avatar-profiles.json');
const REGISTRY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/presence-avatar-profiles.schema.json'
);

const DEFAULT_PROFILE: PresenceAvatarProfile = {
  agentId: 'default-surface-agent',
  displayName: 'Surface Agent',
  defaultAvatarAssetPath: '/assets/avatars/kyberion-neutral.svg',
  expressionAvatarMap: {
    neutral: '/assets/avatars/kyberion-neutral.svg',
  },
};

const FALLBACK_REGISTRY: PresenceAvatarProfileRegistry = {
  defaultAgentId: DEFAULT_PROFILE.agentId,
  aliases: {},
  profiles: [DEFAULT_PROFILE],
};

let cachedRegistryPath: string | null = null;
let cachedProfiles: Record<string, PresenceAvatarProfile> | null = null;
let cachedAliases: Record<string, string> | null = null;
let cachedDefaultAgentId: string | null = null;

function getRegistryPath(): string {
  const overridePath = getRegisteredEnvText('KYBERION_PRESENCE_AVATAR_PROFILES_PATH')?.trim();
  return assertSafeRepositoryPath(overridePath || DEFAULT_REGISTRY_PATH, {
    allowMissingLeaf: true,
  });
}

const registryCatalog = defineCatalog<PresenceAvatarProfileRegistry>({
  id: 'presence-avatar-profiles',
  path: getRegistryPath,
  schema: REGISTRY_SCHEMA_PATH,
  fallback: FALLBACK_REGISTRY,
  fallbackOnInvalid: true,
  onFallback(error) {
    const registryPath = getRegistryPath();
    if (safeExistsSync(registryPath)) {
      logger.warn(
        `[PRESENCE_AVATAR] Failed to load registry at ${registryPath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  },
});

function buildFallbackRegistry(): {
  defaultAgentId: string;
  aliases: Record<string, string>;
  profiles: Record<string, PresenceAvatarProfile>;
} {
  return {
    defaultAgentId: DEFAULT_PROFILE.agentId,
    aliases: {},
    profiles: {
      [DEFAULT_PROFILE.agentId]: DEFAULT_PROFILE,
    },
  };
}

function loadRegistry(): {
  defaultAgentId: string;
  aliases: Record<string, string>;
  profiles: Record<string, PresenceAvatarProfile>;
} {
  let registryPath: string;
  try {
    registryPath = getRegistryPath();
  } catch (error) {
    logger.warn(
      `[PRESENCE_AVATAR] Unsafe registry path; using fallback: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return buildFallbackRegistry();
  }
  if (
    cachedProfiles &&
    cachedAliases &&
    cachedDefaultAgentId &&
    cachedRegistryPath === registryPath
  ) {
    return {
      defaultAgentId: cachedDefaultAgentId,
      aliases: cachedAliases,
      profiles: cachedProfiles,
    };
  }

  const parsed = registryCatalog.load();
  const profiles = Object.fromEntries(
    (parsed.profiles || []).map((profile) => [profile.agentId, profile])
  );
  const firstProfileAgentId = Object.keys(profiles)[0];
  const defaultAgentId =
    typeof parsed.defaultAgentId === 'string' && parsed.defaultAgentId in profiles
      ? parsed.defaultAgentId
      : firstProfileAgentId || FALLBACK_REGISTRY.defaultAgentId!;
  const aliases = {
    ...FALLBACK_REGISTRY.aliases,
    ...(parsed.aliases || {}),
  };
  cachedRegistryPath = registryPath;
  cachedProfiles = {
    ...buildFallbackRegistry().profiles,
    ...profiles,
  };
  cachedAliases = aliases;
  cachedDefaultAgentId = defaultAgentId;
  return {
    defaultAgentId,
    aliases,
    profiles: cachedProfiles,
  };
}

export function _resetPresenceAvatarRegistryCacheForTests(): void {
  cachedRegistryPath = null;
  cachedProfiles = null;
  cachedAliases = null;
  cachedDefaultAgentId = null;
}

export function getPresenceAvatarProfile(agentId?: string): PresenceAvatarProfile {
  const registry = loadRegistry();
  const requestedAgentId =
    typeof agentId === 'string' && agentId.length > 0 ? agentId : registry.defaultAgentId;
  const resolvedAgentId = registry.aliases[requestedAgentId] || requestedAgentId;
  const resolvedProfile = registry.profiles[resolvedAgentId];

  if (resolvedProfile) return resolvedProfile;
  return {
    ...DEFAULT_PROFILE,
    agentId: requestedAgentId,
    displayName: requestedAgentId,
  };
}
