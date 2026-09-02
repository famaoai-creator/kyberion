import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import {
  loadPresentationPreferenceProfileFromPath,
  registerPresentationPreferenceProfile,
  validatePresentationPreferenceProfile,
} from '@agent/core/presentation-preference-registry';
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
  const targetRegistryPath = input.registry_path
    ? assertSafeRepositoryPath(pathResolver.rootResolve(input.registry_path), {
        allowMissingLeaf: true,
      })
    : undefined;
  const profile =
    input.profile ??
    (input.profile_path
      ? (() => {
          const profilePath = resolveProfilePath(input.profile_path);
          return profilePath ? loadPresentationPreferenceProfileFromPath(profilePath) : null;
        })()
      : null);
  if (!profile || typeof profile !== 'object') {
    throw new Error(
      '[register_presentation_preference_profile] requires a presentation-preference-profile'
    );
  }
  const validatedProfile = validatePresentationPreferenceProfile(profile);

  const registryPath = registerPresentationPreferenceProfile(validatedProfile, targetRegistryPath);

  return {
    profile_id: validatedProfile.profile_id,
    registry_path: registryPath,
    default_profile_id: validatedProfile.profile_id,
  };
}
