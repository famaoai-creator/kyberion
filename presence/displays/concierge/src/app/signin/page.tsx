'use client';

import * as React from 'react';
import { createSigninRequestGuard } from '../../lib/signin-request-guard';
import { useConciergeI18n } from '../../lib/use-concierge-i18n';
import { frontDeskText } from '../../lib/i18n';
import {
  clearFrontDeskToken,
  getStoredFrontDeskToken,
  storeFrontDeskToken,
} from '../../lib/front-desk-auth-token';
import { sanitizeNextPath } from '@agent/core/surface/surface-session-cookie';

function readNextPath(): string {
  const next = sanitizeNextPath(new URLSearchParams(window.location.search).get('next'));
  try {
    const pathname = decodeURIComponent(new URL(next, window.location.origin).pathname).replace(
      /\/+$/,
      ''
    );
    return pathname === '/signin' ? '/' : next;
  } catch {
    return '/';
  }
}

/**
 * An explicit sign-in is required after a rejected bearer, including on loopback.
 * Tokens stay in this tab's sessionStorage and are only sent to member APIs.
 * Loading this page never discards an existing credential.
 */
export default function SignInPage() {
  const { locale } = useConciergeI18n();
  const [token, setToken] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const requests = React.useRef(createSigninRequestGuard());
  React.useEffect(() => () => requests.current.cancel(), []);
  const [error, setError] = React.useState<'token' | 'storage' | null>(null);
  const [nextPath, setNextPath] = React.useState('/');
  React.useEffect(() => {
    setNextPath(readNextPath());
  }, []);

  const submit = React.useCallback(async () => {
    const trimmed = token.trim();
    if (!trimmed) return;
    const attempt = requests.current.begin();
    if (!attempt) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/me', {
        headers: { Authorization: `Bearer ${trimmed}` },
        cache: 'no-store',
        signal: attempt.signal,
        credentials: 'same-origin',
        mode: 'same-origin',
        redirect: 'error',
      });
      const parsed = await response.json().catch(() => null);
      if (!attempt.current()) return;
      if (!response.ok || !parsed?.ok) throw new Error('invalid token');
      if (!storeFrontDeskToken(trimmed) || getStoredFrontDeskToken() !== trimmed) {
        setError('storage');
        return;
      }
      window.location.assign(readNextPath());
    } catch {
      if (attempt.current()) setError('token');
    } finally {
      attempt.finish();
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
          disabled={busy}
          value={token}
          onChange={(event) => setToken(event.target.value)}
          autoComplete="off"
        />
      </label>
      {error ? (
        <p className="notice error" role="alert">
          {frontDeskText(error === 'storage' ? 'signin_storage_error' : 'signin_error', locale)}
        </p>
      ) : null}
      <div className="button-row">
        <button
          className="action-button"
          disabled={busy || !token.trim()}
          onClick={() => void submit()}
        >
          {frontDeskText('signin_submit', locale)}
        </button>
      </div>
      <p className="pane-subtitle">
        <a
          href={nextPath === '/' ? '/login' : `/login?next=${encodeURIComponent(nextPath)}`}
          onClick={(event) => {
            if (busy) {
              event.preventDefault();
              return;
            }
            if (!clearFrontDeskToken()) {
              event.preventDefault();
              setError('storage');
            }
          }}
        >
          {frontDeskText('signin_sso_link', locale)}
        </a>
      </p>
    </section>
  );
}
