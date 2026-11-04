import type { SettingsNavProps } from '@agent/shared-ui';
import { frontDeskText, type ConciergeLocale } from '../../lib/i18n';
import {
  SETTINGS_CATEGORIES,
  SETTINGS_SECTION_ELEMENT_ID,
  SETTINGS_SECTION_ORDER,
  type SettingsSectionId,
} from '../../lib/settings-view';

/**
 * The left pane: one flat list of the nine categories in the IA order
 * (MSN-SHELL-IA-20261105 §4). The order never moves after a save; a category
 * with unsaved drafts carries a badge.
 */
export function createSettingsMenu(
  locale: ConciergeLocale,
  dirty: Partial<Record<SettingsSectionId, boolean>>
): SettingsNavProps['groups'] {
  return [
    {
      id: 'settings',
      label: frontDeskText('nav_settings', locale),
      items: SETTINGS_SECTION_ORDER.map((id) => ({
        id,
        label: frontDeskText(SETTINGS_CATEGORIES[id].label, locale),
        description: frontDeskText(SETTINGS_CATEGORIES[id].description, locale),
        icon: SETTINGS_CATEGORIES[id].icon,
        href: '#' + SETTINGS_SECTION_ELEMENT_ID[id],
        ...(dirty[id] ? { badge: frontDeskText('settings_unsaved_badge', locale) } : {}),
      })),
    },
  ];
}
