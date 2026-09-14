'use client';

import * as React from 'react';
import { useConciergeI18n } from '../../lib/use-concierge-i18n';
import { frontDeskText } from '../../lib/i18n';
import { storeFrontDeskToken } from '../../lib/front-desk-auth-token';

/**
 * FD-07 item 7 「どなたですか？」— shown only when a remote (non-loopback)
 * request has no usable token: the rail redirects here on a 401 from
 * `/api/me` (front-desk-rail.tsx). Loopback never reaches this page (the
 * rail's redirect guard excludes it, and the server never 401s a loopback
 * request for a missing token).
 *
 * The token is kept in `sessionStorage` only (front-desk-auth-token.ts) —
 * cleared when the tab closes, never sent anywhere but this origin's own
 * `/api/*` routes.
 */
export default function SignInPage() {
  const { locale } = useConciergeI18n();
  const [token, setToken] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(false);

  const submit = React.useCallback(async () => {
    const trimmed = token.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(false);
    try {
      const response = await fetch('/api/me', {
        headers: { Authorization: `Bearer ${trimmed}` },
        cache: 'no-store',
      });
      const parsed = await response.json().catch(() => null);
      if (!response.ok || !parsed?.ok) throw new Error('invalid token');
      storeFrontDeskToken(trimmed);
      window.location.assign('/');
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }, [token]);

  return (
    <section className="pane" aria-label={frontDeskText('signin_title', locale)}>
      <h2>{frontDeskText('signin_title', locale)}</h2>
      <p className="pane-subtitle">{frontDeskText('signin_lead', locale)}</p>
      <label>
        {frontDeskText('signin_token_label', locale)}
        <input
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          autoComplete="off"
        />
      </label>
      {error ? <p className="notice error">{frontDeskText('signin_error', locale)}</p> : null}
      <div className="button-row">
        <button
          className="action-button"
          disabled={busy || !token.trim()}
          onClick={() => void submit()}
        >
          {frontDeskText('signin_submit', locale)}
        </button>
      </div>
    </section>
  );
}
