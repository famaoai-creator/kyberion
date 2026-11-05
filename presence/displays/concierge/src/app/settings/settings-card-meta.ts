import type { FrontDeskMessageKey } from '../../lib/i18n';

/**
 * The default and the one-line effect of the settings whose cards predate the
 * settings IA (MSN-SHELL-IA-20261105 §4); new cards render their own.
 */
export const CARD_META: Record<
  string,
  { default?: FrontDeskMessageKey; effect: FrontDeskMessageKey }
> = {
  'setup-profile': {
    default: 'ia_settings_profile_default',
    effect: 'ia_settings_profile_effect',
  },
  'settings-members': { effect: 'ia_settings_members_effect' },
  'settings-authority': {
    default: 'ia_settings_authority_default',
    effect: 'ia_settings_authority_effect',
  },
  'setup-media': { effect: 'ia_settings_voice_effect' },
  'setup-notifications': {
    default: 'ia_settings_notifications_default',
    effect: 'ia_settings_notifications_effect',
  },
  'setup-services': { effect: 'ia_settings_services_effect' },
  'settings-recording': { effect: 'ia_settings_recording_effect' },
};
