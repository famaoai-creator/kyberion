'use client';

import { useCallback } from 'react';
import type { KbDisplayControlsProps } from '@agent/core/a2ui-catalog';
import {
  KB_DISPLAY_CONTROLS_ACTIONS,
  displayLocaleProps,
  displayThemeProps,
} from '../../vanilla/kyberion-ui.js';
import { A2UIActionProvider, useA2UIActions } from '../actions.js';
import { Segmented, Select } from '../forms/fields.js';
import { KB_FORM_ACTIONS } from '../../vanilla/forms.js';
import { KB_UI_MESSAGE_KEYS, useKbI18n } from '../i18n.js';

export type DisplayControlsProps = KbDisplayControlsProps & {
  /** A2UI component id; the inner field DOM ids derive from it. */
  id?: string;
};

/**
 * `ui:display-controls` → `div.kb-display-controls[role=group]`: the theme
 * as a `ui:segmented` (auto / light / dark) and the language as a
 * `ui:select`, both with visually hidden labels. Changes are dispatched as
 * `display.theme` / `display.locale` with `{ value }` through the enclosing
 * `A2UIActionProvider`; the host persists them (the component stores
 * nothing). Same markup as the vanilla renderer.
 */
export function DisplayControls({ id, theme, locale, locales }: DisplayControlsProps) {
  const outer = useA2UIActions();
  const { t } = useKbI18n();
  const outerOnAction = outer.onAction;
  const onAction = useCallback(
    (actionId: string, payload?: Record<string, unknown>) => {
      if (actionId !== KB_FORM_ACTIONS.fieldChange || !payload || !outerOnAction) return;
      if (payload.name === 'theme') {
        outerOnAction(KB_DISPLAY_CONTROLS_ACTIONS.theme, { value: payload.value });
      } else if (payload.name === 'locale') {
        outerOnAction(KB_DISPLAY_CONTROLS_ACTIONS.locale, { value: payload.value });
      }
    },
    [outerOnAction]
  );
  const baseId = id || 'display-controls';
  const themeProps = displayThemeProps(t, { theme });
  const localeProps = displayLocaleProps(t, { locale, locales });
  return (
    <div
      className="kb-display-controls"
      role="group"
      aria-label={t(KB_UI_MESSAGE_KEYS.displayLabel)}
    >
      <A2UIActionProvider
        onAction={onAction}
        linkComponent={outer.linkComponent}
        navigate={outer.navigate}
      >
        <Segmented id={`${baseId}-theme`} {...themeProps} />
        <Select id={`${baseId}-locale`} {...localeProps} />
      </A2UIActionProvider>
    </div>
  );
}
