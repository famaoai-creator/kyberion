'use client';

import * as React from 'react';
import { Segmented, SettingRow, SettingsGroup } from '@agent/shared-ui';
import type { ConciergeLocale } from '../../../lib/i18n';
import {
  normalizeThemePreference,
  onDisplayPreferencesChange,
  readDisplayPreferences,
  updateDisplayPreferences,
  type ConciergeDensityPreference,
  type ConciergeThemePreference,
} from '../../../lib/concierge-theme';
import { FormScope, asText, type SettingsTranslate } from './form-scope';

export type DisplaySectionProps = {
  locale: ConciergeLocale;
  t: SettingsTranslate;
  /** The shell's locale setter (persists the choice and re-renders every page). */
  onLocaleChange: (locale: ConciergeLocale) => void;
};

/**
 * UI-06 表示 (`#settings-display`): language, theme and density. Changes
 * apply at once and persist per browser through the shell's display
 * preferences (`lib/concierge-theme.ts`: same localStorage keys and change
 * event as the header controls) — no server call, so no save button.
 */
export function DisplaySection({ locale, t, onLocaleChange }: DisplaySectionProps) {
  const [theme, setTheme] = React.useState<ConciergeThemePreference>('system');
  const [density, setDensity] = React.useState<ConciergeDensityPreference>('comfortable');

  React.useEffect(() => {
    const sync = () => {
      const prefs = readDisplayPreferences();
      setTheme(prefs.theme);
      setDensity(prefs.density);
    };
    sync();
    return onDisplayPreferencesChange(sync);
  }, []);

  return (
    <FormScope
      fields={{
        'display.locale': (value) => onLocaleChange(asText(value) === 'en' ? 'en' : 'ja'),
        'display.theme': (value) => {
          const next = normalizeThemePreference(value);
          setTheme(next);
          updateDisplayPreferences({ theme: next });
        },
        'display.density': (value) => {
          const next: ConciergeDensityPreference =
            asText(value) === 'compact' ? 'compact' : 'comfortable';
          setDensity(next);
          updateDisplayPreferences({ density: next });
        },
      }}
    >
      <div className="settings-subsection" id="settings-display">
        <SettingsGroup
          id="display-group"
          title={t('settings.display_title')}
          description={t('settings.display_description')}
        >
          <SettingRow label={t('locale.label')}>
            <Segmented
              id="display-locale"
              name="display.locale"
              label={t('locale.label')}
              hide_label
              value={locale}
              options={[
                { value: 'ja', label: t('locale.japanese') },
                { value: 'en', label: t('locale.english') },
              ]}
            />
          </SettingRow>
          <SettingRow label={t('theme.label')}>
            <Segmented
              id="display-theme"
              name="display.theme"
              label={t('theme.label')}
              hide_label
              value={theme}
              options={[
                { value: 'system', label: t('theme.system') },
                { value: 'light', label: t('theme.light') },
                { value: 'dark', label: t('theme.dark') },
              ]}
            />
          </SettingRow>
          <SettingRow
            label={t('settings.display_density')}
            description={t('settings.display_density_description')}
          >
            <Segmented
              id="display-density"
              name="display.density"
              label={t('settings.display_density')}
              hide_label
              value={density}
              options={[
                { value: 'comfortable', label: t('settings.display_density_comfortable') },
                { value: 'compact', label: t('settings.display_density_compact') },
              ]}
            />
          </SettingRow>
        </SettingsGroup>
      </div>
    </FormScope>
  );
}
