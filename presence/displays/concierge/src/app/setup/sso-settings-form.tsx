'use client';

import { frontDeskFetch as fetch } from '../../lib/front-desk-fetch';

import * as React from 'react';
import { useConciergeI18n } from '../../lib/use-concierge-i18n';
import { frontDeskText } from '../../lib/i18n';

/**
 * SSO (OIDC) settings, stored server-side in secret-guard by
 * `/api/setup/oidc` (instance owner only). The client secret is write-only:
 * the API reports whether one is set, never its value.
 */

type Summary = {
  source: 'env' | 'stored' | 'none';
  issuer?: string;
  client_id?: string;
  provider_label?: string;
  public_base_url?: string;
  client_secret_set: boolean;
};

type Notice =
  { kind: 'saved'; envOverrides: boolean; sessionWeak: boolean } | { kind: 'error'; text: string };

export function SsoSettingsForm() {
  const { locale } = useConciergeI18n();
  const [loaded, setLoaded] = React.useState(false);
  const [forbidden, setForbidden] = React.useState(false);
  const [summary, setSummary] = React.useState<Summary | null>(null);
  const [redirectUris, setRedirectUris] = React.useState<string[]>([]);
  const [issuer, setIssuer] = React.useState('');
  const [clientId, setClientId] = React.useState('');
  const [clientSecret, setClientSecret] = React.useState('');
  const [providerLabel, setProviderLabel] = React.useState('');
  const [publicBaseUrl, setPublicBaseUrl] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<Notice | null>(null);

  const apply = React.useCallback((data: { settings: Summary; redirect_uris: string[] }) => {
    setSummary(data.settings);
    setRedirectUris(data.redirect_uris);
    setIssuer(data.settings.issuer ?? '');
    setClientId(data.settings.client_id ?? '');
    setProviderLabel(data.settings.provider_label ?? '');
    setPublicBaseUrl(data.settings.public_base_url ?? '');
  }, []);

  React.useEffect(() => {
    void (async () => {
      try {
        const response = await fetch('/api/setup/oidc', {
          cache: 'no-store',
        });
        if (response.status === 401 || response.status === 403) {
          setForbidden(true);
          return;
        }
        const data = await response.json().catch(() => null);
        if (response.ok && data?.ok) apply(data);
      } finally {
        setLoaded(true);
      }
    })();
  }, [apply]);

  const save = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch('/api/setup/oidc', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          issuer,
          client_id: clientId,
          ...(clientSecret ? { client_secret: clientSecret } : {}),
          provider_label: providerLabel,
          public_base_url: publicBaseUrl,
        }),
      });
      const data = await response.json().catch(() => null);
      if (response.ok && data?.ok) {
        apply(data);
        setClientSecret('');
        setNotice({
          kind: 'saved',
          envOverrides: data.env_overrides === true,
          sessionWeak: data.session_key === 'env_weak',
        });
        return;
      }
      if (response.status === 403) {
        setNotice({ kind: 'error', text: frontDeskText('sso_error_forbidden', locale) });
      } else if (data?.error === 'invalid_input' && typeof data.field === 'string') {
        setNotice({
          kind: 'error',
          text: frontDeskText('sso_error_field', locale, { field: data.field }),
        });
      } else {
        setNotice({ kind: 'error', text: frontDeskText('sso_error_generic', locale) });
      }
    } catch {
      setNotice({ kind: 'error', text: frontDeskText('sso_error_generic', locale) });
    } finally {
      setBusy(false);
    }
  };

  if (!loaded) return null;
  if (forbidden) {
    return <p className="notice error">{frontDeskText('sso_error_forbidden', locale)}</p>;
  }

  return (
    <div aria-label={frontDeskText('sso_title', locale)}>
      <h3>{frontDeskText('sso_title', locale)}</h3>
      <p className="pane-subtitle">{frontDeskText('sso_lead', locale)}</p>
      {summary?.source === 'env' ? (
        <p className="notice">{frontDeskText('sso_env_overrides', locale)}</p>
      ) : null}
      <label>
        {frontDeskText('sso_issuer_label', locale)}
        <input
          value={issuer}
          placeholder="https://accounts.google.com"
          autoComplete="off"
          onChange={(event) => setIssuer(event.target.value)}
        />
      </label>
      <label>
        {frontDeskText('sso_client_id_label', locale)}
        <input
          value={clientId}
          autoComplete="off"
          onChange={(event) => setClientId(event.target.value)}
        />
      </label>
      <label>
        {frontDeskText('sso_client_secret_label', locale)}
        <input
          type="password"
          value={clientSecret}
          autoComplete="off"
          onChange={(event) => setClientSecret(event.target.value)}
        />
      </label>
      {summary?.client_secret_set ? (
        <p className="pane-subtitle">{frontDeskText('sso_client_secret_keep', locale)}</p>
      ) : null}
      <label>
        {frontDeskText('sso_provider_label_label', locale)}
        <input
          value={providerLabel}
          maxLength={40}
          onChange={(event) => setProviderLabel(event.target.value)}
        />
      </label>
      <label>
        {frontDeskText('sso_public_base_url_label', locale)}
        <input
          value={publicBaseUrl}
          placeholder="https://desk.example.com"
          autoComplete="off"
          onChange={(event) => setPublicBaseUrl(event.target.value)}
        />
      </label>
      {notice?.kind === 'error' ? <p className="notice error">{notice.text}</p> : null}
      {notice?.kind === 'saved' ? (
        <>
          <p className="notice">{frontDeskText('sso_saved', locale)}</p>
          {notice.envOverrides ? (
            <p className="notice">{frontDeskText('sso_env_overrides', locale)}</p>
          ) : null}
          {notice.sessionWeak ? (
            <p className="notice error">{frontDeskText('sso_session_env_weak', locale)}</p>
          ) : null}
        </>
      ) : null}
      <div className="button-row">
        <button
          className="action-button"
          disabled={busy || !issuer.trim() || !clientId.trim()}
          onClick={() => void save()}
        >
          {frontDeskText('sso_save', locale)}
        </button>
      </div>
      <p className="pane-subtitle">{frontDeskText('sso_redirect_lead', locale)}</p>
      <ul>
        {redirectUris.map((uri) => (
          <li key={uri}>
            <code>{uri}</code>
          </li>
        ))}
      </ul>
      <p className="pane-subtitle">{frontDeskText('sso_egress_hint', locale)}</p>
      <p className="pane-subtitle">{frontDeskText('sso_link_hint', locale)}</p>
    </div>
  );
}
