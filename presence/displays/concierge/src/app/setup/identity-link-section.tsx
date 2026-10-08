'use client';

import * as React from 'react';
import { useConciergeI18n } from '../../lib/use-concierge-i18n';
import { frontDeskText } from '../../lib/i18n';
import { attachFrontDeskAuthHeaders } from '../../lib/front-desk-auth-token';

/**
 * "Link my IdP account": asks `/api/setup/link-identity` for an IdP sign-in
 * bound to the signed-in member, then navigates there. The callback returns
 * to `/setup/sso?linked=1`.
 */
export function IdentityLinkSection() {
  const { locale } = useConciergeI18n();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [linked, setLinked] = React.useState(false);

  React.useEffect(() => {
    setLinked(new URLSearchParams(window.location.search).get('linked') === '1');
  }, []);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/setup/link-identity', {
        method: 'POST',
        headers: attachFrontDeskAuthHeaders({ 'Content-Type': 'application/json' }),
        body: '{}',
      });
      const data = await response.json().catch(() => null);
      if (response.ok && data?.ok && typeof data.location === 'string') {
        window.location.assign(data.location);
        return;
      }
      const code = typeof data?.error === 'string' ? data.error : '';
      setError(
        code === 'sso_not_configured'
          ? frontDeskText('sso_link_unavailable', locale)
          : response.status === 403
            ? frontDeskText('sso_link_owner_only', locale)
            : frontDeskText('sso_error_generic', locale)
      );
    } catch {
      setError(frontDeskText('sso_error_generic', locale));
    }
    setBusy(false);
  };

  return (
    <div aria-label={frontDeskText('sso_link_title', locale)}>
      <h3>{frontDeskText('sso_link_title', locale)}</h3>
      <p className="pane-subtitle">{frontDeskText('sso_link_lead', locale)}</p>
      {linked ? <p className="notice">{frontDeskText('sso_linked', locale)}</p> : null}
      {error ? <p className="notice error">{error}</p> : null}
      <div className="button-row">
        <button className="action-button" disabled={busy} onClick={() => void start()}>
          {frontDeskText('sso_link_button', locale)}
        </button>
      </div>
    </div>
  );
}
