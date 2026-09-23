'use client';

import * as React from 'react';
import {
  A2UIActionProvider,
  DisplayControls,
  KB_DISPLAY_CONTROLS_ACTIONS,
  PageHeader,
  useA2UIActions,
} from '@agent/shared-ui';
import { useConciergeI18n } from '../lib/use-concierge-i18n';
import {
  normalizeThemePreference,
  onDisplayPreferencesChange,
  readDisplayPreferences,
  updateDisplayPreferences,
  type ConciergeThemePreference,
} from '../lib/concierge-theme';
import { CONVERSATION_DOCK_OPEN_EVENT } from './conversation-dock';

/** Header action that opens the secretary conversation dock. */
const OPEN_DOCK_ACTION = 'concierge.dock.open';

// FD-00c: the Home / 資料の取込 / Setup nav links live in `FrontDeskRail`.
// UI-06: the header is the surface identity — `ui:page-header` with the
// concierge role badge (surface-roles.json `role_ja`, via the vocabulary
// catalog) and the tagline. Its actions are "秘書に相談" (opens the
// conversation dock — a header button instead of a floating one, so it never
// covers page content) and the shared `ui:display-controls` (theme +
// language, identical to the presence-studio header); the choice is
// persisted here, the component only emits `display.*` actions.
export function ConciergeHeader() {
  const { locale, setLocale, t } = useConciergeI18n();
  const [theme, setTheme] = React.useState<ConciergeThemePreference>('system');
  const outerActions = useA2UIActions();

  React.useEffect(() => {
    setTheme(readDisplayPreferences().theme);
    return onDisplayPreferencesChange((prefs) => setTheme(prefs.theme));
  }, []);

  const onAction = React.useCallback(
    (actionId: string, payload?: Record<string, unknown>) => {
      if (actionId === OPEN_DOCK_ACTION) {
        window.dispatchEvent(new Event(CONVERSATION_DOCK_OPEN_EVENT));
      } else if (actionId === KB_DISPLAY_CONTROLS_ACTIONS.theme) {
        const next = normalizeThemePreference(payload?.value);
        setTheme(next);
        updateDisplayPreferences({ theme: next });
      } else if (actionId === KB_DISPLAY_CONTROLS_ACTIONS.locale) {
        setLocale(payload?.value === 'en' ? 'en' : 'ja');
      }
    },
    [setLocale]
  );

  return (
    <A2UIActionProvider
      onAction={onAction}
      linkComponent={outerActions.linkComponent}
      navigate={outerActions.navigate}
    >
      <PageHeader
        title={t('header.title')}
        subtitle={t('header.tagline')}
        role_badge={{ label: t('header.role_badge'), role: 'concierge' }}
        actions={[{ label: t('dock.title'), action: { id: OPEN_DOCK_ACTION }, variant: 'primary' }]}
      >
        <DisplayControls id="display-controls" theme={theme} locale={locale} />
      </PageHeader>
    </A2UIActionProvider>
  );
}
