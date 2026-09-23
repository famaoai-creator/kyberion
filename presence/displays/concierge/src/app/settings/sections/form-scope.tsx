'use client';

import * as React from 'react';
import { A2UIActionProvider, KB_FORM_ACTIONS, useA2UIActions } from '@agent/shared-ui';
import type { ConciergeMessageKey } from '../../../lib/i18n';

/** The concierge `t()` every settings section receives from the page. */
export type SettingsTranslate = (
  key: ConciergeMessageKey,
  params?: Record<string, string | number>
) => string;

type FieldHandlers = Record<string, (value: unknown) => void>;
type ActionHandlers = Record<string, (payload: Record<string, unknown>) => void>;

/**
 * UI-06 settings: routes the shared form components' `onAction` contract
 * (`field.change {name, value}`, `avatar.change {file}`, `secret.submit
 * {value}`, and each section's own action ids) to the section's existing
 * handlers. Sections stay render-only — this only translates the
 * `@agent/shared-ui` action payload into the setter / handler the page
 * already owned. Files and secret values pass straight through to the
 * handler and are never stored here.
 */
export function FormScope({
  fields,
  actions,
  children,
}: {
  fields?: FieldHandlers;
  actions?: ActionHandlers;
  children?: React.ReactNode;
}) {
  // Keep the shell's link component / navigation (next/link) for kb links.
  const parent = useA2UIActions();
  const fieldsRef = React.useRef(fields);
  const actionsRef = React.useRef(actions);
  React.useEffect(() => {
    fieldsRef.current = fields;
    actionsRef.current = actions;
  });
  const onAction = React.useCallback((actionId: string, payload?: Record<string, unknown>) => {
    const data = payload ?? {};
    if (actionId === KB_FORM_ACTIONS.fieldChange) {
      const name = typeof data.name === 'string' ? data.name : '';
      const handler = fieldsRef.current?.[name];
      if (handler) handler(data.value);
      return;
    }
    const handler = actionsRef.current?.[actionId];
    if (handler) handler(data);
  }, []);
  return (
    <A2UIActionProvider
      onAction={onAction}
      linkComponent={parent.linkComponent}
      navigate={parent.navigate}
    >
      {children}
    </A2UIActionProvider>
  );
}

/** Narrow a `field.change` value to a string (selects, text fields). */
export function asText(value: unknown): string {
  return typeof value === 'string'
    ? value
    : value === undefined || value === null
      ? ''
      : String(value);
}
