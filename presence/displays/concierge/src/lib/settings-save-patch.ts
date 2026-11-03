/**
 * Settings saves send only what the operator edited (`/api/setup`
 * action=save_settings). The server merges the patch onto the stored profile,
 * so language, provider priority, tool policy, the agent's provider/model and
 * a voice profile's engine are never re-submitted from page-local defaults.
 */

export type ProfileDraft = {
  name: string;
  primary_domain: string;
  vision: string;
  agent_id: string;
};

export type SettingsServiceEntry = {
  service_id: string;
  auth_mode: 'session' | 'oauth';
  required: boolean;
};

export type SettingsPatch = {
  identity?: Partial<ProfileDraft>;
  services?: SettingsServiceEntry[];
  voice?: { profile_id: string; display_name: string; sample_refs: string[] };
};

const PROFILE_FIELDS = ['name', 'primary_domain', 'vision', 'agent_id'] as const;

/** The trimmed profile fields that differ from the last saved snapshot. */
export function profileChanges(
  saved: ProfileDraft | null,
  draft: ProfileDraft
): Partial<ProfileDraft> {
  const changes: Partial<ProfileDraft> = {};
  for (const field of PROFILE_FIELDS) {
    const value = draft[field].trim();
    if (!saved || value !== saved[field].trim()) changes[field] = value;
  }
  return changes;
}

/** The onboarding service entries for a selection (credentials are never part of it). */
export function serviceEntries(services: readonly string[]): SettingsServiceEntry[] {
  return services.map((service_id) => ({
    service_id,
    auth_mode: service_id === 'browser' || service_id === 'voice-hub' ? 'session' : 'oauth',
    required: service_id === 'google-workspace',
  }));
}

/**
 * Build the patch for one save. `null` means nothing was edited, so nothing
 * is sent. `savedProfile` is the snapshot the server will hold afterwards.
 */
export function buildSettingsPatch(input: {
  savedProfile: ProfileDraft | null;
  profile?: ProfileDraft;
  services?: readonly string[];
}): { patch: SettingsPatch; savedProfile: ProfileDraft | null } | null {
  const patch: SettingsPatch = {};
  let savedProfile = input.savedProfile;
  if (input.profile) {
    const identity = profileChanges(input.savedProfile, input.profile);
    if (Object.keys(identity).length) {
      patch.identity = identity;
      savedProfile = { ...(input.savedProfile ?? input.profile), ...identity };
    }
  }
  if (input.services) patch.services = serviceEntries(input.services);
  return Object.keys(patch).length ? { patch, savedProfile } : null;
}
