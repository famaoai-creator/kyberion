'use client';

import * as React from 'react';
import { Button, SettingRow, SettingsGroup, TextField, Textarea } from '@agent/shared-ui';
import { frontDeskText } from '../../../lib/i18n';
import type { ConciergeLocale } from '../../../lib/i18n';
import { FormScope, asText, type SettingsTranslate } from './form-scope';

/** FD-06 プロフィール pane (`#setup-profile`) — extracted from settings/page.tsx
 * so the page composes it instead of inlining the JSX. All state and the
 * save handler stay owned by the page; this component only renders (UI-06:
 * on the shared `SettingsGroup` / `TextField` / `Textarea`). */
export type ProfileSectionProfile = {
  name: string;
  primary_domain: string;
  vision: string;
  agent_id: string;
};

export type ProfileSectionProps = {
  locale: ConciergeLocale;
  t: SettingsTranslate;
  profile: ProfileSectionProfile;
  setProfile: (profile: ProfileSectionProfile) => void;
  busy: boolean;
  onSaveProfile: () => void;
  sectionRef: (element: HTMLElement | null) => void;
  /** Extra groups rendered under the profile card (表示 preferences). */
  children?: React.ReactNode;
};

export function ProfileSection({
  locale,
  t,
  profile,
  setProfile,
  busy,
  onSaveProfile,
  sectionRef,
  children,
}: ProfileSectionProps) {
  const set = (field: keyof ProfileSectionProfile) => (value: unknown) =>
    setProfile({ ...profile, [field]: asText(value) });
  return (
    <div
      className="settings-section"
      id="setup-profile"
      ref={sectionRef}
      aria-label={frontDeskText('settings_nav_profile', locale)}
    >
      <FormScope
        fields={{
          'profile.name': set('name'),
          'profile.primary_domain': set('primary_domain'),
          'profile.vision': set('vision'),
        }}
      >
        <SettingsGroup
          id="settings-profile"
          title={frontDeskText('settings_nav_profile', locale)}
          description={t('setup.profile_description')}
        >
          <SettingRow label={t('setup.display_name')}>
            <TextField
              id="profile-name"
              name="profile.name"
              label={t('setup.display_name')}
              hide_label
              value={profile.name}
              placeholder="e.g. Alex Morgan"
            />
          </SettingRow>
          <SettingRow label={t('setup.primary_domain')}>
            <TextField
              id="profile-domain"
              name="profile.primary_domain"
              label={t('setup.primary_domain')}
              hide_label
              value={profile.primary_domain}
              placeholder="e.g. business development"
            />
          </SettingRow>
          <SettingRow label={t('setup.secretary_policy')}>
            <Textarea
              id="profile-vision"
              name="profile.vision"
              label={t('setup.secretary_policy')}
              hide_label
              rows={3}
              value={profile.vision}
              placeholder={t('setup.priority_placeholder')}
            />
          </SettingRow>
          <div className="settings-row-actions">
            <Button
              label={t('setup.save_profile')}
              variant="primary"
              disabled={busy}
              onClick={onSaveProfile}
            />
          </div>
        </SettingsGroup>
      </FormScope>
      {children}
    </div>
  );
}
