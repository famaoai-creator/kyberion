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
import {
  isSurfaceAuthPath,
  sanitizeNextPath,
  trimTrailingSlashes,
} from '@agent/core/surface/surface-session-cookie';

function readNextPath(): string {
  const next = sanitizeNextPath(new URLSearchParams(window.location.search).get('next'));
  try {
    const target = new URL(next, window.location.origin);
    // Validate the browser's normalized URL, not only the original string.
    if (target.origin !== window.location.origin || target.username || target.password) return '/';
    const pathname = trimTrailingSlashes(decodeURIComponent(target.pathname));
    // Encoded path separators/control bytes and nested escapes have no place in a return path.
    if (/%(?:2f|5c|25|0[0-9a-f]|1[0-9a-f]|7f)/i.test(target.pathname)) return '/';
    if (target.pathname.startsWith('//') || pathname === '/signin' || isSurfaceAuthPath(pathname))
      return '/';
    return target.pathname + target.search + target.hash;
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
      const target = new URL(readNextPath(), window.location.origin);
      // Keep the origin check at the navigation sink; never reinterpret a // pathname as a host.
      if (target.origin === window.location.origin) window.location.assign(target.href);
      else window.location.assign('/');
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
