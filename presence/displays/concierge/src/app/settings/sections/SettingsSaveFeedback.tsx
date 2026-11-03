'use client';

import * as React from 'react';
import { Callout } from '@agent/shared-ui';
import type { SettingsTranslate } from './form-scope';
import type { ConciergeMessageKey } from '../../../lib/i18n';
import type { InstallationAccessCode } from '../../../lib/installation-access-client';
import { InstallationAccessNotice } from './InstallationAccessNotice';

export type SettingsSaveFeedbackState = {
  section: 'profile' | 'services' | 'notifications' | 'voice' | 'advanced';
  /** `rejected`: the server refused the save; `message` carries its reason. */
  phase: 'saving' | 'saved' | 'unconfirmed' | 'unavailable' | 'rejected';
  message?: string;
  /** `rejected` by the installation-owner gate: render its notice, not a failure. */
  access?: InstallationAccessCode;
};

const SAVED_KEY: Record<SettingsSaveFeedbackState['section'], ConciergeMessageKey> = {
  profile: 'setup.onboarding_saved',
  services: 'setup.onboarding_saved',
  notifications: 'setup.notification_saved',
  voice: 'setup.voice_registered',
  advanced: 'setup.management_saved',
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
  if (feedback.phase === 'rejected' && feedback.access) {
    return (
      <div className="settings-row-block">
        <InstallationAccessNotice code={feedback.access} t={t} />
      </div>
    );
  }
  const { phase, section } = feedback;
  const danger = phase === 'unconfirmed' || phase === 'unavailable' || phase === 'rejected';
  const key: ConciergeMessageKey =
    phase === 'saving'
      ? 'setup.section_save_pending'
      : phase === 'unconfirmed' || phase === 'rejected'
        ? 'setup.draft_save_unconfirmed'
        : phase === 'unavailable'
          ? 'setup.draft_context_unavailable'
          : hasUnsavedChanges
            ? 'setup.section_save_newer_edits'
            : SAVED_KEY[section];
  return (
    <div
      className="settings-row-block"
      role={danger ? undefined : 'status'}
      aria-live={danger ? undefined : 'polite'}
      aria-atomic={danger ? undefined : true}
    >
      <Callout
        tone={danger ? 'danger' : phase === 'saved' && !hasUnsavedChanges ? 'success' : 'info'}
        title={phase === 'rejected' && feedback.message ? feedback.message : t(key)}
      />
    </div>
  );
}
