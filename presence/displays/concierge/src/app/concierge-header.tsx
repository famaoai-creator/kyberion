'use client';

import * as React from 'react';
import {
  A2UIActionProvider,
  KB_FORM_ACTIONS,
  PageHeader,
  Segmented,
  Select,
} from '@agent/shared-ui';
import { useConciergeI18n } from '../lib/use-concierge-i18n';
import {
  normalizeThemePreference,
  onDisplayPreferencesChange,
  readDisplayPreferences,
  updateDisplayPreferences,
  type ConciergeThemePreference,
} from '../lib/concierge-theme';

// FD-00c: the Home / 資料の取込 / Setup nav links live in `FrontDeskRail`.
// UI-06: the header is the surface identity — `ui:page-header` with the
// concierge role badge (surface-roles.json `role_ja`, via the vocabulary
// catalog) and the tagline — plus the per-viewer theme and language controls.
export function ConciergeHeader() {
  const { locale, setLocale, t } = useConciergeI18n();
  const [theme, setTheme] = React.useState<ConciergeThemePreference>('system');

  React.useEffect(() => {
    setTheme(readDisplayPreferences().theme);
    return onDisplayPreferencesChange((prefs) => setTheme(prefs.theme));
  }, []);

  // The shared form controls report changes as `field.change` actions.
  const onAction = React.useCallback(
    (actionId: string, payload?: Record<string, unknown>) => {
      if (actionId !== KB_FORM_ACTIONS.fieldChange || !payload) return;
      if (payload.name === 'theme') {
        const next = normalizeThemePreference(payload.value);
        setTheme(next);
        updateDisplayPreferences({ theme: next });
      } else if (payload.name === 'locale') {
        setLocale(payload.value === 'en' ? 'en' : 'ja');
      }
    },
    [setLocale]
  );

  return (
    <PageHeader
      title={t('header.title')}
      subtitle={t('header.tagline')}
      role_badge={{ label: t('header.role_badge'), role: 'concierge' }}
    >
      <A2UIActionProvider onAction={onAction}>
        <div className="concierge-header-controls">
          <Segmented
            name="theme"
            label={t('theme.label')}
            hide_label
            value={theme}
            options={[
              { value: 'system', label: t('theme.system') },
              { value: 'light', label: t('theme.light') },
              { value: 'dark', label: t('theme.dark') },
            ]}
          />
          <Select
            name="locale"
            label={t('locale.label')}
            hide_label
            value={locale}
            options={[
              { value: 'ja', label: t('locale.japanese') },
              { value: 'en', label: t('locale.english') },
            ]}
          />
        </div>
      </A2UIActionProvider>
    </PageHeader>
  );
}
