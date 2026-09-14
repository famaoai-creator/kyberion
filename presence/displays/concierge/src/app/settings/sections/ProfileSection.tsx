'use client';

import * as React from 'react';
import { frontDeskText } from '../../../lib/i18n';
import type { ConciergeLocale, ConciergeMessageKey } from '../../../lib/i18n';

/** FD-06 プロフィール pane (`#setup-profile`) — extracted from settings/page.tsx
 * so the page composes it instead of inlining the JSX. All state and the
 * save handler stay owned by the page; this component only renders. */
export type ProfileSectionProfile = {
  name: string;
  primary_domain: string;
  vision: string;
  agent_id: string;
};

export type ProfileSectionProps = {
  locale: ConciergeLocale;
  t: (key: ConciergeMessageKey, params?: Record<string, string | number>) => string;
  profile: ProfileSectionProfile;
  setProfile: (profile: ProfileSectionProfile) => void;
  busy: boolean;
  onSaveProfile: () => void;
  sectionRef: (element: HTMLElement | null) => void;
};

export function ProfileSection({
  locale,
  t,
  profile,
  setProfile,
  busy,
  onSaveProfile,
  sectionRef,
}: ProfileSectionProps) {
  return (
    <section
      className="pane"
      id="setup-profile"
      ref={sectionRef}
      aria-label={frontDeskText('settings_nav_profile', locale)}
    >
      <h2>{frontDeskText('settings_nav_profile', locale)}</h2>
      <h3 className="pane-subheading">{t('setup.profile_title')}</h3>
      <p className="pane-subtitle">{t('setup.profile_description')}</p>
      <label className="field-label">
        {t('setup.display_name')}
        <input
          value={profile.name}
          onChange={(event) => setProfile({ ...profile, name: event.target.value })}
          placeholder="e.g. Alex Morgan"
        />
      </label>
      <label className="field-label">
        {t('setup.primary_domain')}
        <input
          value={profile.primary_domain}
          onChange={(event) => setProfile({ ...profile, primary_domain: event.target.value })}
          placeholder="e.g. business development"
        />
      </label>
      <label className="field-label">
        {t('setup.secretary_policy')}
        <textarea
          value={profile.vision}
          onChange={(event) => setProfile({ ...profile, vision: event.target.value })}
          rows={3}
          placeholder={t('setup.priority_placeholder')}
        />
      </label>
      <div className="button-row">
        <button className="action-button" disabled={busy} onClick={onSaveProfile}>
          {t('setup.save_profile')}
        </button>
      </div>
    </section>
  );
}
