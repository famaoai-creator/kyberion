'use client';

import * as React from 'react';
import { createSigninRequestGuard } from '../../../lib/signin-request-guard';
import { useConciergeI18n } from '../../../lib/use-concierge-i18n';
import { frontDeskText } from '../../../lib/i18n';
import { storeFrontDeskToken } from '../../../lib/front-desk-auth-token';
import { SsoSettingsForm } from '../sso-settings-form';

/**
 * First-run setup: open only while no owner can sign in from a browser. The
 * one-time code comes from `pnpm organization first-run code` on the host and
 * arrives in the URL fragment, which never reaches the server; it is read once
 * and removed from the address bar. Claiming returns an owner token exactly
 * once, which this tab then uses like a pasted `/signin` token.
 */

type Claimed = { token: string; tenant_slug: string; member_id: string };

function codeFromHash(hash: string): string {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  return params.get('code')?.trim() ?? '';
}

export default function FirstRunSetupPage() {
  const { locale } = useConciergeI18n();
  const [state, setState] = React.useState<'loading' | 'unclaimed' | 'claimed'>('loading');
  const [code, setCode] = React.useState('');
  const [tenantSlug, setTenantSlug] = React.useState('');
  const [tenantName, setTenantName] = React.useState('');
  const [displayName, setDisplayName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const requests = React.useRef(createSigninRequestGuard());
  React.useEffect(() => () => requests.current.cancel(), []);
  const [error, setError] = React.useState<string | null>(null);
  const [tokenStored, setTokenStored] = React.useState(false);
  const [claimed, setClaimed] = React.useState<Claimed | null>(null);

  React.useEffect(() => {
    const fromHash = codeFromHash(window.location.hash);
    if (fromHash) {
      setCode(fromHash);
      window.history.replaceState(null, '', '/setup/first-run');
    }
    void (async () => {
      try {
        const response = await fetch('/api/setup/first-run', { cache: 'no-store' });
        const data = await response.json().catch(() => null);
        setState(data?.state === 'unclaimed' ? 'unclaimed' : 'claimed');
      } catch {
        setState('claimed');
      }
    })();
  }, []);

  const submit = async () => {
    const attempt = requests.current.begin();
    if (!attempt) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/setup/first-run', {
        method: 'POST',
        signal: attempt.signal,
        credentials: 'same-origin',
        mode: 'same-origin',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          tenant_slug: tenantSlug.trim(),
          ...(tenantName.trim() ? { tenant_display_name: tenantName.trim() } : {}),
          display_name: displayName.trim(),
        }),
      });
      const data = await response.json().catch(() => null);
      if (response.ok && data?.ok) {
        const saved = attempt.current() && storeFrontDeskToken(String(data.token));
        setTokenStored(saved);
        if (!saved) setError(frontDeskText('signin_storage_error', locale));
        setClaimed({
          token: String(data.token),
          tenant_slug: String(data.tenant_slug),
          member_id: String(data.member_id),
        });
        return;
      }
      if (!attempt.current()) return;
      const errorCode = typeof data?.error === 'string' ? data.error : '';
      if (errorCode === 'claimed') setState('claimed');
      else if (errorCode.startsWith('code_'))
        setError(frontDeskText('first_run_error_code', locale));
      else if (errorCode === 'invalid_input')
        setError(frontDeskText('first_run_error_input', locale));
      else setError(frontDeskText('first_run_error_generic', locale));
    } catch {
      if (attempt.current()) setError(frontDeskText('first_run_error_generic', locale));
    } finally {
      attempt.finish();
      setBusy(false);
    }
  };

  if (claimed) {
    return (
      <section className="pane" aria-label={frontDeskText('first_run_done_title', locale)}>
        <h2>{frontDeskText('first_run_done_title', locale)}</h2>
        <p className="pane-subtitle">{frontDeskText('first_run_token_lead', locale)}</p>
        <p>
          <code style={{ userSelect: 'all', wordBreak: 'break-all' }}>{claimed.token}</code>
        </p>
        {error ? (
          <p className="notice error" role="alert">
            {error}
          </p>
        ) : null}
        {tokenStored ? <SsoSettingsForm /> : null}
        <div className="button-row">
          {tokenStored ? (
            <a className="action-button" href="/">
              {frontDeskText('first_run_finish', locale)}
            </a>
          ) : (
            <button
              className="action-button"
              onClick={() => {
                const saved = storeFrontDeskToken(claimed.token);
                setTokenStored(saved);
                setError(saved ? null : frontDeskText('signin_storage_error', locale));
              }}
            >
              {frontDeskText('signin_submit', locale)}
            </button>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="pane" aria-label={frontDeskText('first_run_title', locale)}>
      <h2>{frontDeskText('first_run_title', locale)}</h2>
      {state === 'claimed' ? (
        <>
          <p className="notice">{frontDeskText('first_run_claimed', locale)}</p>
          <div className="button-row">
            <a className="action-button" href="/login">
              {frontDeskText('first_run_signin_link', locale)}
            </a>
          </div>
        </>
      ) : state === 'unclaimed' ? (
        <>
          <p className="pane-subtitle">{frontDeskText('first_run_lead', locale)}</p>
          <label>
            {frontDeskText('first_run_code_label', locale)}
            <input
              value={code}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          <p className="pane-subtitle">{frontDeskText('first_run_code_hint', locale)}</p>
          <label>
            {frontDeskText('first_run_tenant_slug_label', locale)}
            <input
              value={tenantSlug}
              maxLength={31}
              pattern="[a-z][a-z0-9-]{1,30}"
              autoComplete="off"
              onChange={(event) => setTenantSlug(event.target.value.toLowerCase())}
            />
          </label>
          <label>
            {frontDeskText('first_run_tenant_name_label', locale)}
            <input
              value={tenantName}
              maxLength={80}
              onChange={(event) => setTenantName(event.target.value)}
            />
          </label>
          <label>
            {frontDeskText('first_run_display_name_label', locale)}
            <input
              value={displayName}
              maxLength={80}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
          {error ? <p className="notice error">{error}</p> : null}
          <div className="button-row">
            <button
              className="action-button"
              disabled={busy || !code.trim() || !tenantSlug.trim() || !displayName.trim()}
              onClick={() => void submit()}
            >
              {frontDeskText('first_run_submit', locale)}
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
