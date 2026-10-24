import type { SettingsNavProps } from '@agent/shared-ui';
import { frontDeskText, type ConciergeLocale, type FrontDeskMessageKey } from '../../lib/i18n';
import type { SettingsSectionId } from '../../lib/settings-view';
import { SETTINGS_SECTION_ELEMENT_ID } from './settings-navigation';

const SECTIONS: Record<
  SettingsSectionId,
  { label: FrontDeskMessageKey; description: FrontDeskMessageKey; icon: string }
> = {
  profile: { label: 'settings_nav_profile', description: 'settings_desc_profile', icon: 'user' },
  display: { label: 'settings_nav_display', description: 'settings_desc_display', icon: 'monitor' },
  members: { label: 'settings_nav_members', description: 'settings_desc_members', icon: 'users' },
  services: { label: 'settings_nav_services', description: 'settings_desc_services', icon: 'plug' },
  voice: { label: 'settings_nav_voice', description: 'settings_desc_voice', icon: 'mic' },
  notifications: {
    label: 'settings_nav_notifications',
    description: 'settings_desc_notifications',
    icon: 'bell',
  },
  recording: {
    label: 'settings_nav_recording',
    description: 'settings_desc_recording',
    icon: 'shield',
  },
  plugins: { label: 'settings_nav_plugins', description: 'settings_desc_plugins', icon: 'puzzle' },
  advanced: {
    label: 'settings_nav_advanced',
    description: 'settings_desc_advanced',
    icon: 'settings',
  },
};

/** Grouping follows the body order; navigation never moves after a save. */
export function createSettingsMenu(
  locale: ConciergeLocale,
  dirty: Partial<Record<SettingsSectionId, boolean>>
): SettingsNavProps['groups'] {
  const groups: Array<{ id: string; label: FrontDeskMessageKey; sections: SettingsSectionId[] }> = [
    { id: 'people', label: 'settings_group_people', sections: ['profile', 'display', 'members'] },
    {
      id: 'companion',
      label: 'settings_group_companion',
      sections: ['services', 'voice', 'notifications', 'recording'],
    },
    { id: 'administration', label: 'settings_group_manage', sections: ['plugins', 'advanced'] },
  ];
  return groups.map((group) => ({
    id: group.id,
    label: frontDeskText(group.label, locale),
    items: group.sections.map((id) => ({
      id,
      label: frontDeskText(SECTIONS[id].label, locale),
      description: frontDeskText(SECTIONS[id].description, locale),
      icon: SECTIONS[id].icon,
      href: '#' + SETTINGS_SECTION_ELEMENT_ID[id],
      ...(dirty[id] ? { badge: frontDeskText('settings_unsaved_badge', locale) } : {}),
    })),
  }));
}
