import * as path from 'node:path';
import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeReadFile } from './secure-io.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { resolveActiveProfileRoot } from './profile-root.js';
import { loadPersonalIdentityAtPath } from './personal-identity-state.js';

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

// ---------------------------------------------------------------------------
// PA-10: personal-tier avatar overlay.
//
// `scripts/generate_avatar.ts` writes the user's generated set to
// `<profileRoot>/avatar/<expression>.png` + `avatar-profile.json`. The product
// registry above stays the only source for agent avatars; this overlay is
// read from the active profile root only, is never copied to public assets,
// and is served exclusively through authenticated routes
// (`/api/me/avatar/:expression`).
// ---------------------------------------------------------------------------

/**
 * Frames a set may contain — also the route allow-list. Mirrors the
 * `ui:talking-avatar` `images` keys; `blink` is optional (not generated by
 * default).
 */
export const AVATAR_EXPRESSIONS = [
  'neutral',
  'joy',
  'thinking',
  'listening',
  'speaking',
  'mouth_open',
  'blink',
] as const;
export type AvatarExpression = (typeof AVATAR_EXPRESSIONS)[number];
/** What `scripts/generate_avatar.ts` generates unless `--expressions` says otherwise. */
export const DEFAULT_GENERATED_AVATAR_EXPRESSIONS: readonly AvatarExpression[] = [
  'neutral',
  'joy',
  'thinking',
  'listening',
  'speaking',
  'mouth_open',
];

export const AVATAR_DIRNAME = 'avatar';
export const AVATAR_PROFILE_FILENAME = 'avatar-profile.json';
/** Value of `my-identity.json` `avatar_profile` once the user adopts a generated set. */
export const AVATAR_PROFILE_POINTER = `${AVATAR_DIRNAME}/${AVATAR_PROFILE_FILENAME}`;

/** Mouth anchor as fractions of the frame (0..1): centre x/y and width. */
export interface AvatarMouthAnchor {
  x: number;
  y: number;
  width: number;
}

/** Default guess for a centred head-and-shoulders portrait (= `ui:talking-avatar` default). */
export const DEFAULT_AVATAR_MOUTH_ANCHOR: AvatarMouthAnchor = { x: 0.5, y: 0.68, width: 0.22 };

export interface PersonalAvatarProfileFile {
  version: 1;
  /** Expression → file name relative to the avatar directory. */
  images: { neutral: string } & Partial<Record<AvatarExpression, string>>;
  mouth: AvatarMouthAnchor;
  generated_at: string;
  provider_id: string;
  style: string;
}

export interface PersonalAvatarSet {
  profile: PersonalAvatarProfileFile;
  /** Expression → absolute file path (only frames that exist on disk). */
  files: Partial<Record<AvatarExpression, string>>;
}

const AVATAR_FILE_NAME = /^[a-z0-9_-]{1,64}\.(png|jpe?g|webp)$/u;

export function isAvatarExpression(value: unknown): value is AvatarExpression {
  return typeof value === 'string' && (AVATAR_EXPRESSIONS as readonly string[]).includes(value);
}

/** Image type from magic bytes (png / jpeg / webp), or null. */
export function sniffAvatarImageContentType(
  bytes: Buffer
): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function fraction(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : fallback;
}

/** Validate a parsed avatar-profile.json; unknown keys and unsafe file names are dropped. */
export function parsePersonalAvatarProfile(value: unknown): PersonalAvatarProfileFile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const rawImages = record.images;
  if (!rawImages || typeof rawImages !== 'object' || Array.isArray(rawImages)) return null;
  const images: Partial<Record<AvatarExpression, string>> = {};
  for (const expression of AVATAR_EXPRESSIONS) {
    const file = (rawImages as Record<string, unknown>)[expression];
    if (typeof file === 'string' && AVATAR_FILE_NAME.test(file)) images[expression] = file;
  }
  if (!images.neutral) return null;
  const mouth =
    record.mouth && typeof record.mouth === 'object' && !Array.isArray(record.mouth)
      ? (record.mouth as Record<string, unknown>)
      : {};
  return {
    version: 1,
    images: images as PersonalAvatarProfileFile['images'],
    mouth: {
      x: fraction(mouth.x, DEFAULT_AVATAR_MOUTH_ANCHOR.x),
      y: fraction(mouth.y, DEFAULT_AVATAR_MOUTH_ANCHOR.y),
      width: fraction(mouth.width, DEFAULT_AVATAR_MOUTH_ANCHOR.width),
    },
    generated_at: typeof record.generated_at === 'string' ? record.generated_at : '',
    provider_id: typeof record.provider_id === 'string' ? record.provider_id : 'unknown',
    style: typeof record.style === 'string' ? record.style : '',
  };
}

