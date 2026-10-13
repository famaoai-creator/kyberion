'use client';

import * as React from 'react';
import { Callout } from '@agent/shared-ui';
import type { SettingsTranslate } from './form-scope';

export type SettingsSaveFeedbackState = {
  section: 'profile' | 'services' | 'notifications';
  phase: 'saving' | 'saved' | 'unconfirmed' | 'unavailable';
};

/** One result at the initiating control; a receipt never implies later edits were saved. */
export function SettingsSaveFeedback({
  feedback,
  hasUnsavedChanges,
  t,
}: {
  feedback?: SettingsSaveFeedbackState | null;
  hasUnsavedChanges?: boolean;
  t: SettingsTranslate;
}) {
  if (!feedback) return null;
  const { phase, section } = feedback;
  const danger = phase === 'unconfirmed' || phase === 'unavailable';
  const key =
    phase === 'saving'
      ? 'setup.section_save_pending'
      : phase === 'unconfirmed'
        ? 'setup.draft_save_unconfirmed'
        : phase === 'unavailable'
          ? 'setup.draft_context_unavailable'
          : hasUnsavedChanges
            ? 'setup.section_save_newer_edits'
            : section === 'notifications'
              ? 'setup.notification_saved'
              : 'setup.onboarding_saved';
  return (
    <div
      className="settings-row-block"
      role={danger ? undefined : 'status'}
      aria-live={danger ? undefined : 'polite'}
      aria-atomic={danger ? undefined : true}
    >
      <Callout
        tone={danger ? 'danger' : phase === 'saved' && !hasUnsavedChanges ? 'success' : 'info'}
        title={t(key)}
      />
    </div>
  );
}
