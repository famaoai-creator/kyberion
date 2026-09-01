import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from '@agent/core/secure-io';
import { readJson } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { registerPresentationPreferenceProfile } from '@agent/core/presentation-preference-registry';
import type { PresentationPreferenceProfile } from '@agent/core/types';

export interface RegisterPresentationPreferenceProfileInput {
  profile?: PresentationPreferenceProfile;
  profile_path?: string;
  registry_path?: string;
}

function resolveProfilePath(profilePath: string): string | null {
  const resolved = assertSafeRepositoryPath(pathResolver.rootResolve(profilePath), {
    allowMissingLeaf: true,
  });
  if (!safeExistsSync(resolved)) return null;
  if (!safeLstat(resolved).isFile()) {
    throw new Error(
      `[register_presentation_preference_profile] profile_path must be a regular file: ${profilePath}`
    );
  }
  return resolved;
}

/**
 * Registers design policy in the media boundary. Wisdom may derive a profile,
 * but media owns the presentation preference registry and its write policy.
 */
export function registerPresentationPreferenceProfileOp(
  input: RegisterPresentationPreferenceProfileInput
): {
  profile_id: string;
  registry_path: string;
  default_profile_id: string;
} {
  const profile =
    input.profile ??
    (input.profile_path
      ? (() => {
          const profilePath = resolveProfilePath(input.profile_path);
          return profilePath ? readJson<PresentationPreferenceProfile>(profilePath) : null;
        })()
      : null);
  if (!profile || typeof profile !== 'object') {
    throw new Error(
      '[register_presentation_preference_profile] requires a presentation-preference-profile'
    );
  }

  const registryPath = registerPresentationPreferenceProfile(
    profile as PresentationPreferenceProfile,
    input.registry_path
      ? assertSafeRepositoryPath(pathResolver.rootResolve(input.registry_path), {
          allowMissingLeaf: true,
        })
      : undefined
  );

  return {
    profile_id: (profile as PresentationPreferenceProfile).profile_id,
    registry_path: registryPath,
    default_profile_id: (profile as PresentationPreferenceProfile).profile_id,
  };
}
