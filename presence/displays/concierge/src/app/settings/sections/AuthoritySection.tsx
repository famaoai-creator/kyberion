'use client';

import * as React from 'react';
import { frontDeskText } from '../../../lib/i18n';
import type { ConciergeLocale } from '../../../lib/i18n';
import { OnboardingAuthorityPanel } from './OnboardingAuthorityPanel';
import { ProviderAttestationSection } from './ProviderAttestationSection';
import { GovernanceSection } from './GovernanceSection';
import { CharterPane } from './CharterPane';
import type { SettingsTranslate } from './form-scope';

/**
 * Delegated action authority and governance: onboarding authority requests,
 * provider attestations, governance policy, and charters. Previously these
 * panels were nested inside the services card; they are a distinct concern
 * (who may act on the operator's behalf) from service connectivity.
 */
export type AuthoritySectionProps = {
  locale: ConciergeLocale;
  t: SettingsTranslate;
  sectionRef: (element: HTMLElement | null) => void;
  authorityTenants?: { tenant_slug: string; display_name: string }[];
  selectedTenant?: string;
};

export function AuthoritySection({
  locale,
  t,
  sectionRef,
  authorityTenants = [],
  selectedTenant,
}: AuthoritySectionProps) {
  return (
    <div
      className="settings-section"
      id="settings-authority"
      ref={sectionRef}
      aria-label={frontDeskText('settings_nav_authority', locale)}
    >
      <OnboardingAuthorityPanel
        locale={locale}
        tenants={authorityTenants}
        selectedTenant={selectedTenant}
      />
      <ProviderAttestationSection
        t={t}
        locale={locale}
        tenants={authorityTenants}
        selectedTenant={selectedTenant}
      />
      <GovernanceSection t={t} />
      <CharterPane t={t} />
    </div>
  );
}
