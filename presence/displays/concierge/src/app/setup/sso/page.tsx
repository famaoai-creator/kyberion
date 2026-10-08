'use client';

import { useConciergeI18n } from '../../../lib/use-concierge-i18n';
import { frontDeskText } from '../../../lib/i18n';
import { SsoSettingsForm } from '../sso-settings-form';

/** SSO settings outside first-run setup (instance owner only, enforced by the API). */
export default function SsoSettingsPage() {
  const { locale } = useConciergeI18n();
  return (
    <section className="pane" aria-label={frontDeskText('sso_title', locale)}>
      <SsoSettingsForm />
    </section>
  );
}