function regularFileInside(dir: string, fileName: string): string | null {
  const candidate = path.join(dir, fileName);
  if (path.dirname(candidate) !== dir) return null;
  try {
    const safe = assertSafeRepositoryPath(candidate, { allowMissingLeaf: true });
    return safeExistsSync(safe) && safeLstat(safe).isFile() ? safe : null;
  } catch {
    return null;
  }
}

/**
 * The generated set under `<profileRoot>/avatar/` (draft or adopted), or null.
 * Callers run inside the personal-tier execution context of their surface.
 */
export function loadPersonalAvatarSet(
  profileRoot: string = resolveActiveProfileRoot()
): PersonalAvatarSet | null {
  const dir = path.join(path.resolve(profileRoot), AVATAR_DIRNAME);
  const profilePath = regularFileInside(dir, AVATAR_PROFILE_FILENAME);
  if (!profilePath) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(safeReadFile(profilePath, { encoding: 'utf8' })));
  } catch {
    return null;
  }
  const profile = parsePersonalAvatarProfile(parsed);
  if (!profile) return null;
  const files: Partial<Record<AvatarExpression, string>> = {};
  for (const expression of AVATAR_EXPRESSIONS) {
    const fileName = profile.images[expression];
    const file = fileName ? regularFileInside(dir, fileName) : null;
    if (file) files[expression] = file;
  }
  if (!files.neutral) return null;
  return { profile, files };
}

/** Bytes + sniffed content type of one frame; null for unknown / missing / non-image files. */
export function readPersonalAvatarAsset(
  expression: string,
  profileRoot?: string
): { bytes: Buffer; contentType: string } | null {
  if (!isAvatarExpression(expression)) return null;
  const set = loadPersonalAvatarSet(profileRoot);
  const file = set?.files[expression];
  if (!file) return null;
  const bytes = safeReadFile(file, { encoding: null }) as Buffer;
  const contentType = sniffAvatarImageContentType(bytes);
  return contentType ? { bytes, contentType } : null;
}

/** Wire shape for `ui:talking-avatar` (`images` URLs + `mouth` anchor). */
export interface PersonalAvatarWire {
  images: Partial<Record<AvatarExpression, string>> & { neutral: string };
  mouth: AvatarMouthAnchor;
  generated_at: string;
  provider_id: string;
  adopted: boolean;
}

function isAdopted(profileRoot: string): boolean {
  const identityPath = path.join(path.resolve(profileRoot), 'my-identity.json');
  try {
    const safe = assertSafeRepositoryPath(identityPath, { allowMissingLeaf: true });
    if (!safeExistsSync(safe)) return false;
    return loadPersonalIdentityAtPath(safe)?.avatar_profile === AVATAR_PROFILE_POINTER;
  } catch {
    return false;
  }
}

/** Set → wire with per-frame URLs under `assetUrlBase` (e.g. `/api/me/avatar`). */
export function describePersonalAvatar(
  assetUrlBase: string,
  profileRoot: string = resolveActiveProfileRoot()
): PersonalAvatarWire | null {
  const set = loadPersonalAvatarSet(profileRoot);
  if (!set) return null;
  const base = assetUrlBase.replace(/\/+$/u, '');
  const images = Object.fromEntries(
    Object.keys(set.files).map((expression) => [expression, `${base}/${expression}`])
  ) as PersonalAvatarWire['images'];
  return {
    images,
    mouth: set.profile.mouth,
    generated_at: set.profile.generated_at,
    provider_id: set.profile.provider_id,
    adopted: isAdopted(profileRoot),
  };
}

/**
 * The user's own avatar as a presence profile — only once they adopted a
 * generated set (`my-identity.json` `avatar_profile`), else null so callers
 * fall back to the product registry.
 */
export function getUserPresenceAvatarProfile(
  assetUrlBase: string,
  profileRoot: string = resolveActiveProfileRoot()
): PresenceAvatarProfile | null {
  const wire = describePersonalAvatar(assetUrlBase, profileRoot);
  if (!wire?.adopted) return null;
  return {
    agentId: 'user',
    displayName: 'You',
    defaultAvatarAssetPath: wire.images.neutral,
    expressionAvatarMap: { ...wire.images },
  };
}
