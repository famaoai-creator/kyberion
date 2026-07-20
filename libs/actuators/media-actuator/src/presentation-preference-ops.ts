import {
  pathResolver,
  registerPresentationPreferenceProfile,
  safeExistsSync,
  safeReadFile,
  type PresentationPreferenceProfile,
} from '@agent/core';

export interface RegisterPresentationPreferenceProfileInput {
  profile?: PresentationPreferenceProfile;
  profile_path?: string;
  registry_path?: string;
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
    (input.profile_path && safeExistsSync(pathResolver.rootResolve(input.profile_path))
      ? JSON.parse(
          safeReadFile(pathResolver.rootResolve(input.profile_path), { encoding: 'utf8' }) as string
        )
      : null);
  if (!profile || typeof profile !== 'object') {
    throw new Error(
      '[register_presentation_preference_profile] requires a presentation-preference-profile'
    );
  }

  const registryPath = registerPresentationPreferenceProfile(
    profile as PresentationPreferenceProfile,
    input.registry_path ? pathResolver.rootResolve(input.registry_path) : undefined
  );

  return {
    profile_id: (profile as PresentationPreferenceProfile).profile_id,
    registry_path: registryPath,
    default_profile_id: (profile as PresentationPreferenceProfile).profile_id,
  };
}
