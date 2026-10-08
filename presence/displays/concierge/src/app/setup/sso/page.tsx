'use client';

import { useConciergeI18n } from '../../../lib/use-concierge-i18n';
import { frontDeskText } from '../../../lib/i18n';
import { IdentityLinkSection } from '../identity-link-section';
import { SsoSettingsForm } from '../sso-settings-form';

/**
 * SSO outside first-run setup: any signed-in member may link their own IdP
 * account; the settings form is instance owner only (enforced by the API).
 */
export default function SsoSettingsPage() {
  const { locale } = useConciergeI18n();
  return (
    <section className="pane" aria-label={frontDeskText('sso_title', locale)}>
      <IdentityLinkSection />
      <SsoSettingsForm />
    </section>
  );
}
