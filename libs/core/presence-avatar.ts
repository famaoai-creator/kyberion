import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { safeJsonParse } from './validators.js';

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

const DEFAULT_REGISTRY_PATH = pathResolver.knowledge('public/presence/avatar-profiles.json');

const DEFAULT_PROFILE: PresenceAvatarProfile = {
  agentId: 'default-surface-agent',
  displayName: 'Surface Agent',
  defaultAvatarAssetPath: '/assets/avatars/kyberion-neutral.svg',
  expressionAvatarMap: {
    neutral: '/assets/avatars/kyberion-neutral.svg',
  },
};

let cachedRegistryPath: string | null = null;
let cachedProfiles: Record<string, PresenceAvatarProfile> | null = null;
let cachedAliases: Record<string, string> | null = null;
let cachedDefaultAgentId: string | null = null;

function getRegistryPath(): string {
  const overridePath = process.env.KYBERION_PRESENCE_AVATAR_PROFILES_PATH?.trim();
  return overridePath || DEFAULT_REGISTRY_PATH;
}

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
  const registryPath = getRegistryPath();
  if (cachedProfiles && cachedAliases && cachedDefaultAgentId && cachedRegistryPath === registryPath) {
    return {
      defaultAgentId: cachedDefaultAgentId,
      aliases: cachedAliases,
      profiles: cachedProfiles,
    };
  }

  const fallback = buildFallbackRegistry();
  if (!safeExistsSync(registryPath)) {
    cachedRegistryPath = registryPath;
    cachedProfiles = fallback.profiles;
    cachedAliases = fallback.aliases;
    cachedDefaultAgentId = fallback.defaultAgentId;
    return fallback;
  }

  try {
    const raw = safeReadFile(registryPath, { encoding: 'utf8' }) as string;
    const parsed = safeJsonParse<PresenceAvatarProfileRegistry>(raw, 'presence avatar profile registry');
    const profiles = Object.fromEntries(
      (parsed.profiles || [])
        .filter((profile) => profile && typeof profile.agentId === 'string' && profile.agentId.length > 0)
        .map((profile) => [profile.agentId, profile]),
    );
    const firstProfileAgentId = Object.keys(profiles)[0];
    const defaultAgentId =
      typeof parsed.defaultAgentId === 'string' && parsed.defaultAgentId in profiles
        ? parsed.defaultAgentId
        : firstProfileAgentId || fallback.defaultAgentId;
    const aliases = {
      ...fallback.aliases,
      ...(parsed.aliases || {}),
    };
    cachedRegistryPath = registryPath;
    cachedProfiles = {
      ...fallback.profiles,
      ...profiles,
    };
    cachedAliases = aliases;
    cachedDefaultAgentId = defaultAgentId;
    return {
      defaultAgentId,
      aliases,
      profiles: cachedProfiles,
    };
  } catch (error: any) {
    logger.warn(`[PRESENCE_AVATAR] Failed to load registry at ${registryPath}: ${error.message}`);
    cachedRegistryPath = registryPath;
    cachedProfiles = fallback.profiles;
    cachedAliases = fallback.aliases;
    cachedDefaultAgentId = fallback.defaultAgentId;
    return fallback;
  }
}

export function resetPresenceAvatarRegistryCache(): void {
  cachedRegistryPath = null;
  cachedProfiles = null;
  cachedAliases = null;
  cachedDefaultAgentId = null;
}

export function getPresenceAvatarProfile(agentId?: string): PresenceAvatarProfile {
  const registry = loadRegistry();
  const requestedAgentId = typeof agentId === 'string' && agentId.length > 0 ? agentId : registry.defaultAgentId;
  const resolvedAgentId = registry.aliases[requestedAgentId] || requestedAgentId;
  const resolvedProfile = registry.profiles[resolvedAgentId];

  if (resolvedProfile) return resolvedProfile;
  return {
    ...DEFAULT_PROFILE,
    agentId: requestedAgentId,
    displayName: requestedAgentId,
  };
}
